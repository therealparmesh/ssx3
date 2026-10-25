const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SSX3_TEST_URL || 'http://localhost:8642';
const output = process.env.SSX3_TEST_OUTPUT || 'build/browser-loader';
let browser;

(async () => {
  fs.mkdirSync(output, { recursive: true });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    headless: true,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface'],
  });
  const results = [];
  const cases = (process.env.SSX3_TEST_LOADER_CASES || 'normal,mime-fallback,unauthorized,missing,login-page,invalid-wasm,network,worker-start,worker-error,timeout').split(',');
  for (const mode of cases) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(({ mode, compat }) => {
      if (compat) {
        Object.defineProperty(WebAssembly, 'Suspending', { configurable: true, value: undefined });
        Object.defineProperty(WebAssembly, 'promising', { configurable: true, value: undefined });
      }
      window.qaCompiler = { created: 0, terminated: 0 };
      const NativeWorker = Worker;
      globalThis.Worker = class extends NativeWorker {
        constructor(url, options) {
          const compiler = options?.name === 'ssx3-compiler';
          if (compiler && mode === 'worker-start') throw new Error('QA blocked worker');
          const replacement = compiler && mode === 'worker-error'
            ? URL.createObjectURL(new Blob(['throw new Error("QA compiler worker failure")'], { type: 'text/javascript' })) : null;
          super(replacement || url, options);
          if (replacement) URL.revokeObjectURL(replacement);
          if (compiler) {
            ++qaCompiler.created;
            const terminate = this.terminate.bind(this);
            this.terminate = () => { ++qaCompiler.terminated; terminate(); };
          }
        }
      };
      if (mode === 'timeout') {
        const timeout = window.setTimeout;
        window.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 120000 ? 300 : ms, ...args);
      }
    }, { mode, compat: process.env.SSX3_TEST_DISABLE_JSPI === '1' });
    let downloads = 0;
    context.on('request', request => { if (new URL(request.url()).pathname.endsWith('/ps2web.wasm')) ++downloads; });
    if (!['normal', 'worker-start', 'worker-error'].includes(mode)) {
      await context.route('**/ps2web.wasm', async route => {
        if (mode === 'network') return route.abort('failed');
        if (mode === 'timeout') {
          await new Promise(resolve => setTimeout(resolve, 800));
          return route.abort('timedout').catch(() => {});
        }
        if (mode === 'mime-fallback') {
          const response = await route.fetch();
          return route.fulfill({ response, headers: { ...response.headers(), 'content-type': 'application/octet-stream' } });
        }
        const status = mode === 'unauthorized' ? 401 : mode === 'missing' ? 404 : 200;
        return route.fulfill({ status, contentType: mode === 'invalid-wasm' ? 'application/wasm' : 'text/html', body: mode === 'invalid-wasm' ? 'invalid wasm bytes' : '<html>Sign in</html>' });
      });
    }
    const page = await context.newPage(), errors = [], warnings = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
    const url = new URL(base);
    url.search = new URLSearchParams({ state: process.env.SSX3_TEST_STATE || 'test.state', nocard: '' }).toString();
    await page.goto(url.href);
    if (['normal', 'mime-fallback'].includes(mode)) {
      await page.waitForFunction(() => !document.querySelector('#start').disabled, null, { timeout: 60000 });
      assert.equal(await page.locator('#start').innerText(), 'Play SSX 3');
      await page.locator('#start').click();
      await page.waitForFunction(() => Module._ps2web_frames() > 6120, null, { timeout: 60000 });
      assert.equal(await page.evaluate(() => !!Module.failed), false);
      assert.equal(downloads, 1, 'The worker should download the Wasm asset once');
    } else {
      await page.waitForFunction(() => Module.failed, null, { timeout: 15000 });
      assert.equal(await page.locator('#start').innerText(), 'Reload player');
      assert.equal(await page.locator('#start').isDisabled(), false);
      assert.equal(await page.locator('#overlay').isVisible(), true);
      assert.equal(await page.locator('#pause').isVisible(), false);
      assert.match(await page.locator('#help').innerText(), mode === 'unauthorized' || mode === 'login-page' ? /Sign in again/ : mode === 'timeout' ? /Loading took too long/ : /[Rr]eload/);
      await page.waitForTimeout(1000);
      assert.equal(await page.locator('#start').innerText(), 'Reload player', 'Late work must not revive a failed player');
    }
    const compiler = await page.evaluate(() => qaCompiler);
    assert.deepEqual(compiler, mode === 'worker-start' ? { created: 0, terminated: 0 } : { created: 1, terminated: 1 });
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, mode + '.png') });
    const result = { mode, downloads, compiler, errors, warnings, help: await page.locator('#help').textContent() };
    if (mode === 'unauthorized') {
      // After sign-in is restored, the visible recovery action must actually
      // load a fresh player, not just display a button on the failed instance.
      await context.unroute('**/ps2web.wasm');
      await page.locator('#start').click();
      await page.waitForFunction(() => !document.querySelector('#start').disabled && !Module.failed, null, { timeout: 60000 });
      assert.equal(await page.locator('#start').innerText(), 'Play SSX 3');
      await page.locator('#start').click();
      await page.waitForFunction(() => Module._ps2web_frames() > 6120, null, { timeout: 60000 });
      assert.deepEqual(await page.evaluate(() => qaCompiler), { created: 1, terminated: 1 });
      assert.deepEqual(errors, []);
      result.recoveredToGameplay = true;
      await page.screenshot({ path: path.join(output, mode + '-recovered.png') });
    }
    results.push(result);
    console.log('PASS', mode);
    await context.close();
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  await browser.close();
})().catch(async error => {
  console.error(error);
  if (browser) await browser.close();
  process.exitCode = 1;
});
