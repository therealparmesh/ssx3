// Asset-free mip selection, spatial filtering and ordered/opaque bridge checks.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const puppeteer = require("puppeteer-core");

async function main() {
  const kind = process.argv[2] || "chromium";
  assert(["chromium", "firefox"].includes(kind));
  const origin = new URL(
    process.env.SSX3_WEBGL_ORIGIN || "http://127.0.0.1:8262/",
  );
  const output =
    process.env.SSX3_WEBGL_ARTIFACT_DIR ||
    fs.mkdtempSync(path.join(os.tmpdir(), "ssx3-mips-"));
  fs.mkdirSync(output, { recursive: true });
  const browser = await puppeteer.launch({
    ...(kind === "firefox" ? { browser: "firefox" } : {}),
    executablePath:
      kind === "firefox"
        ? process.env.SSX3_FIREFOX_BIN || "/usr/bin/firefox"
        : process.env.SSX3_CHROMIUM_BIN || "/usr/bin/chromium",
    headless: process.env.SSX3_WEBGL_HEADLESS === "1",
    defaultViewport: { width: 1024, height: 768 },
  });
  try {
    for (const mode of ["sampler", "level-zero-control", "bridge"]) {
      const page = await browser.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      const url = new URL(
        mode === "bridge" ? "mips/bridge.html" : "mips/",
        origin,
      );
      if (mode === "level-zero-control") url.searchParams.set("levelZero", "1");
      await page.goto(url.href, { waitUntil: "load" });
      await page.waitForFunction(
        () => window.mipResult || window.mipBridgeResult,
        { timeout: 120000 },
      );
      const result = await page.evaluate(() => ({
        result: window.mipResult || window.mipBridgeResult,
        title: document.title,
        url: location.href,
        log: document.getElementById("log").textContent,
      }));
      fs.writeFileSync(
        path.join(output, `${kind}-${mode}.json`),
        JSON.stringify({ ...result, errors }, null, 2),
      );
      await page.screenshot({ path: path.join(output, `${kind}-${mode}.png`) });
      assert.equal(
        result.title,
        mode === "bridge"
          ? "GS mip bridge verification"
          : "GS mip sampling verification",
      );
      assert.deepEqual(errors, []);
      if (mode === "level-zero-control") {
        assert.equal(result.result.passed, false);
        assert.match(result.result.error, /Mip mismatch/);
      } else {
        assert.equal(result.result.passed, true, result.result.error);
        assert.equal(result.result.cases, mode === "bridge" ? 1920 : 13680);
        assert.equal(
          result.result.hash,
          mode === "bridge" ? 2611237925 : 2510624830,
        );
        assert.equal(result.result.glError, 0);
      }
      console.log("PASS", kind, mode, JSON.stringify(result.result));
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
