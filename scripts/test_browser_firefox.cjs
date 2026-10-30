const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const puppeteer = require(process.env.PUPPETEER_MODULE || 'puppeteer-core');
const base = process.env.SSX3_TEST_URL || 'http://127.0.0.1:8679';
const output = process.env.SSX3_TEST_OUTPUT || '/tmp/ssx3-firefox';
const cardPath = path.resolve(process.env.SSX3_TEST_CARD);
const card = fs.readFileSync(cardPath);
const hash = crypto.createHash('sha256').update(card).digest('hex');
const headless = process.env.SSX3_TEST_HEADLESS !== '0';
let browser, page;
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const prefs = process.env.SSX3_FIREFOX_WEBGPU === '1' ? { 'dom.webgpu.enabled': true } : {};
  browser = await puppeteer.launch({ browser: 'firefox', executablePath: process.env.FIREFOX_EXECUTABLE || '/usr/bin/firefox',
    headless, networkEnabled: false, extraPrefsFirefox: prefs, defaultViewport: { width: 1280, height: 800 } });
  page = await browser.newPage();
  if (process.env.SSX3_TEST_DISABLE_JSPI === '1') await page.evaluateOnNewDocument(() => {
    Object.defineProperty(WebAssembly, 'Suspending', { configurable: true, value: undefined });
    Object.defineProperty(WebAssembly, 'promising', { configurable: true, value: undefined });
  });
  const errors = [], warnings = [], checks = [], diagnostics = [];
  let phase = 'startup';
  await page.evaluateOnNewDocument(() => {
    window.addEventListener('error', event => console.log('QA lifecycle error ' + JSON.stringify({ message: event.message, file: event.filename, stopped: !!globalThis.Module?.stoppedForReload, detail: String(event.error), stack: event.error?.stack })));
    window.addEventListener('unhandledrejection', event => console.log('QA lifecycle rejection ' + JSON.stringify({ stopped: !!globalThis.Module?.stoppedForReload, detail: String(event.reason), stack: event.reason?.stack })));
  });
  page.on('pageerror', error => errors.push({ phase, message: error.message, stack: error.stack }));
  page.on('console', message => {
    if (message.text().startsWith('QA lifecycle ')) diagnostics.push({ phase, text: message.text() });
    const expected = ['Player stopped QA Firefox runtime recovery', 'Player stopped The graphics connection was lost. Export your memory card, then reload.'];
    if (['error', 'warn', 'warning'].includes(message.type()) && !expected.includes(message.text())) warnings.push(message.text());
  });
  const ready = async () => {
    await page.waitForFunction(() => document.querySelector('#start')?.textContent === 'Play SSX 3' && !document.querySelector('#start').disabled, { timeout: 120000 });
    assert.equal(await page.$eval('#start', element => element.textContent), 'Play SSX 3', await page.$eval('#help', element => element.textContent));
    if (process.env.SSX3_TEST_EXPECT_SURFACE === '1') {
      assert.equal(await page.evaluate(() => Module.presentCopy), false);
      assert.equal(await page.evaluate(() => Module.bufferedSurface), true);
    }
  };
  const cardHash = () => page.evaluate(async () => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', FS.readFile('/memcard/Mcd001.ps2')))).map(x => x.toString(16).padStart(2, '0')).join(''));
  const reloadBy = async (action, label) => {
    phase = label;
    const origin = await page.evaluate(() => performance.timeOrigin);
    await action();
    await page.waitForFunction(old => performance.timeOrigin !== old, {}, origin);
    await ready();
    assert.equal(await cardHash(), hash);
  };
  const play = async () => {
    await page.click('#start');
    await page.waitForFunction(() => Module.failed || Module._ps2web_frames() > 6150, { timeout: 120000 });
    assert.equal(await page.evaluate(() => !!Module.failed), false);
  };
  const pause = async () => { await page.click('#pause'); await page.waitForFunction(() => Module._ps2web_pause_ready() === 1); };
  await page.goto(base + '/?state=test.state');
  await ready();
  const surface = await page.evaluate(() => !Module.presentCopy);
  assert.equal(await page.title(), 'SSX 3');
  assert.equal(await page.evaluate(() => crossOriginIsolated && cardStorageOwned), true);
  await page.evaluate(async encoded => {
    FS.writeFile('/memcard/Mcd001.ps2', Uint8Array.from(atob(encoded), c => c.charCodeAt(0)));
    await new Promise((resolve, reject) => storeCard(error => error ? reject(error) : resolve()));
  }, card.toString('base64'));
  await play();
  checks.push('startup and gameplay');
  if (surface) {
    assert.equal(await page.evaluate(() => Module.surfaceFrames.length + Module.surfaceFree.length), 3);
    checks.push('bounded GPU presentation pool');
  }
  await page.evaluate(() => {
    window.qaPads = [];
    window.addEventListener('keydown',e=>window.qaLastKey={code:e.code,key:e.key,alt:e.altKey,control:e.ctrlKey,target:e.target.tagName});
    const pad = Module._ps2web_pad;
    Module._ps2web_pad = (...args) => { qaPads.push(args); return pad(...args); };
  });
  await page.keyboard.down('ArrowLeft'); await page.keyboard.down('z');
  await page.waitForFunction(() => qaPads.some(x => x[0] === 0 && (x[1] & 0x4080) === 0x4080 && x[2] === 128));
  await page.keyboard.up('z'); await page.keyboard.up('ArrowLeft');
  await page.evaluate(() => {
    const pad = index => ({ index, id: 'QA standard controller', mapping: 'standard', connected: true,
      axes: [-1, 0, 0, 0], buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === 0, value: i === 0 ? 1 : 0 })) });
    window.qaGamepads = [pad(0), pad(1)];
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => qaGamepads });
  });
  await page.waitForFunction(() => qaPads.filter(x => x[0] === 1).at(-1)?.[1] === 0x4000);
  await page.evaluate(() => { qaGamepads[0] = null; });
  await page.waitForFunction(() => qaPads.filter(x => x[0] === 0).at(-1)?.[1] === 0);
  assert.equal(await page.evaluate(() => qaPads.filter(x => x[0] === 1).at(-1)[1]), 0x4000);
  await page.evaluate(() => { qaGamepads = []; });
  checks.push('keyboard and stable two-controller assignment');
  const assertKey = async (key, mask, axes = [128, 128, 128, 128]) => {
    phase = 'keyboard binding '+JSON.stringify(key);
    await page.keyboard.down(key);
    await page.waitForFunction((mask, axes) => {
      const p = qaPads.filter(x => x[0] === 0).at(-1);
      return p && p[1] === mask && p.slice(2).every((v, i) => v === axes[i]);
    }, {timeout:3000}, mask, axes).catch(async error => {
      const state = await page.evaluate(() => ({focus:document.activeElement?.tagName,focused:inputFocused,hidden:document.hidden,keys:Array.from(keys),last:qaPads.filter(x=>x[0]===0).at(-1),event:qaLastKey}));
      throw new Error('Binding '+JSON.stringify(key)+' failed: '+JSON.stringify(state),{cause:error});
    });
    await page.keyboard.up(key);
    await page.waitForFunction(() => qaPads.filter(x => x[0] === 0).at(-1)?.slice(1).every((v, i) => v === (i ? 128 : 0)));
  };
  for (const [key, mask] of [[' ',0x4000],['k',0x4000],['i',0x1000],['j',0x8000],['l',0x2000],['q',0x400],['e',0x800],['1',0x100],['3',0x200],['2',2],['4',4],['Enter',8],['Backspace',1]]) await assertKey(key,mask);
  for (const [key, axes] of [['w',[128,0,128,128]],['a',[0,128,128,128]],['s',[128,255,128,128]],['d',[255,128,128,128]],['t',[128,128,128,0]],['f',[128,128,0,128]],['g',[128,128,128,255]],['h',[128,128,255,128]]]) await assertKey(key,0,axes);
  for (const [key, mask] of [['ArrowUp',0x10],['ArrowRight',0x20],['ArrowDown',0x40],['ArrowLeft',0x80]]) await assertKey(key,mask);
  await page.keyboard.down('a'); await page.keyboard.down('ArrowRight');
  await page.waitForFunction(() => { const p=qaPads.filter(x=>x[0]===0).at(-1); return p?.[1]===0x20 && p[2]===0; });
  await page.keyboard.up('a'); await page.keyboard.up('ArrowRight');
  assert.equal(await page.evaluate(() => fullscreen),false);
  await page.keyboard.down('a'); await page.keyboard.down('d');
  await page.waitForFunction(() => qaPads.filter(x => x[0] === 0).at(-1)?.[2] === 128);
  await page.keyboard.up('a'); await page.keyboard.up('d');
  await page.keyboard.down('Alt'); await page.keyboard.press('Enter'); await page.keyboard.up('Alt');
  await page.waitForFunction(() => fullscreen);
  assert.equal(await page.evaluate(() => qaPads.filter(x => x[0] === 0).at(-1)[1] & 8),0);
  await page.click('#exit-fullscreen');
  await page.waitForFunction(() => !fullscreen && !nativeFullscreen());
  await page.focus('#canvas');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => Module.paused && Module._ps2web_pause_ready() === 1,{timeout:3000}).catch(async error=>{throw new Error('Escape pause failed: '+JSON.stringify(await page.evaluate(()=>({event:qaLastKey,paused:Module.paused,fullscreen,native:!!nativeFullscreen()}))),{cause:error})});
  const escapeFrame=await page.evaluate(() => Module._ps2web_frames());
  await page.keyboard.press('Escape');
  await page.waitForFunction(frame => !Module.paused && Module._ps2web_frames() > frame+15,{},escapeFrame);
  checks.push('PCSX2-style keys, Space, both sticks, opposing keys, isolated fullscreen and Escape pause/resume');

  await pause();
  const frame = await page.evaluate(() => Module._ps2web_frames());
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await page.evaluate(() => Module._ps2web_frames()), frame);
  await page.screenshot({ path: path.join(output, 'paused.png') });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  assert.equal(await page.evaluate(() => !!Module.stoppedForReload), false);
  await page.click('#start');
  await page.waitForFunction(previous => Module._ps2web_frames() > previous + 20, {}, frame);
  await pause();
  checks.push('pause acknowledgement and cached-page resume');
  await reloadBy(() => page.reload(), 'browser refresh');
  await play(); await pause();
  checks.push('browser refresh and exact card persistence');
  if (surface) {
    phase = 'native surface resize';
    const beforeResize = await page.evaluate(() => Module._ps2web_frames());
    await page.click('#start');
    await page.setViewport({ width: 1024, height: 768 });
    await page.waitForFunction(previous => innerWidth === 1024 && Module._ps2web_frames() > previous + 30, {}, beforeResize);
    assert.equal(await page.evaluate(() => !!Module.failed), false);
    await pause();
    await page.screenshot({ path: path.join(output, 'surface-resized.png') });
    await reloadBy(() => page.reload(), 'native surface resize refresh');
    checks.push('native surface resize and browser refresh');
  } else {
    await page.evaluate(() => {
      const map = GPUBuffer.prototype.mapAsync;
      GPUBuffer.prototype.mapAsync = function(...args) {
        const result = map.apply(this, args);
        if (this.size > 16 && !window.qaHeldReadback) { window.qaHeldReadback = true; return result.then(() => new Promise(() => {})); }
        return result;
      };
    });
    await page.click('#start');
    await page.waitForFunction(() => window.qaHeldReadback === true);
    await reloadBy(() => page.reload(), 'pending readback refresh');
    checks.push('refresh during pending graphics readback');
  }
  page.once('dialog', dialog => dialog.accept());
  await reloadBy(async () => (await page.$('#import-file')).uploadFile(cardPath), 'card import');
  checks.push('card import');
  await play(); await pause();
  await page.evaluate(() => waitForCard());
  await page.evaluate(() => failPlayer('QA Firefox runtime recovery'));
  await reloadBy(() => page.click('#start'), 'runtime recovery');
  checks.push('runtime failure recovery');
  if (surface) {
    await play(); await pause();
    await page.evaluate(() => waitForCard());
    phase = 'graphics device loss';
    await page.evaluate(() => Object.values(WebGPU.Internals.jsObjects).find(object => object instanceof GPUDevice).destroy());
    await page.waitForFunction(() => Module.failed === true);
    await reloadBy(() => page.click('#start'), 'graphics device recovery');
    checks.push('graphics device loss recovery');
  }
  await reloadBy(async () => { await page.click('#overlay-options'); await page.select('#effects', 'original'); }, 'original visual effects');
  assert.equal(await page.evaluate(() => Module.fullEffects), true);
  assert.equal(await page.$eval('#effects', element => element.value), 'original');
  await play(); await pause();
  await reloadBy(async () => { await page.click('#overlay-options'); await page.select('#effects', 'performance'); }, 'performance visual effects');
  assert.equal(await page.evaluate(() => Module.fullEffects), false);
  assert.equal(await page.$eval('#effects', element => element.value), 'performance');
  checks.push('both visual settings reload with exact card persistence');
  await reloadBy(async () => { await page.click('#overlay-options'); await page.select('#boot', 'original'); }, 'full startup setting');
  assert.equal(await page.evaluate(() => Module.fastBoot),false);
  await reloadBy(async () => { await page.click('#overlay-options'); await page.select('#boot', 'quick'); }, 'quick startup setting');
  assert.equal(await page.evaluate(() => Module.fastBoot),true);
  checks.push('startup mode reloads with exact card persistence');

  const beforeFailedSetting = await page.evaluate(() => performance.timeOrigin);
  const warningCount = warnings.length;
  await page.evaluate(() => {
    window.qaEffectsSync = FS.syncfs;
    FS.syncfs = (populate, done) => done(new Error('QA effects save failure'));
    storeCard(); clearTimeout(cardTimer);
  });
  await page.click('#overlay-options'); await page.select('#effects', 'original');
  await page.waitForFunction(() => document.querySelector('#help').textContent.includes('latest save could not be stored'));
  assert.equal(await page.evaluate(() => performance.timeOrigin), beforeFailedSetting);
  assert.equal(await page.evaluate(() => localStorage.getItem('ps2web-effects')), 'performance');
  assert.equal(await page.$eval('#effects', element => element.value), 'performance');
  await page.select('#boot', 'original');
  await new Promise(resolve => setTimeout(resolve,200));
  assert.equal(await page.evaluate(() => performance.timeOrigin),beforeFailedSetting);
  assert.equal(await page.evaluate(() => localStorage.getItem('ps2web-boot')),'quick');
  assert.equal(await page.$eval('#boot', element => element.value),'quick');
  await page.evaluate(async () => { FS.syncfs = qaEffectsSync; await waitForCard(); });
  assert.equal(await cardHash(), hash);
  assert.equal(warnings.length, warningCount + 2);
  assert.match(warnings.pop(), /^memory card: browser storage failed/);
  assert.match(warnings.pop(), /^memory card: browser storage failed/);
  checks.push('failed save blocks visual/startup reload and preference mutation');
  const result = { browser: await browser.version(), prefs, headless, surface, checks, cardSha256: hash, errors, warnings, diagnostics, compat: process.env.SSX3_TEST_DISABLE_JSPI === '1' };
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []); assert.deepEqual(warnings, []); assert.deepEqual(diagnostics, []);
  await browser.close(); browser = null;
})().catch(async error => {
  console.error(error);
  if (page) { const state = await page.evaluate(() => ({ help: document.querySelector('#help')?.textContent, start: document.querySelector('#start')?.textContent, failed: !!Module.failed, stopped: !!Module.stoppedForReload, pending: hasPendingRuntimeCard(), revision: cardRevision, saved: savedCardRevision })).catch(error => ({ error: error.message })); fs.writeFileSync(path.join(output, 'failure-state.json'), JSON.stringify(state, null, 2)); }
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
}).finally(async () => { if (browser) await browser.close(); });
