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
    native: qaProbe.result, integration: qaProbe.webglIntegration, errors: qaProbe.errors,
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
    partialRgb24: true, rejectedSnapshot: true, browserYield: true });
  await page.screenshot({ path: path.join(output, kind + '.png') });
  console.log('PASS', kind, JSON.stringify(result.native), JSON.stringify(result.integration));
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { if (browser) await browser.close(); });
