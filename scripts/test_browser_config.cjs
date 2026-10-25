const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
let browser;

(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    headless: true,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface'],
  });
  // A fresh context with nocard keeps the reproduction away from real saves.
  const page = await browser.newPage();
  if (process.env.SSX3_TEST_DISABLE_JSPI === '1') {
    await page.addInitScript(() => {
      Object.defineProperty(WebAssembly, 'Suspending', { configurable: true, value: undefined });
      Object.defineProperty(WebAssembly, 'promising', { configurable: true, value: undefined });
    });
  }
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const sentinel = '/memcard/qa-config-sentinel.txt';
  const url = new URL(process.env.SSX3_TEST_URL || 'http://localhost:8620');
  url.search = new URLSearchParams({
    state: process.env.SSX3_TEST_STATE || 'test.state',
    nocard: '',
    PS2_GPU_PROFILE: '0,1,' + sentinel,
    PS2_NO_VU_THREAD: '1',
  }).toString();
  await page.goto(url.href);
  await page.waitForFunction(() => !document.querySelector('#start').disabled, null, { timeout: 60000 });
  await page.evaluate(sentinel => {
    if (!FS.analyzePath('/memcard').exists) FS.mkdir('/memcard');
    FS.writeFile(sentinel, 'preserve this player file');
  }, sentinel);
  const env = await page.evaluate(() => ({
    profile: Module.ENV.PS2_GPU_PROFILE,
    threads: Module.ENV.PS2_NO_VU_THREAD,
    scale: Module.ENV.PS2_SCALE,
  }));
  await page.locator('#start').click();
  await page.waitForFunction(() => Module._ps2web_frames() > 6150, null, { timeout: 60000 });
  const contents = await page.evaluate(sentinel => FS.readFile(sentinel, { encoding: 'utf8' }), sentinel);
  const result = { env, contents, errors };
  const output = process.env.SSX3_TEST_OUTPUT || 'build/browser-config-results.json';
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  assert.equal(contents, 'preserve this player file');
  assert.equal(env.profile, undefined);
  assert.equal(env.threads, undefined);
  assert.equal(env.scale, '1');
  assert.equal(errors.length, 0);
  await browser.close();
})().catch(async error => {
  console.error(error);
  if (browser) await browser.close();
  process.exitCode = 1;
});
