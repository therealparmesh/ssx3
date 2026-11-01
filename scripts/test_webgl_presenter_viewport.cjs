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
  const results = [];
  try {
    const page = await browser.newPage();
    for (const [width, height, wide] of [
      [128, 96, false],
      [127, 95, false],
      [333, 211, false],
      [641, 479, false],
      [1280, 800, false],
      [128, 96, true],
      [127, 95, true],
      [333, 211, true],
      [641, 479, true],
      [1280, 800, true],
    ])
      for (const solid of [true, false]) {
        await page.goto(new URL("fixture.html", origin).href);
        const result = await page.evaluate(
          ({ width, height, wide, solid }) => {
            Module.canvas.width = width;
            Module.canvas.height = height;
            const sw = 13,
              sh = 9,
              bytes = new Uint8Array(sw * sh * 4);
            for (let y = 0; y < sh; y++)
              for (let x = 0; x < sw; x++) {
                const i = (y * sw + x) * 4;
                bytes[i] = solid ? 255 : (x * 37 + y * 13) & 255;
                bytes[i + 1] = solid ? 255 : (x * 5 + y * 57) & 255;
                bytes[i + 2] = solid ? 255 : (x * 73 + y * 3) & 255;
                bytes[i + 3] = 255;
              }
            let actual;
            Module.onPresent = () => {
              const raw = new Uint8Array(width * height * 4);
              gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
              gl.readPixels(
                0,
                0,
                width,
                height,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                raw,
              );
              actual = new Uint8Array(raw.length);
              for (let y = 0; y < height; y++)
                actual.set(
                  raw.subarray(
                    (height - y - 1) * width * 4,
                    (height - y) * width * 4,
                  ),
                  y * width * 4,
                );
            };
            const meta = {
              x: 0,
              y: 0,
              width: sw,
              height: sh,
              physical: sh,
              wide,
              pixels: bytes,
            };
            Module.webglGpuPresenter.enqueue(meta, () => {});
            Module.webglGpuPresenter.enqueue(meta, () => {});
            qa.step(1000);
            const across = wide ? 16 : 4,
              down = wide ? 9 : 3,
              scale = Math.min(width / across, height / down),
              w = scale * across,
              h = scale * down,
              ox = (width - w) / 2,
              oy = (height - h) / 2,
              sx = Math.max(1, Math.floor(w / sw)),
              sy = Math.max(1, Math.floor(h / sh));
            const expected = new Uint8Array(width * height * 4);
            const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
            for (let y = 0; y < height; y++)
              for (let x = 0; x < width; x++) {
                const at = (y * width + x) * 4,
                  cx = clamp(Math.min(x + 1, ox + w) - Math.max(x, ox), 0, 1),
                  cy = clamp(Math.min(y + 1, oy + h) - Math.max(y, oy), 0, 1),
                  coverage = cx * cy;
                expected[at + 3] = 255;
                if (!coverage) continue;
                const px = ((x + 0.5 - ox) / w) * (sw * sx) - 0.5,
                  py = ((y + 0.5 - oy) / h) * (sh * sy) - 0.5,
                  ax = Math.floor(px),
                  ay = Math.floor(py),
                  fx = px - ax,
                  fy = py - ay;
                const x0 = Math.floor(clamp(ax, 0, sw * sx - 1) / sx),
                  x1 = Math.floor(clamp(ax + 1, 0, sw * sx - 1) / sx),
                  y0 = Math.floor(clamp(ay, 0, sh * sy - 1) / sy),
                  y1 = Math.floor(clamp(ay + 1, 0, sh * sy - 1) / sy);
                for (let c = 0; c < 3; c++) {
                  const a = bytes[(y0 * sw + x0) * 4 + c],
                    b = bytes[(y0 * sw + x1) * 4 + c],
                    d = bytes[(y1 * sw + x0) * 4 + c],
                    e = bytes[(y1 * sw + x1) * 4 + c],
                    top = a + (b - a) * fx,
                    bottom = d + (e - d) * fx;
                  expected[at + c] = Math.round(
                    (top + (bottom - top) * fy) * coverage,
                  );
                }
              }
            let different = 0,
              overOne = 0,
              max = 0,
              minX = width,
              minY = height,
              maxX = -1,
              maxY = -1;
            for (let i = 0; i < expected.length; i += 4) {
              let changed = false;
              for (let j = 0; j < 4; j++) {
                const d = Math.abs(expected[i + j] - actual[i + j]);
                if (d) changed = true;
                if (d > 1) overOne++;
                max = Math.max(max, d);
              }
              if (changed) {
                different++;
                const pixel = i / 4,
                  x = pixel % width,
                  y = Math.floor(pixel / width);
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
              }
            }
            Module.webglGpuPresenter.dispose();
            return {
              width,
              height,
              wide,
              solid,
              pixels: width * height,
              different,
              overOne,
              max,
              bounds: [minX, minY, maxX, maxY],
              gpuError: gl.getError(),
            };
          },
          { width, height, wide, solid },
        );
        results.push(result);
        console.log(JSON.stringify(result));
        assert.equal(result.gpuError, 0);
        assert(result.max <= 1, JSON.stringify(result));
      }
    fs.writeFileSync(
      output + "/" + kind + "-viewport.json",
      JSON.stringify(results, null, 2),
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
