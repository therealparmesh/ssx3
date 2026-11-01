const fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const p = require(process.env.PUPPETEER_MODULE || 'puppeteer-core');
const kind = process.argv[2] || 'chrome';
assert(['chrome', 'firefox'].includes(kind), 'Choose chrome or firefox');
const out = process.env.SSX3_TEST_OUTPUT || fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ssx3-gl-state-'));
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await p.launch({
    ...(kind === 'firefox' ? { browser: 'firefox' } : {}),
    executablePath: kind === 'firefox'
      ? process.env.SSX3_FIREFOX_BIN || '/usr/bin/firefox'
      : process.env.SSX3_CHROMIUM_BIN || '/usr/bin/chromium',
    headless: false,
  });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (['error', 'warn', 'warning'].includes(message.type())) errors.push(message.text());
    });
    await page.setContent('<!doctype html><title>GL state guard checks</title><canvas></canvas><pre></pre>');
    for (const file of ['state_guard.js', 'state_guard_fixture.js'])
      await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../tests/webgl_backend', file), 'utf8') });
    const result = await page.evaluate(() => fixtureResult);
    // The selected public bridge has no reserved-unit caches. Installing the
    // diagnostic must still exercise depth checks and report absent capabilities.
    const compatibilityPage = await browser.newPage();
    await compatibilityPage.setContent('<!doctype html><title>Bridge compatibility</title>');
    for (const file of ['runtime/src/gs/webgl/ordered_raster.js', 'tests/webgl_backend/state_guard.js'])
      await compatibilityPage.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '..', file), 'utf8') });
    const compatibility = await compatibilityPage.evaluate(() => {
      ssx3GlStateGuard.install();
      return ssx3GlStateGuard.snapshot();
    });
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ browser: await browser.version(), result, compatibility, errors }, null, 2) + '\n');
    await page.screenshot({ path: path.join(out, 'checks.png') });
    assert.deepEqual(errors, []);
    assert(!result.error, result.error);
    assert(result.passed);
    assert.equal(result.cases.length, 6);
    assert(result.cases.every(check => check.passed));
    assert.deepEqual(result.expectedErrors.map(error => error.kind), [
      'target-depth-attachment', 'cached-texture-binding', 'cached-sampler-binding',
    ]);
    assert.deepEqual(result.checks, { depth: 2, texture: 2, sampler: 2 });
    assert(compatibility.installed);
    assert.deepEqual(compatibility.capabilities, { depth: true, texture: false, sampler: false });
    assert.deepEqual(compatibility.errors, []);
    console.log(JSON.stringify({ browser: kind, passed: true, cases: result.cases.length, output: out }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
