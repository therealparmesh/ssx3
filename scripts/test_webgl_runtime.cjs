// Asset-free integration against the runtime GPU API, with WebGPU withheld.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require(process.env.PUPPETEER_MODULE || 'puppeteer-core');
const kind = process.env.SSX3_TEST_BROWSER || 'firefox';
assert(['chrome', 'firefox'].includes(kind));
const url = process.env.SSX3_TEST_URL || 'http://127.0.0.1:8723/gpu_copy_readback.html';
const output = process.env.SSX3_TEST_OUTPUT || 'build/webgl-runtime-results';
let browser;
(async () => {
  fs.mkdirSync(output, { recursive: true });
  browser = await puppeteer.launch(kind === 'firefox'
    ? { browser: 'firefox', executablePath: process.env.FIREFOX_EXECUTABLE || '/usr/bin/firefox', headless: false }
    : { executablePath: process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: false });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.qaProbe?.result || window.qaProbe?.errors.length, { timeout: 60000 });
  const result = await page.evaluate(() => ({
    native: qaProbe.result, mips: qaProbe.mips, integration: qaProbe.webglIntegration, errors: qaProbe.errors,
    messages: qaProbe.messages, backend: Module.ps2GpuBackend, isolated: crossOriginIsolated,
    webgpuAbsent: navigator.gpu === undefined, title: document.title, url: location.href,
  }));
  result.browser = kind; result.pageErrors = errors;
  fs.writeFileSync(path.join(output, kind + '.json'), JSON.stringify(result, null, 2));
  assert.equal(result.backend, 'webgl');
  assert.equal(result.isolated, true);
  assert.equal(result.webgpuAbsent, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(errors, []);
  assert.equal(result.native?.passed, true);
  assert.equal(result.native.frames, 64);
  assert.equal(result.native.pixels, 188416);
  assert.equal(result.native.hash, 1370334661);
  assert.equal(result.native.scale, 1);
  assert.equal(result.native.synchronous, true);
  assert(result.native.nonzeroSourceOffset >= 8192);
  assert.deepEqual(result.integration, { snapshot: true, drawExport: true, localCopy: true,
    partialRgb24: true, rejectedSnapshot: true, browserYield: true, glFaults: 6 });
  assert.equal(result.mips?.cases, 124);
  assert.equal(result.mips.pixels, 7936);
  assert.equal(result.mips.hash, 2473005509);
  assert(result.mips.mipBatches > 0);
  assert.equal(result.mips.approximateBatches, 0);
  await page.screenshot({ path: path.join(output, kind + '.png') });
  await page.close();
  const control = await browser.newPage();
  await control.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true }));
  const controlUrl = new URL(url);
  controlUrl.searchParams.set('skipWebglErrors', '1');
  await control.goto(controlUrl.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await control.waitForFunction(() => window.qaProbe?.result || window.qaProbe?.errors.length, { timeout: 60000 });
  const negative = await control.evaluate(() => ({ result: qaProbe.result, errors: qaProbe.errors, messages: qaProbe.messages }));
  fs.writeFileSync(path.join(output, kind + '-skip-errors.json'), JSON.stringify({ expectedFailure: true, ...negative }, null, 2));
  assert.notEqual(negative.result?.passed, true);
  assert(negative.messages.some(text => text.includes('PROBE_FAIL: Dirty WebGL export must reject a GL fault')),
    'Suppressing error queries must fail the dirty-export control');
  await control.close();
  console.log('PASS', kind, JSON.stringify(result.native), JSON.stringify(result.integration), JSON.stringify(result.mips), 'and suppressed-error negative control');
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { if (browser) await browser.close(); });
