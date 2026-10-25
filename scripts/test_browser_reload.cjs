const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SSX3_TEST_URL || 'http://127.0.0.1:8679';
const output = process.env.SSX3_TEST_OUTPUT || 'build/browser-reload';
const card = fs.readFileSync(process.env.SSX3_TEST_CARD);
const hash = crypto.createHash('sha256').update(card).digest('hex');
let browser;
(async () => {
  fs.mkdirSync(output, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface'] });
  const context = await browser.newContext();
  await context.addInitScript(compat => {
    if (compat) {
      Object.defineProperty(WebAssembly, 'Suspending', { configurable: true, value: undefined });
      Object.defineProperty(WebAssembly, 'promising', { configurable: true, value: undefined });
    }
    window.qaCompiler = { created: 0, terminated: 0 };
    const NativeWorker = Worker;
    globalThis.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        if (options?.name === 'ssx3-compiler') {
          ++qaCompiler.created;
          const terminate = this.terminate.bind(this);
          this.terminate = () => { ++qaCompiler.terminated; terminate(); };
        }
      }
    };
  }, process.env.SSX3_TEST_DISABLE_JSPI === '1');
  const page = await context.newPage(), errors = [], warnings = [], results = [];
  page.on('pageerror', e => errors.push(e.stack));
  page.on('console', m => { if (['error', 'warning'].includes(m.type()) && m.text() !== 'Player stopped QA runtime recovery') warnings.push(m.text()); });
  const ready = async () => {
    await page.waitForFunction(() => document.querySelector('#start')?.textContent === 'Play SSX 3' && !document.querySelector('#start').disabled, null, { timeout: 90000 });
    assert.deepEqual(await page.evaluate(() => qaCompiler), { created: 1, terminated: 1 });
  };
  const cardHash = () => page.evaluate(async () => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', FS.readFile('/memcard/Mcd001.ps2')))).map(x => x.toString(16).padStart(2, '0')).join(''));
  const startAndPause = async () => {
    await page.locator('#start').click();
    await page.waitForFunction(() => Module._ps2web_frames() > 300, null, { timeout: 90000 });
    await page.evaluate(() => waitForPause());
    assert.equal(await page.evaluate(() => Module._ps2web_pause_ready()), 1);
  };
  const reloadBy = async action => {
    const origin = await page.evaluate(() => performance.timeOrigin);
    await action();
    await page.waitForFunction(old => performance.timeOrigin !== old, origin, { timeout: 30000 });
    await ready();
    assert.equal(await cardHash(), hash);
  };
  await page.goto(base);
  await ready();
  await page.evaluate(async encoded => {
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    FS.writeFile('/memcard/Mcd001.ps2', new Uint8Array(bytes));
    await new Promise((resolve, reject) => storeCard(error => error ? reject(error) : resolve()));
  }, card.toString('base64'));
  await startAndPause();
  // A document retained in the back/forward cache must remain resumable.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  assert.equal(await page.evaluate(() => !!Module.stoppedForReload), false);
  await page.locator('#start').click();
  const frame = await page.evaluate(() => Module._ps2web_frames());
  await page.waitForFunction(previous => Module._ps2web_frames() > previous + 20, frame);
  await page.evaluate(() => waitForPause());
  results.push('cached-page lifecycle preserves resume');
  await reloadBy(() => page.reload());
  await startAndPause();
  results.push('browser refresh preserves card and restarts gameplay');
  // Discard while the renderer is suspended in a graphics readback, not only
  // while paused in its idle wait. The following document must start cleanly.
  await page.evaluate(() => {
    const map = GPUBuffer.prototype.mapAsync;
    GPUBuffer.prototype.mapAsync = function(...args) {
      const result = map.apply(this, args);
      if (this.size > 16 && !window.qaHeldReadback) {
        window.qaHeldReadback = true;
        return result.then(() => new Promise(() => {}));
      }
      return result;
    };
  });
  await page.locator('#start').click();
  await page.waitForFunction(() => window.qaHeldReadback === true);
  await reloadBy(() => page.reload());
  await startAndPause();
  results.push('browser refresh cancels pending graphics readback');
  // An unfinished native save must keep the current runtime alive for recovery.
  await page.evaluate(async () => { Module.ps2CardSaveFailed(); await reloadPlayer(); });
  assert.equal(await page.evaluate(() => !!Module.stoppedForReload), false);
  assert.match(await page.locator('#help').textContent(), /game will retry/);
  await page.evaluate(async () => { Module.ps2CardSaved(); await waitForCard(); });
  results.push('pending native save blocks shutdown');
  await page.locator('#overlay-options').click();
  await reloadBy(() => page.locator('#aspect').selectOption('16:9'));
  assert.equal(await page.locator('#aspect').inputValue(), '16:9');
  results.push('aspect reload preserves card');
  await startAndPause();
  await page.locator('#overlay-options').click();
  await reloadBy(() => page.locator('#scale').selectOption('2'));
  assert.equal(await page.locator('#scale').inputValue(), '2');
  results.push('scale reload preserves card');
  await startAndPause();
  page.once('dialog', dialog => dialog.accept());
  await reloadBy(() => page.locator('#import-file').setInputFiles({ name: 'career.ps2', mimeType: 'application/octet-stream', buffer: card }));
  results.push('successful import reload preserves card');
  await startAndPause();
  await page.evaluate(() => failPlayer('QA runtime recovery'));
  await reloadBy(() => page.locator('#start').click());
  results.push('runtime failure recovery preserves card');
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  await page.screenshot({ path: path.join(output, 'reloaded.png') });
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ results, cardSha256: hash, errors, warnings, compat: process.env.SSX3_TEST_DISABLE_JSPI === '1' }, null, 2));
  console.log('PASS', results.join('; '));
  await browser.close();
})().catch(async error => { console.error(error); if (browser) await browser.close(); process.exitCode = 1; });
