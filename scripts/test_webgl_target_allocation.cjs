const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const puppeteer = require(process.env.PUPPETEER_MODULE || "puppeteer-core");

async function main() {
  const engine = process.argv[2] || "chromium";
  assert(["chromium", "firefox"].includes(engine));
  const origin = process.env.SSX3_WEBGL_ORIGIN || "http://127.0.0.1:8262/";
  const output = process.env.SSX3_WEBGL_ARTIFACT_DIR ||
    fs.mkdtempSync(path.join(os.tmpdir(), "ssx3-target-allocation-"));
  fs.mkdirSync(output, { recursive: true });
  const browser = await puppeteer.launch({
    ...(engine === "firefox" ? { browser: "firefox" } : {}),
    executablePath: engine === "firefox"
      ? process.env.SSX3_FIREFOX_BIN || "/usr/bin/firefox"
      : process.env.SSX3_CHROMIUM_BIN || "/usr/bin/chromium",
    headless: process.env.SSX3_WEBGL_HEADLESS === "1",
    defaultViewport: { width: 800, height: 600 },
  });
  try {
    const page = await browser.newPage();
    const errors = [], warnings = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      if (["warn", "warning", "error"].includes(message.type()))
        warnings.push(message.text());
    });
    const url = new URL("target-allocation.html", origin).href;
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(() => globalThis.targetAllocationResult,
      { timeout: 120000 });
    const result = await page.evaluate(() => targetAllocationResult);
    const evidence = { engine, version: await browser.version(), url,
      explicitGpuOverrides: false, result, errors, warnings };
    fs.writeFileSync(path.join(output, engine + "-target-allocation.json"),
      JSON.stringify(evidence, null, 2) + "\n");
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    assert.equal(result.results.length, 39);
    const faults = [
      ...Array.from({ length: 6 }, (_, i) => ["texture", i + 1]),
      ...Array.from({ length: 4 }, (_, i) => ["framebuffer", i + 1]),
      ["attachment", 1], ["attachment", 4], ["incomplete", 2],
    ];
    assert.deepEqual(result.results.map(({ scenario, fault, at }) =>
      [scenario, fault, at]), ["first", "resize", "full-cache"].flatMap(
      scenario => faults.map(([fault, at]) => [scenario, fault, at])));
    assert.equal(result.passed, true, JSON.stringify(result));
    assert(result.results.every(item => item.passed && item.reported));
    console.log(`${engine}: 39 target-allocation recovery cases passed`);
    console.log(`Evidence: ${output}`);
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
