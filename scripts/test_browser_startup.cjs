// Asset-required startup/recovery checks; each case uses a fresh browser context.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require(process.env.PUPPETEER_MODULE || 'puppeteer-core');
const base = process.env.SSX3_TEST_URL || 'http://127.0.0.1:8686';
const output = process.env.SSX3_TEST_OUTPUT || 'build/browser-startup';
const firefox = process.env.SSX3_TEST_BROWSER === 'firefox';
const cases = (process.env.SSX3_TEST_STARTUP_CASES || 'normal,held-animation,device-rejected,adapter-rejected,work-timeout,late-device,snapshot-rejected,late-snapshot,snapshot-late-error,blank-snapshot').split(',');
let browser, page, current, logs;
const results = [];

function installFault(mode, compat) {
  // Firefox also invokes new-document hooks on transient about:blank pages,
  // where the secure-context WebGPU interfaces have not been exposed yet.
  if (!navigator.gpu || typeof GPU === 'undefined') return;
  if (compat) {
    Object.defineProperty(WebAssembly, 'Suspending', { configurable: true, value: undefined });
    Object.defineProperty(WebAssembly, 'promising', { configurable: true, value: undefined });
  }
  const qa = window.qaStartup = { adapters: 0, devices: [], queues: 0, snapshots: 0, bitmaps: [], heldFrames: new Map(), fault: false };
  const makeBitmap = createImageBitmap;
  window.createImageBitmap = function(source, ...args) {
    if (!(source instanceof HTMLCanvasElement) || source.id === 'canvas') return makeBitmap.call(this, source, ...args);
    const first = ++qa.snapshots === 1;
    if (first && mode === 'snapshot-rejected') {
      qa.fault = true;
      return Promise.reject(new Error('QA first presentation snapshot unavailable'));
    }
    if (first && mode === 'snapshot-late-error') {
      qa.fault = true;
      return new Promise((resolve, reject) => { qa.release = () => reject(new Error('QA late snapshot failure')); });
    }
    if (mode === 'blank-snapshot') {
      qa.fault = true;
      source = document.createElement('canvas');
      source.width = source.height = 64;
    }
    return makeBitmap.call(this, source, ...args).then(bitmap => {
      const record = { closed: 0 };
      qa.bitmaps.push(record);
      const close = bitmap.close.bind(bitmap);
      bitmap.close = () => { ++record.closed; close(); };
      if (first && mode === 'late-snapshot') {
        qa.fault = true;
        return new Promise(resolve => { qa.release = () => resolve(bitmap); });
      }
      return bitmap;
    });
  };
  const requestAdapter = GPU.prototype.requestAdapter;
  GPU.prototype.requestAdapter = function(...args) {
    ++qa.adapters;
    if (mode === 'adapter-rejected' && qa.adapters === 2) {
      qa.fault = true;
      return Promise.reject(new Error('QA first presentation adapter unavailable'));
    }
    return requestAdapter.apply(this, args);
  };
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = function(...args) {
    const record = { destroyed: 0 };
    qa.devices.push(record);
    const first = qa.devices.length === 1;
    if (first && mode === 'device-rejected') {
      qa.fault = true;
      record.rejected = true;
      return Promise.reject(new Error('QA first presentation device unavailable'));
    }
    return requestDevice.apply(this, args).then(device => {
      const destroy = device.destroy.bind(device);
      device.destroy = () => { ++record.destroyed; destroy(); };
      if (first && mode === 'late-device') {
        qa.fault = true;
        return new Promise(resolve => { qa.release = () => resolve(device); });
      }
      return device;
    });
  };
  const workDone = GPUQueue.prototype.onSubmittedWorkDone;
  GPUQueue.prototype.onSubmittedWorkDone = function(...args) {
    ++qa.queues;
    const work = workDone.apply(this, args);
    if (mode === 'work-timeout' && qa.queues === 1) {
      qa.fault = true;
      return new Promise((resolve, reject) => {
        // Attach the rejection handler now: destroying a retired device may
        // reject its actual work before this deliberately late delivery.
        work.then(() => { qa.release = resolve; }, error => { qa.release = () => reject(error); });
      });
    }
    return work;
  };
  if (mode === 'held-animation') {
    const raf = requestAnimationFrame, cancel = cancelAnimationFrame;
    window.requestAnimationFrame = callback => {
      let id;
      id = raf(() => { qa.fault = true; qa.heldFrames.set(id, callback); });
      return id;
    };
    window.cancelAnimationFrame = id => { qa.heldFrames.delete(id); cancel(id); };
    qa.release = () => {
      window.requestAnimationFrame = raf;
      window.cancelAnimationFrame = cancel;
      const callbacks = [...qa.heldFrames.values()];
      qa.heldFrames.clear();
      for (const callback of callbacks) raf(callback);
    };
  }
}

async function snapshot() {
  return page.evaluate(() => ({
    url: location.href, title: document.title,
    status: document.querySelector('#status')?.textContent,
    button: document.querySelector('#start')?.textContent,
    help: document.querySelector('#help')?.textContent,
    runtime: typeof Module === 'undefined' ? null : {
      failed: !!Module.failed, gpu: Module.gpuInfo, bytes: Module.discSize,
      frames: Module._ps2web_frames?.(), copy: Module.presentCopy, surface: Module.bufferedSurface,
    },
    qa: window.qaStartup ? {
      adapters: qaStartup.adapters, devices: qaStartup.devices, queues: qaStartup.queues,
      snapshots: qaStartup.snapshots, bitmaps: qaStartup.bitmaps,
      fault: qaStartup.fault, heldFrames: qaStartup.heldFrames.size,
    } : null,
    probeCanvases: document.querySelectorAll('canvas:not(#canvas)').length,
  }));
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  browser = await puppeteer.launch(firefox ? {
    browser: 'firefox', executablePath: process.env.FIREFOX_EXECUTABLE || '/usr/bin/firefox',
    headless: process.env.SSX3_TEST_HEADLESS !== '0', networkEnabled: false,
    extraPrefsFirefox: { 'dom.webgpu.enabled': true }, defaultViewport: { width: 1280, height: 800 },
  } : {
    executablePath: process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium',
    headless: process.env.SSX3_TEST_HEADLESS !== '0', defaultViewport: { width: 1280, height: 800 },
    // Visible windows use compositor defaults; forcing the headless backend
    // options can stall native window presentation on Linux.
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan',
      ...(process.env.SSX3_TEST_HEADLESS !== '0' ? ['--use-angle=vulkan', '--disable-vulkan-surface'] : [])],
  });
  for (const mode of cases) {
    current = mode;
    console.log('START', mode);
    logs = [];
    const context = await browser.createBrowserContext();
    page = await context.newPage();
    page.on('pageerror', error => logs.push({ type: 'pageerror', message: error.message }));
    page.on('console', message => {
      if (['warn', 'warning', 'error'].includes(message.type())) logs.push({ type: message.type(), message: message.text() });
    });
    await page.evaluateOnNewDocument(installFault, mode, process.env.SSX3_TEST_DISABLE_JSPI === '1');
    const url = new URL(base);
    url.search = new URLSearchParams({ state: process.env.SSX3_TEST_STATE || 'refresh.state', nocard: '' }).toString();
    const started = Date.now();
    await page.goto(url.href);
    await page.waitForFunction(() => !document.querySelector('#start')?.disabled, { timeout: 60000, polling: 100 });
    assert.equal(await page.$eval('#start', element => element.textContent), 'Play SSX 3');
    const readyMs = Date.now() - started;
    const ready = await snapshot();
    assert.equal(ready.probeCanvases, 0, 'Presentation probes must be removed before Play');
    if (mode !== 'normal') assert.equal(ready.qa.fault, true, 'The intended startup fault must actually occur');
    if (mode === 'held-animation') assert.equal(ready.qa.heldFrames, 1, 'Only the normal presentation loop may remain held');
    if (mode === 'late-device') {
      assert.equal(ready.qa.devices[0].destroyed, 0);
      assert(ready.qa.devices.length >= 2, 'Another device must recover startup before the late request resolves');
    }
    if (mode === 'late-snapshot') assert.equal(ready.qa.bitmaps[0].closed, 0);
    if (mode === 'blank-snapshot') {
      assert.equal(ready.runtime.copy, true, 'A failed pixel check must select frame copying');
      assert.equal(!!ready.runtime.surface, false);
    } else if (process.env.SSX3_TEST_EXPECT_GPU_SURFACE === '1') {
      assert.equal(ready.runtime.copy, false, 'This qualified adapter must pass the pixel check');
      assert.equal(ready.runtime.surface, true, 'A working probe should select buffered GPU presentation');
    } else if (process.env.SSX3_TEST_EXPECT_GPU_SURFACE === '0') {
      assert.equal(ready.runtime.copy, true, 'This qualified configuration must select frame copying');
      assert.equal(!!ready.runtime.surface, false);
    }
    await page.evaluate(() => qaStartup.release?.());
    if (mode === 'late-device') await page.waitForFunction(() => qaStartup.devices[0].destroyed === 1);
    await page.waitForFunction(() => qaStartup.devices.every(device => device.rejected || device.destroyed === 1));
    await page.waitForFunction(() => qaStartup.bitmaps.every(bitmap => bitmap.closed === 1));
    // Once the probe finishes, exercise actual gameplay with the unmodified GPU
    // interfaces. Preserve device records to catch any late duplicate cleanup.
    await page.evaluate(() => {
      window.qaImages = 0;
      const present = Module.onPresent;
      Module.onPresent = (...args) => { ++qaImages; return present?.(...args); };
    });
    await page.click('#start');
    await page.waitForFunction(() => qaImages >= 35 || Module.failed, { timeout: 60000 });
    assert.equal(await page.evaluate(() => !!Module.failed), false);
    await page.evaluate(() => waitForPause());
    assert.equal(await page.evaluate(() => Module._ps2web_pause_ready()), 1);
    assert.equal((await snapshot()).probeCanvases, 0);
    const unexpected = logs.filter(log => !log.message.startsWith('[gpu check] '));
    assert.deepEqual(unexpected, []);
    if (mode === 'normal' || mode === 'held-animation' || mode === 'blank-snapshot') assert.deepEqual(logs, []);
    else assert(logs.some(log => log.message.includes(mode.includes('rejected') ? 'QA first presentation' : 'presentation check timed out')));
    const result = { mode, browser: firefox ? 'firefox' : 'chromium', readyMs, ready, final: await snapshot(), logs };
    results.push(result);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    await page.screenshot({ path: path.join(output, mode + '.png') });
    await page.evaluate(() => stopPlayerForReload());
    console.log('PASS', mode, readyMs + 'ms');
    await context.close();
    page = null;
  }
  await browser.close();
  browser = null;
})().catch(async error => {
  const failure = { mode: current, error: error.stack, logs };
  try {
    if (page) { failure.state = await snapshot(); await page.screenshot({ path: path.join(output, 'failure.png') }); }
  } catch (diagnosticError) { failure.diagnosticError = diagnosticError.message; }
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify(failure, null, 2));
  console.error(error);
  if (browser) await browser.close();
  process.exitCode = 1;
});
