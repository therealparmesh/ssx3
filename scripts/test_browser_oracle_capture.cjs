// Asset-free regression for replay runs with more than one JSON message's worth
// of full-resolution failures. Uses the same transport and disk writer as QA.
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const http = require("node:http"),
  assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const puppeteer = require(process.env.PUPPETEER_MODULE || "puppeteer-core");
const { installOracleCapture } = require("./browser_oracle_capture.cjs");
const engine = process.argv[2] || "firefox";
assert(["chrome", "firefox"].includes(engine));
const output =
  process.env.SSX3_TEST_OUTPUT ||
  fs.mkdtempSync(path.join(os.tmpdir(), "ssx3-oracle-capture-"));
const captures = path.join(output, "captures");
fs.mkdirSync(captures, { recursive: true });
const width = 512,
  height = 448,
  count = 600;
const bytes = Buffer.alloc(width * height * 4);
for (let i = 0; i < bytes.length; i++) bytes[i] = i & 255;
const sha256 = createHash("sha256").update(bytes).digest("hex");
const expectedSha256 = "0".repeat(64);
let browser, server, capture;
(async () => {
  server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<!doctype html><title>Oracle capture transport</title>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await puppeteer.launch({
    ...(engine === "firefox" ? { browser: "firefox" } : {}),
    executablePath:
      engine === "firefox"
        ? process.env.SSX3_FIREFOX_BIN || "/usr/bin/firefox"
        : process.env.SSX3_CHROMIUM_BIN || "/usr/bin/chromium",
    headless: process.env.SSX3_WEBGL_HEADLESS === "1",
  });
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  capture = await installOracleCapture(page, captures);
  await page.goto("http://127.0.0.1:" + server.address().port);
  const saved = await page.evaluate(
    async ({ width, height, count, sha256, expectedSha256 }) => {
      const bytes = new Uint8Array(width * height * 4);
      for (let i = 0; i < bytes.length; i++) bytes[i] = i & 255;
      const records = [];
      for (let imageSequence = 1; imageSequence <= count; imageSequence++) {
        const record = await ssx3SaveOracleMismatch(
          { imageSequence, nativeFrame: imageSequence, width, height, sha256 },
          expectedSha256,
          bytes,
        );
        if ("base64" in record)
          throw Error("Capture payload leaked into final metadata");
        records.push(record);
      }
      return JSON.stringify(records);
    },
    { width, height, count, sha256, expectedSha256 },
  );
  assert(saved.length < 256 * 1024, "Replay result must contain metadata only");
  const records = JSON.parse(saved);
  assert.equal(records.length, count);
  async function attempt(record) {
    return page.evaluate(
      async ({ record, width, height, expectedSha256 }) => {
        const bytes = new Uint8Array(width * height * 4);
        for (let i = 0; i < bytes.length; i++) bytes[i] = i & 255;
        try {
          return {
            saved: await ssx3SaveOracleMismatch(record, expectedSha256, bytes),
          };
        } catch (error) {
          return { error: error.message };
        }
      },
      { record, width, height, expectedSha256 },
    );
  }
  const next = {
    imageSequence: count + 1,
    nativeFrame: count + 1,
    width,
    height,
    sha256,
  };
  assert.match(
    (await attempt({ ...next, width: 1 })).error,
    /Incomplete mismatch capture/,
  );
  assert.match(
    (await attempt({ ...next, sha256: "1".repeat(64) })).error,
    /capture hash differs/,
  );
  assert.match(
    (await attempt({ ...next, imageSequence: 1 })).error,
    /Duplicate mismatch/,
  );
  const blocked = path.join(
    captures,
    "image-" + next.imageSequence + "-mismatch.rgba",
  );
  fs.mkdirSync(blocked);
  assert.match((await attempt(next)).error, /EISDIR/);
  fs.rmdirSync(blocked);
  const retried = await attempt(next);
  assert(!retried.error, retried.error);
  records.push(retried.saved);
  await capture.drain();
  for (const record of records) {
    assert.equal(
      record.file,
      "image-" + record.imageSequence + "-mismatch.rgba",
    );
    const actual = fs.readFileSync(path.join(captures, record.file));
    assert.equal(actual.length, bytes.length);
    assert.equal(createHash("sha256").update(actual).digest("hex"), sha256);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(capture.stats(), {
    images: count + 1,
    bytesWritten: bytes.length * (count + 1),
  });
  assert(
    bytes.length * count > 512 * 1024 * 1024,
    "Exercise aggregate payload above the old string limit",
  );
  const result = {
    passed: true,
    browser: await browser.version(),
    images: count + 1,
    verifiedBytes: bytes.length * (count + 1),
    aggregateBase64Bytes: Math.ceil(bytes.length / 3) * 4 * count,
    finalMetadataBytes: saved.length,
    negativeChecks: 4,
    failedWriteRetried: true,
    pageErrors: errors,
    scope:
      "Synthetic pixels only. Every full-resolution file rehashed. Success removes generated pixels; failures retain them. No game assets or performance qualification.",
  };
  fs.rmSync(captures, { recursive: true });
  fs.writeFileSync(
    path.join(output, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
})()
  .catch((error) => {
    fs.writeFileSync(
      path.join(output, "failure.json"),
      JSON.stringify({ error: error.stack }, null, 2) + "\n",
    );
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (capture) await capture.drain();
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });
