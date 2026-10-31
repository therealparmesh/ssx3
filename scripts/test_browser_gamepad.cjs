const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict"),
  p = require(process.env.PUPPETEER_MODULE || "puppeteer-core");
const kind = process.argv[2] || "firefox";
assert(["chrome", "firefox"].includes(kind));
const backend = process.env.SSX3_TEST_BACKEND || "webgpu";
assert(["webgpu", "webgl"].includes(backend));
const out =
  process.env.SSX3_TEST_OUTPUT ||
  fs.mkdtempSync(path.join(os.tmpdir(), "ssx3-gamepad-"));
fs.mkdirSync(out, { recursive: true });
const url = process.env.SSX3_TEST_URL || "http://127.0.0.1:8681/";
let browser, page, nativeGamepad;
const errors = [],
  warnings = [],
  checks = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  browser = await p.launch(
    kind === "firefox"
      ? {
          browser: "firefox",
          executablePath: process.env.FIREFOX_EXECUTABLE || "/usr/bin/firefox",
          headless: false,
          extraPrefsFirefox: backend === "webgpu" ? { "dom.webgpu.enabled": true } : {},
          defaultViewport: { width: 1280, height: 800 },
        }
      : {
          executablePath:
            process.env.CHROMIUM_EXECUTABLE || "/usr/bin/chromium",
          headless: false,
          args: backend === "webgpu" ? ["--enable-unsafe-webgpu", "--enable-features=Vulkan"] : [],
          defaultViewport: { width: 1280, height: 800 },
        },
  );
  page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
    if (m.type() === "warn") warnings.push(m.text());
  });
  if (backend === "webgl") await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
  });
  if (process.env.SSX3_TEST_DENY_GAMEPAD === "1") {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "getGamepads", {
        configurable: true,
        value() {
          throw new DOMException(
            "Controlled Gamepad API denial",
            "SecurityError",
          );
        },
      });
    });
  }
  const observer = fs.readFileSync(
    path.join(__dirname, "../tests/browser_gamepad/worker_observer.js"),
    "utf8",
  );
  await page.evaluateOnNewDocument((code) => {
    const Native = Worker;
    window.Worker = class extends Native {
      constructor(url, options) {
        let actual = url;
        if (String(url).includes("game-runtime-worker.js")) {
          const base = new URL(".", url).href;
          actual = URL.createObjectURL(
            new Blob(["const QA_BASE=" + JSON.stringify(base) + ";\n" + code], {
              type: "application/javascript",
            }),
          );
        }
        super(actual, options);
        if (String(url).includes("game-runtime-worker.js"))
          window.qaRuntimeWorker = this;
      }
    };
  }, observer);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  // Check the browser before installing synthetic pads. Replacing this API
  // first would hide a permissions-policy or secure-context failure.
  nativeGamepad = await page.evaluate(() => {
    const result = {
      secure: isSecureContext,
      available: typeof navigator.getGamepads === "function",
    };
    try {
      result.slots = navigator.getGamepads().length;
      result.callSucceeded = true;
    } catch (error) {
      result.callSucceeded = false;
      result.error = error.name;
    }
    return result;
  });
  assert.equal(
    nativeGamepad.secure,
    true,
    "Gamepad testing requires a secure context",
  );
  assert.equal(
    nativeGamepad.available,
    true,
    "Native browser Gamepad API is missing",
  );
  assert.equal(
    nativeGamepad.callSucceeded,
    true,
    "Native browser Gamepad API access failed",
  );
  await page.waitForFunction(
    () =>
      window.Module &&
      (Module.failed ||
        document.getElementById("start").textContent === "Play SSX 3"),
    { timeout: 120000 },
  );
  assert.equal(await page.evaluate(() => !!Module.failed), false);
  assert.equal(await page.title(), "SSX 3");
  if (backend === "webgl") assert(await page.evaluate(() =>
    webglBackend && navigator.gpu === undefined && !Module.workerRuntime));
  await page.bringToFront();
  const query = async (label) => {
    const result = await page.evaluate(
      () => {
        // The WebGL runtime currently owns the window. Observe its real native
        // exports with the same post-call state and assertions as the worker.
        if (!window.qaRuntimeWorker) {
          if (!webglBackend || Module.workerRuntime)
            throw Error("Expected the WebGPU worker or explicit window-owned WebGL runtime");
          if (!window.qaDirectInput) {
            const input = window.qaDirectInput = { events: [], pads: {}, connected: {}, pressure: {}, resumes: [] };
            for (const [name, kind] of [["_ps2web_pad", "pads"], ["_ps2web_pad_connected", "connected"], ["_ps2web_pressure", "pressure"], ["_ps2web_pause", "pause"]]) {
              const native = Module[name];
              Module[name] = function (...args) {
                const value = native.apply(this, args);
                if (kind === "pause") {
                  if (!args[0]) input.resumes.push(JSON.parse(JSON.stringify({pads: input.pads, connected: input.connected, pressure: input.pressure})));
                } else input[kind][args[0]] = args.slice(1);
                if (input.events.length < 500) input.events.push({name, args, frame: Module._ps2web_frames()});
                return value;
              };
            }
          }
          return {...qaDirectInput, frame: Module._ps2web_frames(), paused: Module.paused, failed: Module.failed};
        }
        return new Promise((resolve, reject) => {
          const id = crypto.randomUUID(),
            w = qaRuntimeWorker;
          const timer = setTimeout(() => {
            w.removeEventListener("message", reply);
            reject(Error("Input observer timed out"));
          }, 10000);
          function reply(e) {
            if (e.data?.qaInputReply !== id) return;
            clearTimeout(timer);
            w.removeEventListener("message", reply);
            e.data.error ? reject(Error(e.data.error)) : resolve(e.data.result);
          }
          w.addEventListener("message", reply);
          w.postMessage({ qaInput: true, id });
        });
      },
    );
    assert(!result.failed);
    if (label) {
      checks.push({ label, ...result });
      console.log("CHECK", label);
    }
    return result;
  };
  await query();
  await page.click("#start");
  await page.waitForFunction(
    () => Module.failed || Module._ps2web_frames() > 2500,
    { timeout: 120000 },
  );
  assert(!(await page.evaluate(() => Module.failed)));
  if (backend === "webgl") assert.equal(await page.evaluate(() => Module.ps2GpuBackend), "webgl");
  await page.click("#canvas");
  let v = await query("running");
  assert.deepEqual(v.connected["0"], [1]);
  await page.keyboard.down("w");
  await page.keyboard.down("ArrowLeft");
  await page.keyboard.down(" ");
  v = await query("keyboard-independent-stick-dpad");
  assert.deepEqual(v.pads["0"], [0x4080, 128, 0, 128, 128]);
  await page.keyboard.up(" ");
  await page.keyboard.up("ArrowLeft");
  await page.keyboard.up("w");
  await page.evaluate(() => {
    window.qaPads = [];
    window.qaMakePad = (index) => ({
      index,
      id: "QA standard controller",
      mapping: "standard",
      connected: true,
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({
        pressed: false,
        touched: false,
        value: 0,
      })),
    });
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => qaPads,
    });
    qaPads = [qaMakePad(3), qaMakePad(7)];
    pollInput();
  });
  const bits = [14, 13, 15, 12, 10, 11, 8, 9, 0, 3, 1, 2, 4, 6, 7, 5];
  for (let i = 0; i < bits.length; i++) {
    await page.evaluate((i) => {
      for (const b of qaPads[0].buttons)
        ((b.pressed = b.touched = false), (b.value = 0));
      const b = qaPads[0].buttons[i];
      b.pressed = b.touched = true;
      b.value = 1;
      pollInput();
    }, i);
    await delay(i === 9 ? 250 : 40);
    v = await query("standard-button-" + i);
    assert.deepEqual(v.pads["0"], [1 << bits[i], 128, 128, 128, 128]);
  }
  await page.evaluate(() => {
    for (const b of qaPads[0].buttons)
      ((b.pressed = b.touched = false), (b.value = 0));
    qaPads[0].buttons[0] = { pressed: true, touched: true, value: 1 };
    qaPads[0].buttons[6] = { pressed: true, touched: true, value: 0.6 };
    qaPads[0].axes = [-1, 1, 0.5, -0.5];
    qaPads[1].buttons[1] = { pressed: true, touched: true, value: 1 };
    pollInput();
  });
  v = await query("two-controllers-axes-pressure");
  assert.deepEqual(v.pads["0"], [0x4100, 0, 255, 191, 64]);
  assert.deepEqual(v.pads["1"], [0x2000, 128, 128, 128, 128]);
  assert.deepEqual(v.connected["1"], [1]);
  assert.equal((v.pressure["0"][2] >>> 0) & 255, 153);
  await page.evaluate(() => {
    qaFirst = qaPads[0];
    qaPads = [null, qaPads[1]];
    pollInput();
  });
  v = await query("disconnect-keeps-other-port");
  assert.deepEqual(v.pads["0"], [0, 128, 128, 128, 128]);
  assert.equal(v.pads["1"][0], 0x2000);
  await page.evaluate(() => {
    qaFirst.index = 11;
    qaPads = [qaPads[1], null, qaFirst];
    pollInput();
  });
  v = await query("reconnect-and-reorder");
  assert.equal(v.pads["0"][0], 0x4100);
  assert.equal(v.pads["1"][0], 0x2000);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => {
        throw new DOMException("QA restriction", "SecurityError");
      },
    });
    pollInput();
  });
  v = await query("api-denial-neutralizes");
  assert.deepEqual(v.pads["0"], [0, 128, 128, 128, 128]);
  assert.deepEqual(v.connected["1"], [0]);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => qaPads,
    });
    pollInput();
  });
  v = await query("api-recovery");
  assert.equal(v.pads["0"][0], 0x4100);
  assert.equal(v.pads["1"][0], 0x2000);
  const other = await browser.newPage();
  await other.goto("about:blank");
  await other.bringToFront();
  await page.waitForFunction(
    () => document.hidden && Module.paused && Module._ps2web_pause_ready(),
    { timeout: 15000 },
  );
  v = await query("hidden-tab-guest-stopped");
  const hiddenFrame = v.frame;
  await delay(200);
  assert.equal((await query()).frame, hiddenFrame);
  await page.bringToFront();
  await page.waitForFunction(() => !document.hidden, { timeout: 10000 });
  // Hidden documents can defer RAF callbacks. The guest must stay stopped;
  // let the production input poll retire the pending release after focus.
  const deadline = Date.now() + 5000;
  for (;;) {
    v = await query();
    if (v.pads["0"]?.[0] === 0 && v.pads["1"]?.[0] === 0) break;
    assert(
      Date.now() < deadline,
      "Pending input release did not settle after focus",
    );
    await delay(20);
  }
  v = await query("foreground-paused-input-neutral");
  assert.deepEqual(v.pads["0"], [0, 128, 128, 128, 128]);
  assert.deepEqual(v.pads["1"], [0, 128, 128, 128, 128]);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !Module.paused, { timeout: 15000 });
  v = await query("resume-held-input-before-native-unpause");
  const resumed = v.resumes.at(-1);
  assert(resumed);
  assert.equal(resumed.pads["0"][0], 0x4100);
  assert.equal(resumed.pads["1"][0], 0x2000);
  assert.equal((resumed.pressure["0"][2] >>> 0) & 255, 153);
  await other.close();
  await page.evaluate(() => {
    qaPads = [];
    pollInput();
  });
  v = await query("all-disconnected-neutral");
  assert.deepEqual(v.pads["0"], [0, 128, 128, 128, 128]);
  assert.deepEqual(v.connected["1"], [0]);
  const f = v.frame;
  await delay(1000);
  assert((await query()).frame > f);
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => Module.paused && Module._ps2web_pause_ready(),
    { timeout: 15000 },
  );
  await page.screenshot({ path: out + "/paused.png" });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  fs.writeFileSync(
    out + "/result.json",
    JSON.stringify(
      {
        passed: true,
        browser: kind,
        backend,
        nativeGamepad,
        checks,
        errors,
        warnings,
        flags:
          backend === "webgl" ? [] : kind === "firefox"
            ? ["dom.webgpu.enabled=true"]
            : ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
        scope:
          backend === "webgl"
            ? "Window-owned WebGL build with WebGPU withheld. Standard GamepadAPI snapshots traverse production polling and real native exports. Simulated controllers; no hardware or performance claim."
            : "Worker WebGPU build supplied at the test URL. Standard GamepadAPI snapshots traverse the production window/client and real native worker exports. No physical-phone test required; no performance claim from this instrumented diagnostic.",
      },
      null,
      2,
    ),
  );
  console.log("PASS", kind, checks.length, "native controller checks");
})()
  .catch((e) => {
    console.error(e);
    fs.writeFileSync(
      out + "/failure.json",
      JSON.stringify(
        { error: e.message, nativeGamepad, checks, errors, warnings },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) await browser.close();
  });
