const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const puppeteer = require("puppeteer-core");

async function main() {
  const engine = process.argv[2] || "chromium";
  const bridge = process.argv[3] === "bridge";
  assert(
    ["chromium", "firefox"].includes(engine),
    "Choose chromium or firefox",
  );
  const origin = new URL(
    process.env.SSX3_WEBGL_ORIGIN || "http://127.0.0.1:8262/",
  );
  const output =
    process.env.SSX3_WEBGL_ARTIFACT_DIR ||
    fs.mkdtempSync(path.join(os.tmpdir(), "ssx3-webgl-"));
  fs.mkdirSync(output, { recursive: true });
  const firefox = engine === "firefox";
  const executablePath = firefox
    ? process.env.SSX3_FIREFOX_BIN || "/usr/bin/firefox"
    : process.env.SSX3_CHROMIUM_BIN || "/usr/bin/chromium";
  const browser = await puppeteer.launch({
    ...(firefox ? { browser: "firefox" } : {}),
    executablePath,
    headless: process.env.SSX3_WEBGL_HEADLESS === "1",
    defaultViewport: { width: 800, height: 600 },
  });
  try {
    const modes = ["positive", "negative-depth", "negative-order"];
    if (bridge) modes.push("allocation");
    for (const mode of modes) {
      const page = await browser.newPage();
      const errors = [];
      const logs = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (["warn", "warning", "error"].includes(message.type()))
          logs.push(message.text());
      });
      await page.evaluateOnNewDocument(() => {
        addEventListener("error", (event) => {
          window.kernelEarlyError = {
            error: event.message,
            stack: event.error?.stack || "",
          };
        });
      });
      const url = mode === "allocation"
        ? new URL("allocation.html", origin)
        : new URL(origin);
      if (bridge) url.searchParams.set("bridge", "1");
      if (mode === "negative-depth") url.searchParams.set("negative", "1");
      if (mode === "negative-order") url.searchParams.set("reverse", "1");
      await page.goto(url.href, { waitUntil: "load" });
      await page.waitForFunction(
        () => window.kernelResult || window.allocationResult || window.kernelEarlyError,
        { timeout: 60000 },
      );
      const result = await page.evaluate(
        () => window.kernelResult || window.allocationResult || window.kernelEarlyError,
      );
      const evidence = {
        url: url.href,
        engine,
        mode,
        version: await browser.version(),
        explicitGpuOverrides: false,
        result,
        errors,
        logs,
      };
      fs.writeFileSync(
        path.join(output, `${engine}-${bridge ? "bridge-" : ""}${mode}.json`),
        JSON.stringify(evidence, null, 2) + "\n",
      );
      assert.equal(errors.length, 0, "No uncaught browser errors");
      if (mode === "allocation") {
        assert.equal(result.passed, true, JSON.stringify(result));
        assert.equal(result.results.length, 20);
        assert(result.results.every(item => item.passed));
        // Deliberately invalid storage calls can emit driver warnings; retain
        // them in the evidence. All GL errors must be reported and consumed.
        assert(logs.every(message =>
          /INVALID_ENUM.*bindTexture.*invalid target|INVALID_VALUE.*texStorage.*width < 0/i.test(message)),
          "Only deliberately injected driver warnings are expected");
        console.log(`${engine}: 20 allocation failure/retry cases passed`);
      } else if (mode === "positive") {
        assert(!result.error, result.error);
        assert.equal(
          result.passed,
          bridge ? 1094 : 1126,
          "Run the complete fixture matrix",
        );
        assert.equal(logs.length, 0, "No browser or graphics warnings");
        assert(
          result.cases.every(
            (item) =>
              item.colorMismatches === 0 &&
              item.depthMismatches === 0 &&
              item.glError === 0,
          ),
        );
        console.log(
          `${engine}: ${result.passed} exact color/depth cases passed`,
        );
      } else {
        assert(result.error, "The intentional fault must be detected");
        const mismatch = JSON.parse(result.error);
        assert(mismatch.depthMismatches > 0 || mismatch.colorMismatches > 0);
        assert.equal(
          mismatch.glError,
          0,
          "Detect incorrect pixels, not a failed GPU operation",
        );
        console.log(`${engine}: ${mode} detected`);
      }
      await page.close();
    }
    console.log(`Evidence: ${output}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
