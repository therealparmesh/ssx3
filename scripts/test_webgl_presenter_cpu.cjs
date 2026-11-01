const fs = require("node:fs"),
  assert = require("node:assert/strict"),
  p = require(process.env.PUPPETEER_MODULE || "puppeteer-core");
const kind = process.argv[2] || "chrome",
  output =
    process.env.SSX3_TEST_OUTPUT ||
    fs.mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), "ssx3-presenter-"),
    );
fs.mkdirSync(output, { recursive: true });
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
  try {
    const page = await browser.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(new URL("fixture.html", origin).href);
    const result = await page.evaluate(async () => {
      const p = Module.webglGpuPresenter,
        expected = new Map(),
        seen = [],
        done = [];
      let pixels = 0,
        time = 1000;
      Module.qaBitmapFrame = (frame, crop) => {
        const seed = seen.length + 1;
        const bytes = crop
            .getContext("2d")
            .getImageData(0, 0, frame.width, frame.height).data,
          wanted = expected.get(seed);
        if (!wanted) throw Error("Unexpected frame " + seed);
        if (bytes.length !== wanted.length) throw Error("Bad size");
        for (let i = 0; i < bytes.length; i++)
          if (bytes[i] !== wanted[i])
            throw Error(
              "Pixel mismatch frame=" +
                seed +
                " byte=" +
                i +
                " actual=" +
                bytes[i] +
                " expected=" +
                wanted[i],
            );
        seen.push(seed);
        pixels += bytes.length / 4;
      };
      const unpack = [
          gl.UNPACK_ALIGNMENT,
          gl.UNPACK_ROW_LENGTH,
          gl.UNPACK_SKIP_PIXELS,
          gl.UNPACK_SKIP_ROWS,
          gl.UNPACK_FLIP_Y_WEBGL,
          gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
          gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,
        ],
        values = [8, 77, 3, 2, true, true, gl.BROWSER_DEFAULT_WEBGL];
      unpack.forEach((n, i) => gl.pixelStorei(n, values[i]));
      const intact = () =>
        unpack.every((n, i) => gl.getParameter(n) === values[i]);
      function enqueue(seed, width, height) {
        const bytes = new Uint8Array(width * height * 4);
        for (let i = 0; i < bytes.length; i++)
          bytes[i] = (i * 17 + seed * 23) & 255;
        const wanted = bytes.slice();
        for (let i = 3; i < wanted.length; i += 4) wanted[i] = 255;
        expected.set(seed, wanted);
        p.enqueue(
          {
            x: 0,
            y: 0,
            width,
            height,
            physical: height,
            wide: seed % 2 === 0,
            pixels: bytes,
          },
          (value) => done.push({ seed, value }),
        );
        bytes.fill(0);
        if (!intact()) throw Error("Unpack state changed");
      }
      enqueue(1, 3, 7);
      enqueue(2, 17, 9);
      enqueue(3, 32, 16);
      enqueue(4, 5, 11);
      enqueue(5, 9, 3);
      let rejected = false;
      try {
        enqueue(99, 1, 1);
      } catch (e) {
        rejected = e.message === "Too many pending display submissions";
      }
      if (!rejected) throw Error("Unbounded pending submissions");
      for (let i = 0; i < 5; i++) {
        qa.step(time);
        time += 17;
        await Promise.resolve();
      }
      for (const [i, width, height] of [
        [6, 1, 1],
        [7, 63, 33],
        [8, 64, 32],
        [9, 2, 15],
        [10, 31, 1],
      ]) {
        enqueue(i, width, height);
        qa.step(time);
        time += 17;
        await Promise.resolve();
      }
      for (let i = 0; i < 3; i++) {
        qa.step(time);
        time += 17;
        await Promise.resolve();
      }
      const state = intact(),
        error = gl.getError();
      p.dispose();
      return {
        seen,
        done,
        pixels,
        unpackPreserved: state,
        pendingBounded: rejected,
        error,
        empty: qa.empty(),
        failed: !!Module.failed,
      };
    });
    assert.deepEqual(result.seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(result.done.length, 10);
    assert(result.done.every((x) => x.value === 1));
    assert(result.unpackPreserved && result.pendingBounded && !result.failed);
    assert.equal(result.error, 0);
    assert(result.empty.resources.every((x) => x[1] === 0));
    assert.equal(result.empty.registered, 0);
    assert.equal(result.empty.rafs, 0);
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      output + "/" + kind + "-cpu.json",
      JSON.stringify({ passed: true, result, errors }, null, 2),
    );
    console.log(
      "PASS",
      kind,
      "10 CPU-upload images",
      result.pixels,
      "pixels, byte ownership, unpack state and bounded pending queue",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
