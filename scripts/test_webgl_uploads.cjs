// Asset-free browser tests for native client-memory upload lifetimes.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const puppeteer = require(process.env.PUPPETEER_MODULE || "puppeteer-core");

async function main() {
  const engine = process.argv[2] || "chromium";
  assert(["chromium", "firefox"].includes(engine));
  const output = process.env.SSX3_WEBGL_ARTIFACT_DIR ||
    fs.mkdtempSync(path.join(os.tmpdir(), "ssx3-webgl-uploads-"));
  fs.mkdirSync(output, { recursive: true });
  const root = path.join(__dirname, "../tests/webgl_uploads");
  // Serve only the four synthetic fixture files, with shared-memory isolation.
  // No game, state, browser profile or other workspace files are reachable.
  const files = new Map();
  for (const name of ["texture.html", "texture.js", "buffer.html", "buffer.js"])
    files.set("/" + name, fs.readFileSync(path.join(root, name)));
  const sources = Object.fromEntries([...files].map(([name, bytes]) =>
    [name.slice(1), crypto.createHash("sha256").update(bytes).digest("hex")]));
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const bytes = files.get(pathname);
    response.writeHead(bytes ? 200 : 404, {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cache-Control": "no-store",
      "Content-Type": pathname.endsWith(".js")
        ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
    });
    response.end(bytes || "Not found");
  });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    browser = await puppeteer.launch({
      ...(engine === "firefox" ? { browser: "firefox" } : {}),
      executablePath: engine === "firefox"
        ? process.env.SSX3_FIREFOX_BIN || "/usr/bin/firefox"
        : process.env.SSX3_CHROMIUM_BIN || "/usr/bin/chromium",
      headless: process.env.SSX3_WEBGL_HEADLESS === "1",
      defaultViewport: { width: 1024, height: 768 },
    });
    for (const [fixture, cases, totalBytes] of [
      ["texture", 480, 58169856], ["buffer", 576, 68115840],
    ]) {
      const page = await browser.newPage(), errors = [], warnings = [];
      try {
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => {
          if (["warn", "warning", "error"].includes(message.type()))
            warnings.push(message.text());
        });
        await page.goto(`http://127.0.0.1:${server.address().port}/${fixture}.html`,
          { waitUntil: "load" });
        await page.waitForFunction(() => globalThis.uploadResult,
          { timeout: 120000 });
        const result = await page.evaluate(() => uploadResult);
        fs.writeFileSync(path.join(output, `${engine}-${fixture}-uploads.json`),
          JSON.stringify({ engine, version: await browser.version(), fixture,
            sources, explicitGpuOverrides: false, result, errors, warnings }, null, 2) + "\n");
        assert.deepEqual(errors, []);
        assert.deepEqual(warnings, []);
        assert.equal(result.passed, true, JSON.stringify(result));
        assert.equal(result.cases, cases);
        assert.equal(result.totalBytes, totalBytes);
        assert.equal(result.negativeDetected, true);
        assert.equal(result.glError, 0);
        assert.deepEqual(result.failures, []);
        console.log(`${engine}: ${cases} ${fixture} upload cases passed`);
      } finally { await page.close(); }
    }
    console.log(`Evidence: ${output}`);
  } finally {
    try { if (browser) await browser.close(); }
    finally { await new Promise(resolve => server.close(resolve)); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
