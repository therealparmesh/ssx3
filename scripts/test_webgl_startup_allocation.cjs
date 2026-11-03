const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const puppeteer = require("puppeteer-core");

const engine = process.argv[2] || "chromium";
assert(["chromium", "firefox"].includes(engine));
const output =
  process.env.SSX3_WEBGL_ARTIFACT_DIR ||
  fs.mkdtempSync(path.join(os.tmpdir(), "ssx3-startup-allocation-"));
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await puppeteer.launch({
    ...(engine === "firefox" ? { browser: "firefox" } : {}),
    executablePath:
      engine === "firefox"
        ? process.env.SSX3_FIREFOX_BIN || "/usr/bin/firefox"
        : process.env.SSX3_CHROMIUM_BIN || "/usr/bin/chromium",
    headless: process.env.SSX3_WEBGL_HEADLESS === "1",
    defaultViewport: { width: 1024, height: 768 },
  });
  try {
    const page = await browser.newPage(),
      errors = [],
      warnings = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["warn", "warning", "error"].includes(message.type()))
        warnings.push(message.text());
    });
    const url = new URL(
      "startup-allocation.html",
      process.env.SSX3_WEBGL_ORIGIN || "http://127.0.0.1:8262/",
    );
    await page.goto(url.href);
    await page.waitForFunction(() => window.retryResult, { timeout: 120000 });
    const result = await page.evaluate(() => retryResult);
    await page.screenshot({ path: path.join(output, engine + ".png") });
    fs.writeFileSync(
      path.join(output, engine + ".json"),
      JSON.stringify(
        {
          browser: await browser.version(),
          url: url.href,
          explicitGpuOverrides: false,
          result,
          errors,
          warnings,
        },
        null,
        2,
      ) + "\n",
    );
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(result.cases, 8);
    assert.equal(result.pixels, 2048);
    assert.equal(result.glError, 0);
    assert(
      result.results.every(
        (item) =>
          item.retried &&
          item.hostUnchanged &&
          item.cleanup &&
          item.noDrawTimeCompile,
      ),
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    console.log(`${engine}: 8 startup failure/retry cases passed`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
