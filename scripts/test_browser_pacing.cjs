const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.SSX3_TEST_OUTPUT || 'build/browser-pacing';
let browser;

(async () => {
  fs.mkdirSync(output, { recursive: true });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, headless: true,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  if (process.env.SSX3_TEST_DISABLE_JSPI === '1') await context.addInitScript(() => {
    Object.defineProperty(WebAssembly, 'Suspending', { configurable: true, value: undefined });
    Object.defineProperty(WebAssembly, 'promising', { configurable: true, value: undefined });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) errors.push(m.text()); });
  const url = new URL(process.env.SSX3_TEST_URL || 'http://localhost:8674');
  // The fixture is the local frame-4800 Single Event / Select Event state.
  url.search = new URLSearchParams({ state: process.env.SSX3_TEST_STATE || 'menu.state', nocard: '', copy: '' }).toString();
  await page.goto(url.href);
  assert.equal(await page.title(), 'SSX 3');
  await page.waitForFunction(() => !document.querySelector('#start').disabled, null, { timeout: 60000 });
  await page.locator('#start').click();
  await page.waitForFunction(() => Module._ps2web_frames() > 4850, null, { timeout: 90000 });
  for (let i = 0; i < 4; ++i) {
    await page.keyboard.press('KeyI', { delay: 150 });
    await page.waitForTimeout(800);
  }
  await page.screenshot({ path: path.join(output, 'before.png') });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.qaPacing = { active: true, id: 0, raf: [], beforePaint: [], actions: [] };
    // Rendering now resumes inside animation callbacks. Their registration
    // order can move an early sample before/after the copy. ResizeObserver
    // runs after those callbacks and layout, before this rendering update
    // paints. Retain the early samples too, for comparison with older checks.
    let stamp = null, flip = 0;
    const sentinel = document.createElement('div');
    sentinel.style.cssText = 'position:fixed;left:-100px;top:-100px;width:1px;height:1px;contain:strict;visibility:hidden';
    document.body.append(sentinel);
    const observer = new ResizeObserver(() => {
      if (qaPacing.active && stamp !== null && qaPacing.id)
        qaPacing.beforePaint.push([stamp, qaPacing.id, Module._ps2web_frames(), performance.now()]);
    });
    observer.observe(sentinel);
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      const result = draw.apply(this, args);
      if (this.canvas.id === 'canvas') ++qaPacing.id;
      return result;
    };
    function tick(t) {
      if (!qaPacing.active) return;
      stamp = t;
      sentinel.style.width = (1 + (++flip % 2)) + 'px';
      if (qaPacing.id) qaPacing.raf.push([t, qaPacing.id, Module._ps2web_frames()]);
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
  // Real keyboard down/up events reproduce input-dependent task deferral.
  // Confirm/back alternates Select Character and Setup Character.
  for (let i = 0; i < 30; ++i) for (const key of ['KeyZ', 'KeyI']) {
    await page.evaluate(key => qaPacing.actions.push({ key, time: performance.now(), frame: Module._ps2web_frames() }), key);
    await page.keyboard.press(key, { delay: 150 });
    await page.waitForTimeout(850);
  }
  const data = await page.evaluate(() => { qaPacing.active = false; return { ...qaPacing, failed: !!Module.failed }; });
  const intervalData = samples => samples.slice(1).map((r, i) => ({ time: r[0], frame: r[2], ms: r[0] - samples[i][0], draws: r[1] - samples[i][1] }));
  const intervals = intervalData(data.beforePaint);
  const fresh = data.beforePaint.filter((r, i) => i && r[1] !== data.beforePaint[i - 1][1]);
  const summary = {
    url: url.href, intervals: intervals.length,
    seconds: (data.raf.at(-1)[0] - data.raf[0][0]) / 1000,
    misses: intervals.filter(r => !r.draws || r.ms > 25),
    earlySampleMisses: intervalData(data.raf).filter(r => !r.draws || r.ms > 25),
    maxFreshGapMs: Math.max(...fresh.slice(1).map((r, i) => r[0] - fresh[i][0])),
    errors, failed: data.failed,
  };
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ ...summary, data }, null, 2));
  await page.screenshot({ path: path.join(output, 'after.png') });
  assert.equal(data.failed, false);
  assert.equal(errors.length, 0);
  assert(data.raf.at(-1)[2] - data.raf[0][2] > 3000, 'Menu navigation must keep advancing the game');
  // Enable this gate on the calibrated 60 Hz test browser. Faster displays
  // legitimately have refreshes between the game's native-rate images.
  if (process.env.SSX3_TEST_REQUIRE_60 === '1') assert.equal(summary.misses.length, 0, 'Every measured 60 Hz refresh must have a fresh image');
  console.log(JSON.stringify(summary));
  await browser.close(); browser = null;
})().catch(async error => {
  console.error(error);
  if (browser) await browser.close();
  process.exitCode = 1;
});
