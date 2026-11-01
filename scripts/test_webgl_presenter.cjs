const fs = require("node:fs"),
  assert = require("node:assert/strict"),
  p = require(process.env.PUPPETEER_MODULE || "puppeteer-core");
const kind = process.argv[2] || "chrome",
  root =
    process.env.SSX3_TEST_OUTPUT ||
    fs.mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), "ssx3-presenter-"),
    );
fs.mkdirSync(root, { recursive: true });
const origin =
  process.env.SSX3_WEBGL_PRESENTER_ORIGIN || "http://127.0.0.1:8370/";
assert(["chrome", "firefox"].includes(kind), "Choose chrome or firefox");
(async () => {
  const browser = await p.launch({
    ...(kind === "firefox" ? { browser: "firefox" } : {}),
    executablePath:
      kind === "firefox"
        ? process.env.SSX3_FIREFOX_BIN || "/usr/bin/firefox"
        : process.env.SSX3_CHROMIUM_BIN || "/usr/bin/chromium",
    headless: false,
  });
  const page = await browser.newPage(),
    errors = [],
    results = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const fresh = () =>
    page.goto(new URL("fixture.html", origin).href, { waitUntil: "load" });
  const check = async (name, fn, arg) => {
    await fresh();
    const value = await page.evaluate(fn, arg);
    assert(value.passed, JSON.stringify(value));
    results.push({ name, ...value });
    console.log("PASS", kind, name);
  };
  try {
    await check("normal-dispose-twice", () => {
      const id = Module.webglGpuPresenter.source(16, 16);
      const live = qa.empty();
      Module.webglGpuPresenter.dispose();
      Module.webglGpuPresenter.dispose();
      const empty = qa.empty();
      return {
        passed:
          id > 0 &&
          live.registered === 1 &&
          empty.resources.every((x) => x[1] === 0) &&
          empty.registered === 0 &&
          empty.rafs === 0 &&
          gl.getError() === gl.NO_ERROR,
        live,
        empty,
      };
    });
    for (const [resource, count] of [
      ["Program", 2],
      ["Shader", 4],
      ["Texture", 4],
      ["Framebuffer", 4],
      ["VertexArray", 1],
      ["compile", 4],
      ["link", 2],
      ["framebufferStatus", 1],
    ])
      for (let at = 1; at <= count; ++at) {
        await check(
          "partial-" + resource + "-" + at,
          ({ resource, at }) => {
            qa.fail = { kind: resource, at };
            let threw = false;
            try {
              Module.webglGpuPresenter.source(16, 16);
            } catch {
              threw = true;
            }
            const empty = qa.empty();
            return {
              passed:
                threw &&
                Module.webglGpuPresenter.closed &&
                empty.resources.every((x) => x[1] === 0) &&
                !empty.registered &&
                !empty.rafs &&
                qa.halted === 1 &&
                gl.getError() === gl.NO_ERROR,
              empty,
              halted: qa.halted,
            };
          },
          { resource, at },
        );
      }
    await check("cancel-multiple-waiters", () => {
      const p = Module.webglGpuPresenter;
      p.source(16, 16);
      const done = Array.from({ length: 6 }, () => []);
      for (let i = 0; i < 5; i++)
        p.enqueue(qa.meta, (value) => done[i].push(value));
      p.dispose();
      p.enqueue(qa.meta, (value) => done[5].push(value));
      const empty = qa.empty();
      return {
        passed:
          JSON.stringify(done) ===
            JSON.stringify([[1], [1], [1], [0], [0], [0]]) &&
          empty.resources.every((x) => !x[1]) &&
          !empty.registered &&
          !empty.rafs,
        done,
        empty,
      };
    });
    await check("completion-throws-once", () => {
      const p = Module.webglGpuPresenter;
      p.source(16, 16);
      const values = [];
      let caught = false;
      try {
        p.enqueue(qa.meta, (value) => {
          values.push(value);
          throw Error("Controlled completion exception");
        });
      } catch (e) {
        caught = e.message === "Controlled completion exception";
      }
      const active = !p.closed;
      p.dispose();
      return {
        passed:
          caught &&
          active &&
          JSON.stringify(values) === "[1]" &&
          qa.halted === 0,
        values,
        active,
        halted: qa.halted,
      };
    });
    await check("cancellation-throws-all-settle", () => {
      const p = Module.webglGpuPresenter;
      p.source(16, 16);
      const values = Array.from({ length: 5 }, () => []);
      for (let i = 0; i < 5; ++i)
        p.enqueue(qa.meta, (value) => {
          values[i].push(value);
          if (i === 3) throw Error("Controlled cancellation exception");
        });
      let caught = false;
      try {
        p.dispose();
      } catch (e) {
        caught = e.message === "Controlled cancellation exception";
      }
      const empty = qa.empty();
      return {
        passed:
          caught &&
          JSON.stringify(values) === "[[1],[1],[1],[0],[0]]" &&
          empty.resources.every((x) => !x[1]) &&
          !empty.registered &&
          !empty.rafs,
        values,
        empty,
      };
    });
    await check("queue-progress-and-pause", async () => {
      const p = Module.webglGpuPresenter;
      p.source(16, 16);
      const values = Array.from({ length: 5 }, () => []);
      for (let i = 0; i < 5; ++i)
        p.enqueue(qa.meta, (value) => values[i].push(value));
      qa.step(1000);
      await Promise.resolve();
      const after = values.map((x) => x.slice());
      Module.paused = true;
      Module.surfaceYield?.();
      const paused = values.map((x) => x.slice());
      p.dispose();
      return {
        passed:
          JSON.stringify(after) === "[[1],[1],[1],[1],[]]" &&
          JSON.stringify(paused) === "[[1],[1],[1],[1],[0]]" &&
          qa.presented === 1,
        after,
        paused,
        presented: qa.presented,
      };
    });
    await check("frame-allocation-fault-cancels", () => {
      const p = Module.webglGpuPresenter;
      p.source(16, 16);
      qa.fail = { kind: "framebufferStatus", at: 2 };
      const values = [];
      p.enqueue(qa.meta, (value) => values.push(value));
      const empty = qa.empty();
      return {
        passed:
          p.closed &&
          JSON.stringify(values) === "[0]" &&
          qa.halted === 1 &&
          empty.resources.every((x) => !x[1]) &&
          !empty.registered &&
          !empty.rafs &&
          gl.getError() === gl.NO_ERROR,
        values,
        empty,
      };
    });
    await check("context-loss-cancels", async () => {
      const p = Module.webglGpuPresenter;
      p.source(16, 16);
      const values = Array.from({ length: 5 }, () => []);
      for (let i = 0; i < 5; ++i)
        p.enqueue(qa.meta, (value) => values[i].push(value));
      gl.getExtension("WEBGL_lose_context").loseContext();
      for (let i = 0; i < 100 && !p.closed; ++i)
        await new Promise((r) => setTimeout(r, 10));
      const empty = qa.empty();
      return {
        passed:
          p.closed &&
          JSON.stringify(values) === "[[1],[1],[1],[0],[0]]" &&
          qa.halted === 1 &&
          empty.resources.every((x) => !x[1]) &&
          !empty.registered &&
          !empty.rafs,
        values,
        empty,
        halted: qa.halted,
      };
    });
    for (const mode of ["external-halt", "pagehide"])
      await check(
        mode,
        (mode) => {
          const p = Module.webglGpuPresenter,
            original = Module.onHalt;
          p.source(16, 16);
          const values = Array.from({ length: 5 }, () => []);
          for (let i = 0; i < 5; i++)
            p.enqueue(qa.meta, (value) => values[i].push(value));
          if (mode === "external-halt")
            Module.onHalt("Controlled external failure");
          else globalThis.dispatchEvent(new Event("pagehide"));
          const empty = qa.empty();
          return {
            passed:
              p.closed &&
              JSON.stringify(values) === "[[1],[1],[1],[0],[0]]" &&
              Module.onHalt === original &&
              empty.resources.every((x) => !x[1]) &&
              !empty.registered &&
              !empty.rafs,
            values,
            empty,
          };
        },
        mode,
      );
    await check("external-capacity-wait-dispose", async () => {
      const p = Module.webglGpuPresenter;
      p.source(16, 16);
      let wakes = 0;
      Module.surfaceYield = () => {
        wakes++;
      };
      p.dispose();
      p.dispose();
      await Promise.resolve();
      return {
        passed:
          wakes === 1 &&
          Module.surfaceYield === undefined &&
          qa.empty().rafs === 0,
        wakes,
      };
    });
    for (const flag of ["failed", "stoppedForReload"])
      await check(
        "terminal-" + flag,
        (flag) => {
          const p = Module.webglGpuPresenter;
          p.source(16, 16);
          const values = Array.from({ length: 5 }, () => []);
          for (let i = 0; i < 5; i++)
            p.enqueue(qa.meta, (value) => values[i].push(value));
          Module[flag] = true;
          qa.step(1000);
          const empty = qa.empty();
          return {
            passed:
              p.closed &&
              JSON.stringify(values) === "[[1],[1],[1],[0],[0]]" &&
              empty.resources.every((x) => !x[1]) &&
              !empty.registered &&
              !empty.rafs,
            empty,
            values,
          };
        },
        flag,
      );
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      root + "/" + kind + "-lifecycle.json",
      JSON.stringify(
        { passed: true, checks: results.length, results, errors },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
