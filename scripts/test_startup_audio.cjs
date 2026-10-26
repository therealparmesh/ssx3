const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const shell = fs.readFileSync(path.join(__dirname, '../web/shell.html'), 'utf8');
function section(start, end) {
  const a = shell.indexOf(start), b = shell.indexOf(end, a);
  assert(a >= 0 && b > a); return shell.slice(a, b);
}
const audioSource = section('let audio = null,', 'const keys = new Set();');
const stopSource = section('let stopForReload = null;', 'async function discSize()');
const playSource = section("document.getElementById('start').addEventListener('click', async () => {", '\n</script>');
const drain = async () => { for (let i = 0; i < 6; ++i) await Promise.resolve(); };

function deferred() {
  let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const contexts = [], outputs = [], urls = new Set(), revocations = [], mainCalls = [], warnings = [];
  const elements = new Map(), documentEvents = new Map();
  const faults = {};
  const element = id => {
    if (!elements.has(id)) elements.set(id, { hidden: id === 'pause', disabled: false, open: false,
      textContent: id === 'start' ? 'Play SSX 3' : '', listeners: new Map(),
      addEventListener(type, fn) { this.listeners.set(type, fn); } });
    return elements.get(id);
  };
  class Context {
    constructor() {
      if (faults.construct) throw Error('Audio context unavailable');
      this.state = 'suspended'; this.events = new Map(); this.module = deferred(); this.resumeRequest = deferred();
      this.closeCalls = this.resumeCalls = 0;
      this.audioWorklet = { addModule: () => this.module.promise }; contexts.push(this);
    }
    addEventListener(type, fn) { this.events.set(type, fn); }
    resume() { ++this.resumeCalls; return this.resumeRequest.promise; }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { ++this.closeCalls; this.state = 'closed'; return Promise.resolve(); }
    completeResume(state = 'running') { if (this.state !== 'closed') this.state = state; this.resumeRequest.resolve(); }
    emit(state) { this.state = state; this.events.get('statechange')(); }
  }
  const Module = { running: false, paused: false, failed: false, HEAPU8: new Uint8Array(8), arguments: [],
    _ps2web_audio_ring: () => 0, _ps2web_pause() {},
    callMain() { mainCalls.push({ hidden: document.hidden, failed: Module.failed }); },
  };
  const document = { hidden: false, getElementById: element,
    addEventListener(type, fn) { documentEvents.set(type, fn); } };
  const context = vm.createContext({ Module, document,
    AudioContext: Context, AudioWorkletNode: class {
      constructor(audio) { if (faults.node) throw Error('Worklet node unavailable'); this.audio = audio; outputs.push(this); }
      connect() { if (faults.connect) throw Error('Output unavailable'); this.connected = true; }
    },
    URL: { createObjectURL() { const url = 'blob:' + contexts.length; urls.add(url); return url; },
      revokeObjectURL(url) { assert(urls.delete(url), 'Blob URL must be revoked exactly once'); revocations.push(url); } },
    Blob: class {}, workletSource: '', statusEl: {}, canvas: { focus() {} },
    cardImportBusy: false, cardRecovery: null, fullscreen: false, startupTimer: 0, noteTimer: 0,
    releaseInput() {}, flushCard() {}, hasPendingRuntimeCard: () => false, clearTimeout() {}, stopCompiler() {},
    fitCanvas() {}, note() {}, console: { warn: (...args) => warnings.push(args) },
  });
  vm.runInContext(audioSource + stopSource + playSource, context);
  return { Module, context, contexts, outputs, urls, revocations, mainCalls, faults, warnings, element,
    begin() { return element('start').listeners.get('click')(); },
    hide(hidden = true) { document.hidden = hidden; documentEvents.get('visibilitychange')(); },
    fail() { vm.runInContext("failPlayer('Failure while starting')", context); },
    stop() { return vm.runInContext('stopPlayerForReload()', context); },
    async ready(index = contexts.length - 1) { contexts[index].module.resolve(); await drain(); },
    async complete(task, index = contexts.length - 1, state = 'running') {
      await this.ready(index); contexts[index].completeResume(state); await task;
    },
    globalAudio() { return vm.runInContext('audio', context); },
    start: element('start'),
  };
}

(async () => {
  let scenarios = 0;
  {
    const f = fixture(), task = f.begin();
    assert.equal(f.mainCalls.length, 0); await f.complete(task);
    assert.equal(f.mainCalls.length, 1); assert.equal(f.Module.running, true);
    assert.equal(f.outputs.length, 1); assert.equal(f.outputs[0].connected, true);
    assert.equal(f.urls.size, 0); ++scenarios;
  }
  {
    const f = fixture(), task = f.begin(); f.hide();
    assert.equal(f.start.disabled, false, 'Hiding during worklet loading must make Play available for a later retry');
    assert.equal(f.contexts[0].state, 'closed', 'Cancelled startup must release its audio context immediately');
    assert.equal(f.urls.size, 0, 'Cancelled startup must release its worklet URL without waiting for loading');
    await f.ready(); await task;
    assert.equal(f.contexts[0].resumeCalls, 0); assert.equal(f.mainCalls.length, 0); assert.equal(f.outputs.length, 0); ++scenarios;
  }
  {
    const f = fixture(), task = f.begin(); await f.ready(); f.hide(); f.contexts[0].completeResume(); await task;
    assert.equal(f.mainCalls.length, 0, 'Audio completion must not start a hidden game');
    assert.equal(f.outputs.length, 0); assert.equal(f.Module.running, false); ++scenarios;
  }
  {
    const f = fixture(), old = f.begin(); await f.ready(); f.hide(); f.hide(false);
    const current = f.begin(); await f.ready(1);
    f.contexts[0].completeResume(); await old;
    assert.equal(f.mainCalls.length, 0, 'A stale successful completion cannot start the newer request');
    assert.equal(f.globalAudio(), f.contexts[1]); assert.equal(f.start.disabled, true);
    f.contexts[1].completeResume(); await current;
    assert.equal(f.mainCalls.length, 1); assert.equal(f.outputs.length, 1);
    assert.equal(f.outputs[0].audio, f.contexts[1]); assert.equal(f.contexts[0].closeCalls, 1); ++scenarios;
  }
  for (const phase of ['module', 'resume']) {
    const f = fixture(), old = f.begin(); if (phase === 'resume') await f.ready(); f.hide(); f.hide(false);
    const current = f.begin(); await f.ready(1);
    f.contexts[0][phase === 'module' ? 'module' : 'resumeRequest'].reject(Error('Old request rejected')); await old;
    assert.equal(f.start.disabled, true, 'Stale errors cannot enable Play during the current request');
    assert.equal(f.warnings.length, 0); assert.equal(f.globalAudio(), f.contexts[1]);
    f.contexts[1].completeResume(); await current; assert.equal(f.mainCalls.length, 1); ++scenarios;
  }
  for (const phase of ['module', 'resume']) {
    const f = fixture(), task = f.begin(); if (phase === 'resume') await f.ready(); f.fail();
    if (phase === 'module') await f.ready(); else f.contexts[0].completeResume(); await task;
    assert.equal(f.mainCalls.length, 0, 'An asynchronous startup must not revive a failed player');
    assert.equal(f.element('overlay').hidden, false); assert.equal(f.start.textContent, 'Reload player');
    assert.equal(f.context.statusEl.textContent, 'Player stopped'); assert.equal(f.contexts[0].state, 'closed'); ++scenarios;
  }
  {
    const f = fixture(), task = f.begin(); await f.stop(); await f.ready(); await task;
    assert.equal(f.mainCalls.length, 0, 'Reload must cancel startup even before a native runtime exists'); ++scenarios;
  }
  for (const phase of ['module', 'resume']) {
    const f = fixture(), task = f.begin(); if (phase === 'resume') await f.ready();
    f.contexts[0][phase === 'module' ? 'module' : 'resumeRequest'].reject(Error('Audio unavailable')); await task;
    assert.equal(f.start.disabled, false); assert.equal(f.Module.running, false);
    assert.equal(f.contexts[0].state, 'closed'); assert.equal(f.urls.size, 0); assert.equal(f.globalAudio(), null);
    assert(f.element('help').textContent.includes('Could not start audio'));
    const retry = f.begin(); await f.complete(retry); assert.equal(f.mainCalls.length, 1); ++scenarios;
  }
  for (const fault of ['construct', 'node', 'connect']) {
    const f = fixture(); f.faults[fault] = true; const task = f.begin();
    if (fault === 'construct') await task; else await f.complete(task);
    assert.equal(f.mainCalls.length, 0); assert.equal(f.start.disabled, false); assert.equal(f.urls.size, 0);
    assert.equal(f.globalAudio(), null); assert(f.contexts.every(c => c.state === 'closed'));
    delete f.faults[fault]; const retry = f.begin(); await f.complete(retry); assert.equal(f.mainCalls.length, 1); ++scenarios;
  }
  {
    const f = fixture(), task = f.begin(); await f.complete(task, 0, 'interrupted');
    assert.equal(f.mainCalls.length, 0, 'Initial startup requires running audio');
    assert.equal(f.contexts[0].state, 'closed'); assert.equal(f.start.disabled, false); ++scenarios;
  }
  {
    const f = fixture(), first = f.begin(), duplicate = f.begin();
    assert.equal(f.contexts.length, 1, 'Repeated Play actions must share one active startup');
    await duplicate; await f.complete(first); assert.equal(f.mainCalls.length, 1);
    await f.begin(); assert.equal(f.mainCalls.length, 1, 'Play cannot invoke main twice after successful startup'); ++scenarios;
  }
  {
    const f = fixture(); f.hide(); await f.begin(); assert.equal(f.contexts.length, 0); ++scenarios;
  }
  console.log(`Audio startup: ${scenarios} regression scenarios passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
