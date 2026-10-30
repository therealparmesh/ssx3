#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

(async () => {
  const kind = process.argv[2] || 'chromium';
  assert(['chromium', 'firefox'].includes(kind), 'Choose chromium or firefox');
  const origin = process.env.SSX3_WEBGL_BACKEND_ORIGIN || 'http://127.0.0.1:8264/';
  const artifacts = process.env.SSX3_WEBGL_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'gs-backend-'));
  fs.mkdirSync(artifacts, {recursive: true});
  const browser = await puppeteer.launch({
    ...(kind === 'firefox'
      ? {browser: 'firefox', executablePath: process.env.SSX3_FIREFOX_BIN || '/usr/bin/firefox'}
      : {executablePath: process.env.SSX3_CHROMIUM_BIN || '/usr/bin/chromium'}),
    headless: process.env.SSX3_WEBGL_HEADLESS === '1',
    defaultViewport: {width: 1024, height: 768}
  });
  const evidence = {browser: kind, version: await browser.version(), origin, explicitGpuOverrides: false, fixtures: []};
  try {
    for (const [fixture, cases, pixels] of [['population', null, 393216], ['readback', 16, 266488], ['restore', 24, 1572864], ['export', 21, null], ['export-hybrid', 21, null], ['alias', 6, 458752], ['alias-hybrid', 6, 458752]]) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
      const url = new URL(origin);
      const route = fixture.replace('-hybrid', '');
      url.searchParams.set('fixture', route);
      if (fixture.endsWith('-hybrid')) url.searchParams.set('ordered', '1');
      await page.goto(url.href, {waitUntil: 'load'});
      await page.waitForFunction(() => window.fixtureResult, {timeout: 60000});
      const result = await page.evaluate(() => ({result: window.fixtureResult, log: document.getElementById('log').textContent}));
      if (route === 'alias') {
        assert.equal(result.result.sameOwnerChecks, 2);
        assert(result.result.cachedChecks >= 8);
        assert.equal(result.result.controlChecks - result.result.cachedChecks, 128);
        assert(result.result.cachedBlitPixels < result.result.controlBlitPixels);
      }
      await page.screenshot({path: path.join(artifacts, `${kind}-${fixture}.png`)});
      assert.equal(await page.title(), 'GS backend verification');
      assert.equal(new URL(page.url()).searchParams.get('fixture'), route);
      assert(result.log.length > 40, 'Fixture did not render meaningful content');
      evidence.fixtures.push({fixture, ...result, errors});
      assert(!result.result.error, result.result.error);
      assert.equal(result.result.glError, 0);
      if (pixels !== null) assert.equal(result.result.pixels, pixels);
      if (cases !== null) assert.equal(result.result.cases, cases);
      else assert.equal(result.result.differentPixels, 0);
      if (route === 'export') {
        assert.equal(result.result.aliasRejected, true);
        assert.equal(result.result.z32Rejected, true);
      }
      if (fixture.endsWith('-hybrid')) assert(result.result.orderedBatches > 0, 'Hybrid export fell back to the native path');
      assert.deepEqual(errors, []);
      await page.close();
    }
    for (const ordered of [false, true]) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
      const url = new URL(origin);
      url.searchParams.set('fixture', 'export'); url.searchParams.set('mutant', 'skip-sync');
      if (ordered) url.searchParams.set('ordered', '1');
      await page.goto(url.href, {waitUntil: 'load'});
      await page.waitForFunction(() => window.fixtureResult, {timeout: 60000});
      const result = await page.evaluate(() => window.fixtureResult);
      evidence.fixtures.push({fixture: ordered ? 'export-hybrid-skip-sync' : 'export-skip-sync', expectedFailure: true, result, errors});
      assert.match(result.error || '', /GPU export differs from expected VRAM/);
      assert.equal(result.glError, 0); assert.deepEqual(errors, []);
      await page.close();
    }
    console.log(`PASS ${kind}: population, readback, restore, native/hybrid export, bounded depth aliases and two negative controls; evidence ${artifacts}`);
  } finally {
    fs.writeFileSync(path.join(artifacts, `${kind}-backend.json`), JSON.stringify(evidence, null, 2) + '\n');
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
