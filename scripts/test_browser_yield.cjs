const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.SSX3_TEST_OUTPUT || 'build/browser-yield';
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
  // Exercise the posted-task fallback even when the native scheduler is available.
  await context.addInitScript(() => {
    if (globalThis.scheduler) Object.defineProperty(scheduler, 'yield', { value: undefined, configurable: true });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) errors.push(m.text()); });
  const url = new URL(process.env.SSX3_TEST_URL || 'http://localhost:8674');
  url.search = new URLSearchParams({ state: process.env.SSX3_TEST_STATE || 'test.state', nocard: '', copy: '' }).toString();
  await page.goto(url.href);
  await page.waitForFunction(() => !document.querySelector('#start').disabled, null, { timeout: 60000 });
  await page.locator('#start').click();
  await page.waitForFunction(() => Module._ps2web_frames() >= 6200, null, { timeout: 90000 });
  const held = await page.evaluate(() => new Promise(resolve => {
    const post = Module.yieldPort.postMessage.bind(Module.yieldPort), queue = [];
    const frame = Module.onFrame, before = Module._ps2web_frames();
    let displayedWhileHeld = 0;
    Module.onFrame = displayed => { frame(displayed); if (displayed) ++displayedWhileHeld; };
    // Hold the one outstanding wake while refresh/timer callbacks resume
    // several yields. Releasing it must not consume a newer suspension.
    Module.yieldPort.postMessage = (...args) => queue.push(args);
    setTimeout(() => {
      Module.yieldPort.postMessage = post;
      Module.onFrame = frame;
      const result = { before, after: Module._ps2web_frames(), heldMessages: queue.length, displayedWhileHeld };
      for (const args of queue) post(...args);
      resolve(result);
    }, 150);
  }));
  await page.waitForFunction(f => Module._ps2web_frames() > f + 90, held.after, { timeout: 10000 });
  const resumed = await page.evaluate(() => ({ frame: Module._ps2web_frames(), pendingYields: Module.yieldWaiters.length, failed: !!Module.failed }));
  await page.locator('#pause').click();
  await page.waitForFunction(() => Module._ps2web_pause_ready() === 1);
  const paused = await page.evaluate(() => Module._ps2web_frames());
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => Module._ps2web_frames()), paused);
  await page.locator('#start').click();
  await page.waitForFunction(f => Module._ps2web_frames() > f + 30, paused);
  const result = { held, resumed, paused, errors };
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  await page.screenshot({ path: path.join(output, 'resumed.png') });
  assert.equal(held.heldMessages, 1, 'Extended deferral keeps one outstanding posted wake');
  assert(held.displayedWhileHeld >= 8, 'A qualified 60 fps scene must keep presenting during task deferral');
  assert(held.after - held.before >= 8, 'Guest progress must track the held interval');
  assert(resumed.pendingYields <= 1, 'Retired wake drains before posting the latest unfinished yield');
  assert.equal(resumed.failed, false);
  assert.equal(errors.length, 0);
  console.log(JSON.stringify(result));
  await browser.close(); browser = null;
})().catch(async error => {
  console.error(error);
  if (browser) await browser.close();
  process.exitCode = 1;
});
