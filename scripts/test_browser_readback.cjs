const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.SSX3_TEST_OUTPUT || 'build/browser-readback';
let browser;

(async () => {
  fs.mkdirSync(output, { recursive: true });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, headless: true,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface'],
  });
  const results = [];
  for (const mode of ['late', 'rejected']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(({ mode, compat }) => {
      if (compat) {
        Object.defineProperty(WebAssembly, 'Suspending', { configurable: true, value: undefined });
        Object.defineProperty(WebAssembly, 'promising', { configurable: true, value: undefined });
      }
      window.qaReadback = { armed: false, injection: null, frames: [] };
      const map = GPUBuffer.prototype.mapAsync;
      GPUBuffer.prototype.mapAsync = function (...args) {
        if (!qaReadback.armed || qaReadback.injection || !(args[2] > 16)) return map.apply(this, args);
        const injection = qaReadback.injection = { frame: Module._ps2web_frames(), start: performance.now(), settled: false };
        // A 22 ms readback arrives after the next renderer check but normally
        // before the following refresh. Reject without mapping the real buffer
        // in the error case, so it remains legal to reuse for another copy.
        const ready = mode === 'rejected' ? Promise.resolve() : map.apply(this, args);
        return ready.then(value => new Promise((resolve, reject) => setTimeout(() => {
          injection.trackedBeforeSettlement = injection.futureId in WebGPU.Internals.futures;
          injection.end = performance.now(); injection.settled = true;
          if (mode === 'rejected') reject(new Error('QA rejected readback'));
          else resolve(value);
        }, Math.max(0, 22 - (performance.now() - injection.start)))));
      };
    }, { mode, compat: process.env.SSX3_TEST_DISABLE_JSPI === '1' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    const url = new URL(process.env.SSX3_TEST_URL || 'http://localhost:8652');
    url.search = new URLSearchParams({ state: process.env.SSX3_TEST_STATE || 'test.state', nocard: '', copy: '' }).toString();
    await page.goto(url.href);
    await page.waitForFunction(() => !document.querySelector('#start').disabled, null, { timeout: 60000 });
    await page.locator('#start').click();
    await page.waitForFunction(() => Module._ps2web_frames() >= 6200, null, { timeout: 60000 });
    assert(await page.evaluate(() => !!Module.blitContext), 'This regression targets the canvas-copy presentation path');
    await page.evaluate(() => {
      qaReadback.refreshes = []; qaReadback.image = 0; qaReadback.measuring = true;
      const insertFuture = WebGPU.Internals.futureInsert;
      WebGPU.Internals.futureInsert = (id, promise) => {
        insertFuture(id, promise);
        // mapAsync creates the injection synchronously immediately before
        // the bridge registers that operation's future.
        if (qaReadback.injection && !qaReadback.injection.futureId)
          qaReadback.injection.futureId = id;
      };
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        const result = draw.apply(this, args);
        if (this.canvas.id === 'canvas') ++qaReadback.image;
        return result;
      };
      let stamp = null, flip = 0;
      const sentinel = document.createElement('div');
      sentinel.style.cssText = 'position:fixed;left:-100px;top:-100px;width:1px;height:1px;contain:strict;visibility:hidden';
      document.body.append(sentinel);
      const observer = new ResizeObserver(() => {
        if (qaReadback.measuring && stamp !== null && qaReadback.image)
          qaReadback.refreshes.push([stamp, qaReadback.image, Module._ps2web_frames()]);
      });
      observer.observe(sentinel);
      function sample(t) {
        if (!qaReadback.measuring) { observer.disconnect(); sentinel.remove(); return; }
        stamp = t; sentinel.style.width = (1 + (++flip % 2)) + 'px';
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
      const frame = Module.onFrame;
      Module.onFrame = displayed => { qaReadback.frames.push([performance.now(), Module._ps2web_frames(), displayed]); frame(displayed); };
      qaReadback.armed = true;
    });
    await page.waitForFunction(() => qaReadback.injection?.settled, null, { timeout: 5000 });
    await page.waitForFunction(() => Module._ps2web_frames() > qaReadback.injection.frame + 90, null, { timeout: 10000 });
    const result = await page.evaluate(() => {
      qaReadback.measuring = false;
      return { ...qaReadback, failed: !!Module.failed, currentFrame: Module._ps2web_frames(),
        gpuFutures: Object.keys(WebGPU.Internals.futures).length,
        injectedFutureRetained: qaReadback.injection.futureId in WebGPU.Internals.futures };
    });
    result.mode = mode; result.errors = errors;
    result.skippedNearInjection = result.frames.filter(f => f[1] >= result.injection.frame && f[1] <= result.injection.frame + 5 && !f[2]).length;
    result.missedRefreshes = result.refreshes.slice(1).filter((r, i) => r[1] === result.refreshes[i][1] || r[0] - result.refreshes[i][0] > 25);
    results.push(result);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    assert.equal(result.failed, false);
    assert.equal(errors.length, 0);
    assert.equal(result.injection.trackedBeforeSettlement, true, 'Pending GPU operations must remain waitable');
    if (process.env.SSX3_TEST_EXPECT_READBACK_SKIP !== '1') {
      assert(result.gpuFutures <= 8, 'Completed GPU operations must not accumulate in the future table');
      assert.equal(result.injectedFutureRetained, false, 'Both successful and rejected readbacks must release their future entry');
    }
    if (mode === 'late') {
      if (process.env.SSX3_TEST_EXPECT_READBACK_SKIP === '1') assert(result.skippedNearInjection > 0, 'Baseline must reproduce the skipped frame');
      else assert.equal(result.skippedNearInjection, 0, 'A late successful readback must still be displayed');
      if (process.env.SSX3_TEST_REQUIRE_60 === '1' && process.env.SSX3_TEST_EXPECT_READBACK_SKIP !== '1')
        assert.equal(result.missedRefreshes.length, 0, 'A 22 ms readback must retain a fresh image at each measured 60 Hz paint opportunity');
    }
    assert(result.frames.slice(-30).every(f => f[2]), 'Normal rendering must recover after the delayed/rejected readback');
    await page.locator('#pause').click();
    await page.waitForFunction(() => Module._ps2web_pause_ready() === 1);
    const paused = await page.evaluate(() => Module._ps2web_frames());
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => Module._ps2web_frames()), paused);
    await page.locator('#start').click();
    await page.waitForFunction(f => Module._ps2web_frames() > f + 30, paused);
    await page.screenshot({ path: path.join(output, mode + '.png') });
    console.log('PASS', mode, JSON.stringify({ injection: result.injection, skippedNearInjection: result.skippedNearInjection, currentFrame: result.currentFrame, gpuFutures: result.gpuFutures }));
    await context.close();
  }
  await browser.close();
})().catch(async error => {
  console.error(error);
  if (browser) await browser.close();
  process.exitCode = 1;
});
