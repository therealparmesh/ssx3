const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const engine = process.argv[2] || 'chromium';
assert(['chromium', 'firefox'].includes(engine));
const output = process.env.SSX3_WEBGL_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ssx3-coverage-'));
fs.mkdirSync(output, {recursive:true});
(async () => {
  const browser = await puppeteer.launch({
    ...(engine === 'firefox' ? {browser:'firefox'} : {}),
    executablePath: engine === 'firefox' ? process.env.SSX3_FIREFOX_BIN || '/usr/bin/firefox' : process.env.SSX3_CHROMIUM_BIN || '/usr/bin/chromium',
    headless: process.env.SSX3_WEBGL_HEADLESS === '1',
    defaultViewport:{width:1280,height:800},
  });
  try {
    for (const mode of ['positive','floatCoverageFault','hardwareCoverageFault']) {
      const page = await browser.newPage(), errors = [], warnings = [];
      try {
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (['warn','warning','error'].includes(message.type())) warnings.push(message.text()); });
        const url = new URL('coverage.html', process.env.SSX3_WEBGL_ORIGIN || 'http://127.0.0.1:8262/');
        if (mode !== 'positive') url.searchParams.set(mode,'1');
        await page.goto(url.href);
        await page.waitForFunction(() => globalThis.coverageResult, {timeout:120000});
        const result = await page.evaluate(() => coverageResult);
        fs.writeFileSync(path.join(output, `${engine}-${mode}.json`), JSON.stringify({browser:await browser.version(),url:url.href,explicitGpuOverrides:false,result,errors,warnings},null,2)+'\n');
        assert(!result.error,result.error);
        assert.equal(result.cases,2664);
        assert.equal(result.pixels,66600);
        assert.equal(result.glError,0);
        assert.deepEqual(errors,[]); assert.deepEqual(warnings,[]);
        if (mode === 'positive') {
          assert.equal(result.passed,true,JSON.stringify(result.failures[0]));
          assert.deepEqual(result.failures,[]);
        } else {
          assert.equal(result.passed,false,'Restored faulty coverage must fail the independent oracle');
          assert(result.failures.length>0);
        }
        console.log(`${engine}: ${mode} ${mode==='positive'?'2664 coverage cases passed':'detected'}`);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
