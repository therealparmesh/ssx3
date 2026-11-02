// Executes the asset-free C++ fixture against the actual GS renderer and shaders.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require(process.env.PUPPETEER_MODULE || 'puppeteer-core');
const kind = process.env.SSX3_TEST_BROWSER || 'firefox';
assert(['chrome', 'firefox'].includes(kind));
const base = new URL(process.env.SSX3_TEST_URL || 'http://127.0.0.1:8722/gpu_copy_readback.html');
const output = process.env.SSX3_TEST_OUTPUT || 'build/gpu-copy-readback';
let browser;
(async () => {
  fs.mkdirSync(output, { recursive: true });
  browser = await puppeteer.launch(kind === 'firefox'
    ? { browser: 'firefox', executablePath: process.env.FIREFOX_EXECUTABLE || '/usr/bin/firefox',
      headless: false, extraPrefsFirefox: { 'dom.webgpu.enabled': true } }
    : { browser: 'chrome', executablePath: process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium',
      headless: false, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
  const results = [], modes = ['normal', 'staged', 'scale2', 'negative-constant', 'negative-varying', 'read-failure'];
  if (process.env.SSX3_GPU_TEST_PROFILE === '1') modes.push('profile');
  for (const mode of modes) {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluateOnNewDocument((fault) => {
      // Firefox also installs init scripts in the initial, insecure blank tab.
      if (typeof GPUAdapter === 'undefined') return;
      window.qaConstantFaults = 0;
      window.qaTestReadFailures = fault === 'read-failure';
      const getRange = GPUBuffer.prototype.getMappedRange;
      window.qaExpectedReadFailures = 0;
      GPUBuffer.prototype.getMappedRange = function(...args) {
        if (window.qaProbe?.failNextRead) {
          qaProbe.failNextRead = false; ++qaExpectedReadFailures;
          throw new Error('Controlled mapped read failure');
        }
        return getRange.apply(this, args);
      };
      if (fault?.startsWith('negative-')) {
        const createShaderModule = GPUDevice.prototype.createShaderModule;
        GPUDevice.prototype.createShaderModule = function(descriptor) {
          const fixed = 'return select(value, a, (a == b) & (a == c));';
          if (descriptor.code.includes(fixed)) {
            descriptor = {...descriptor, code: descriptor.code.replace(fixed,
              fault === 'negative-varying' ? 'return a;' : 'return value;')};
            ++qaConstantFaults;
          }
          return createShaderModule.call(this, descriptor);
        };
      }
      window.qaGpu = { encoders: 0, commandBuffers: 0, submissions: 0, computePasses: 0, copies: 0 };
      const request = GPUAdapter.prototype.requestDevice;
      GPUAdapter.prototype.requestDevice = async function () {
        const device = await request.apply(this, arguments);
        window.qaDevice = device;
        device.pushErrorScope('validation');
        return device;
      };
      for (const [prototype, key, field] of [
        [GPUDevice.prototype, 'createCommandEncoder', 'encoders'],
        [GPUCommandEncoder.prototype, 'finish', 'commandBuffers'],
        [GPUQueue.prototype, 'submit', 'submissions'],
        [GPUCommandEncoder.prototype, 'beginComputePass', 'computePasses'],
        [GPUCommandEncoder.prototype, 'copyBufferToBuffer', 'copies'],
      ]) {
        const original = prototype[key];
        prototype[key] = function () { ++qaGpu[field]; return original.apply(this, arguments); };
      }
    }, mode);
    const url = new URL(base);
    url.search = mode === 'staged' ? '?staged' : mode === 'scale2' ? '?scale=2' : mode === 'profile' ? '?profile' : '';
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => qaProbe.result || qaProbe.errors.length, { timeout: 60000 });
    const result = await page.evaluate(async () => ({ native: qaProbe.result, errors: qaProbe.errors,
      messages: qaProbe.messages, gpu: qaGpu, constantFaults: qaConstantFaults, expectedReadFailures: qaExpectedReadFailures, validation: await qaDevice.popErrorScope(),
      uploads: Module.uploadBuffers?.stats,
      profileBytes: FS.analyzePath('/profile.txt').exists ? FS.readFile('/profile.txt').length : 0,
      futures: Object.keys(WebGPU.Internals.futures).length }));
    result.browser = kind; result.mode = mode; result.pageErrors = errors;
    results.push(result);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    assert.equal(result.validation, null);
    if (mode.startsWith('negative-')) {
      assert.equal(result.constantFaults, 1, 'Inject the legacy interpolation into the real shader');
      assert.equal(result.native, null);
      assert(result.errors.some(text => text.includes(mode === 'negative-varying' ? 'PROBE_FAIL: Varying red and constant green/blue remain exact' : 'PROBE_FAIL: GS fade and modulation pixels')),
        'Detect wrong color pixels with valid GPU operations');
      await page.evaluate(() => { Module.onHalt = () => {}; Module.uploadBuffers?.dispose(); qaDevice.destroy(); });
      await page.close();
      console.log('PASS', mode, 'incorrect interpolation rejected');
      continue;
    }
    assert.deepEqual(result.errors, []);
    assert.deepEqual(errors, []);
    assert.equal(result.native?.passed, true);
    assert.equal(result.native.frames, 64);
    assert.equal(result.native.scale, mode === 'scale2' ? 2 : 1);
    assert.equal(result.native.synchronous, true);
    assert.equal(result.native.modulationCases, 4);
    assert.equal(result.native.fadeCases, 3);
    assert.equal(result.native.constantAlphaCases, 1);
    assert.equal(result.native.varyingColorCases, 3);
    assert.equal(result.native.combinedFadeTint, true);
    assert.equal(result.native.failedReadbackCases, mode === 'read-failure' ? 2 : 0);
    assert.equal(result.expectedReadFailures, mode === 'read-failure' ? 2 : 0);
    assert(result.native.nonzeroSourceOffset >= 8192);
    if (mode === 'staged') assert(result.uploads.staged > 0, 'Exercise actual mapped staging');
    if (mode === 'profile') assert(result.profileBytes > 0, 'Profiling test requires GPU timestamp-query support');
    console.log('PASS', mode, JSON.stringify({ native: result.native, gpu: result.gpu }));
    // Destroy only the device created by this fixture, after collecting errors.
    await page.evaluate(() => { Module.onHalt = () => {}; Module.uploadBuffers?.dispose(); qaDevice.destroy(); });
    await page.close();
  }
  await browser.close(); browser = null;
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { if (browser) await browser.close(); });
