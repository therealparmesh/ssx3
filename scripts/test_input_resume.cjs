const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const shell = fs.readFileSync(path.join(__dirname, '../web/shell.html'), 'utf8');
const inputStart = shell.indexOf('const keys = new Set();');
const inputEnd = shell.indexOf('// some browsers cannot show a canvas', inputStart);
const pauseStart = shell.indexOf('function cancelResume() {');
const pauseEnd = shell.indexOf('async function startAudio(', pauseStart);
const audioListenerStart = shell.indexOf("  audio.addEventListener('statechange', () => {", pauseEnd);
const audioListenerEnd = shell.indexOf('  request.url =', audioListenerStart);
const stopStart = shell.indexOf('let stopForReload = null;');
const stopEnd = shell.indexOf('function failPlayer(', stopStart);
const failureStart = shell.indexOf('function failPlayer(message, error) {');
const failureEnd = shell.indexOf('async function discSize()', failureStart);
const resumeStart = shell.indexOf("document.getElementById('start').addEventListener('click', async () => {");
const resumeEnd = shell.indexOf('\n});\n</script>', resumeStart);
for (const [start, end] of [[inputStart, inputEnd], [pauseStart, pauseEnd], [audioListenerStart, audioListenerEnd],
  [stopStart, stopEnd], [failureStart, failureEnd], [resumeStart, resumeEnd]]) assert(start >= 0 && end > start);

function controller(index) {
  return { index, connected: true, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
}

function fixture() {
  const pads = [], nativePads = {}, nativePressure = {}, connected = {}, resumes = [], notes = [];
  const elements = new Map(), windowEvents = new Map(), documentEvents = new Map(), audioEvents = new Map(), audioRequests = [];
  let blocked = false, clock = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { hidden: false, open: false, disabled: false,
      listeners: new Map(), addEventListener(type, fn) { this.listeners.set(type, fn); } });
    return elements.get(id);
  };
  const Module = { running: true, paused: true, failed: false,
    _ps2web_pad(port, ...state) { nativePads[port] = state; },
    _ps2web_pressure(port, ...state) { nativePressure[port] = state; },
    _ps2web_pad_connected(port, value) { connected[port] = value; },
    _ps2web_rumble() { return 0; },
    _ps2web_pause(value) {
      if (!value) resumes.push(JSON.parse(JSON.stringify({ pads: nativePads, pressure: nativePressure, connected })));
    },
  };
  const context = vm.createContext({ Module,
    document: { hidden: false, getElementById: element, addEventListener(type, fn) {
      if (!documentEvents.has(type)) documentEvents.set(type, []); documentEvents.get(type).push(fn);
    } },
    window: { addEventListener(type, fn) { windowEvents.set(type, fn); } },
    navigator: { getGamepads() { if (blocked) throw Error('Controller access denied'); return pads; } },
    performance: { now: () => ++clock },
    audio: { state: 'suspended',
      resume: () => new Promise((resolve, reject) => { audioRequests.push({ resolve, reject }); }),
      suspend() { this.state = 'suspended'; return Promise.resolve(); },
      addEventListener(type, fn) { audioEvents.set(type, fn); },
    },
    fingers: new Map(), touchPad: { buttons: 0, stick: false }, knob: { style: {} },
    touchRoot: { querySelectorAll: () => [] }, canvas: { focus() {} }, statusEl: {},
    fullscreen: false, cardImportBusy: false, flushCard() {}, hasPendingRuntimeCard: () => false,
    startupTimer: 0, noteTimer: 0, clearTimeout() {}, stopCompiler() {}, cardRecovery: null,
    resetFrameStats() {}, note: message => notes.push(message),
  });
  vm.runInContext('let pendingResume = null, pendingStartup = null;', context);
  vm.runInContext(shell.slice(inputStart, inputEnd), context);
  vm.runInContext(shell.slice(pauseStart, pauseEnd), context);
  vm.runInContext('(function(context) {' + shell.slice(audioListenerStart, audioListenerEnd) + '})(audio)', context);
  vm.runInContext(shell.slice(stopStart, stopEnd), context);
  vm.runInContext(shell.slice(failureStart, failureEnd), context);
  vm.runInContext(shell.slice(resumeStart, resumeEnd + '\n});'.length), context);
  const poll = () => vm.runInContext('pollInput()', context);
  return { Module, pads, nativePads, connected, resumes, notes, context,
    seed() { Module.paused = false; poll(); Module.paused = true; vm.runInContext('releaseInput()', context); },
    block() { blocked = true; },
    blur() { windowEvents.get('blur')(); },
    beginResume() { return element('start').listeners.get('click')(); },
    resolveAudio(index = audioRequests.length - 1, state = 'running') { context.audio.state = state; audioRequests[index].resolve(); },
    rejectAudio(index = audioRequests.length - 1) { audioRequests[index].reject(Error('Audio interrupted')); },
    hide(hidden = true) { context.document.hidden = hidden; for (const fn of documentEvents.get('visibilitychange')) fn(); },
    audioState(state) { context.audio.state = state; audioEvents.get('statechange')(); },
    fail() { vm.runInContext("failPlayer('Test failure')", context); },
    element,
    start: element('start'),
  };
}

function hold(pad, button, value = 1) { pad.buttons[button] = { pressed: true, value }; }
function pressure(snapshot, port, bit) { return (snapshot.pressure[port][bit >> 2] >>> ((bit & 3) * 8)) & 255; }
async function resume(f) {
  const task = f.beginResume();
  assert.equal(f.Module.paused, true, 'Audio must be ready before the native game resumes');
  assert.equal(f.resumes.length, 0);
  f.resolveAudio();
  await task;
  assert.equal(f.resumes.length, 1);
  return f.resumes[0];
}

(async () => {
  {
    const f = fixture(), first = f.pads[3] = controller(3), second = f.pads[7] = controller(7);
    f.seed();
    hold(first, 0); hold(first, 2, 0.5); first.axes = [0.45, -0.7, 0.25, -0.5];
    hold(second, 1); hold(second, 5); second.axes = [-0.6, 0.3, 0.8, -0.2];
    const state = await resume(f);
    assert.deepEqual(state.pads[0], [49152, 185, 38, 159, 64], 'Held player-one controls must reach native code before unpause');
    assert.deepEqual(state.pads[1], [10240, 51, 166, 230, 102], 'Held player-two controls must reach native code before unpause');
    assert.equal(pressure(state, 0, 14), 255);
    assert.equal(pressure(state, 0, 15), 128, 'Updated analog button pressure must also precede unpause');
  }
  {
    const f = fixture(), pad = f.pads[4] = controller(4);
    hold(pad, 0);
    const state = await resume(f);
    assert.equal(state.connected[0], 1, 'A controller first connected while paused must be discovered before unpause');
    assert.equal(state.pads[0][0], 16384);
  }
  {
    const f = fixture(); f.pads[3] = controller(3); const second = f.pads[7] = controller(7);
    f.seed(); f.pads[3] = null; hold(second, 1);
    const state = await resume(f);
    assert.equal(state.pads[0][0], 0);
    assert.equal(state.pads[1][0], 8192, 'Disconnecting player one must preserve the other controller on port two');
  }
  {
    const f = fixture(), first = f.pads[3] = controller(3); f.pads[7] = controller(7);
    f.seed(); f.pads[7] = null; hold(first, 0);
    const state = await resume(f);
    assert.equal(state.connected[1], 0, 'A controller disconnected while paused must be unplugged before unpause');
    assert.equal(state.pads[0][0], 16384);
    assert.equal(state.pads[1][0], 0);
  }
  {
    const f = fixture(); f.seed(); f.block();
    const state = await resume(f);
    assert.equal(state.pads[0][0], 0);
    assert.equal(f.notes.length, 1, 'Blocked controller access must retain the keyboard/touch fallback');
  }
  {
    const f = fixture(), pad = f.pads[3] = controller(3); f.seed(); hold(pad, 0);
    const task = f.beginResume(); f.rejectAudio(); await task;
    assert.equal(f.Module.paused, true);
    assert.equal(f.resumes.length, 0, 'Failed audio recovery must keep the native game paused');
    assert.deepEqual(f.nativePads[0], [0, 128, 128, 128, 128], 'Failed audio recovery must retain neutral native input');
    assert.equal(f.start.disabled, false);
    assert(f.notes[0].includes('Could not resume audio'));
  }
  {
    const f = fixture(), pad = f.pads[3] = controller(3); f.seed(); hold(pad, 0); f.blur();
    const state = await resume(f);
    assert.equal(state.pads[0][0], 0, 'A background window must not restore active controller input');
  }
  {
    const f = fixture(); const task = f.beginResume();
    f.hide();
    assert.equal(f.start.disabled, false, 'Backgrounding must allow a later user retry without waiting for audio');
    f.resolveAudio(); await task;
    assert.equal(f.Module.paused, true, 'A delayed audio promise must not restart a hidden game');
    assert.equal(f.resumes.length, 0);
  }
  {
    const f = fixture(); const task = f.beginResume(); f.hide(); f.hide(false);
    f.resolveAudio(); await task;
    assert.equal(f.resumes.length, 0, 'Returning to the tab must still require a fresh Resume action');
    const retry = f.beginResume(); f.resolveAudio(); await retry;
    assert.equal(f.resumes.length, 1);
  }
  {
    const f = fixture(); const task = f.beginResume(); f.fail();
    f.resolveAudio(); await task;
    assert.equal(f.resumes.length, 0, 'Audio recovery must not restart a failed player');
    assert.equal(f.element('overlay').hidden, false);
    assert.equal(f.start.textContent, 'Reload player');
    assert.equal(f.context.statusEl.textContent, 'Player stopped');
  }
  {
    const f = fixture(); const task = f.beginResume();
    Object.assign(f.Module, { stoppedForReload: true, running: false });
    f.resolveAudio(); await task;
    assert.equal(f.resumes.length, 0, 'A discarded runtime must stay stopped');
  }
  {
    const f = fixture(); const first = f.beginResume(); f.hide(); f.hide(false);
    const second = f.beginResume(); f.rejectAudio(0); await first;
    assert.equal(f.start.disabled, true, 'A stale rejection must not alter a newer resume');
    assert.equal(f.notes.length, 0);
    f.resolveAudio(1); await second; assert.equal(f.resumes.length, 1);
  }
  {
    const f = fixture(); const first = f.beginResume(); f.hide(); f.hide(false);
    const second = f.beginResume(); f.resolveAudio(0); await first;
    assert.equal(f.resumes.length, 0, 'A stale fulfillment must not unpause a newer attempt');
    assert.equal(f.start.disabled, true);
    f.resolveAudio(1); await second; assert.equal(f.resumes.length, 1);
  }
  {
    const f = fixture(); const task = f.beginResume(); const duplicate = f.beginResume();
    await duplicate; f.resolveAudio(); await task;
    assert.equal(f.resumes.length, 1, 'Repeated Escape or synthetic clicks must not queue duplicate resumes');
  }
  {
    const f = fixture(); const task = f.beginResume(); f.resolveAudio(0, 'interrupted'); await task;
    assert.equal(f.resumes.length, 0, 'Audio must actually be running at the unpause boundary');
    assert.equal(f.start.disabled, false); assert(f.notes[0].includes('Could not resume audio'));
  }
  {
    const f = fixture(); const task = f.beginResume();
    f.audioState('suspended'); // queued notification from the preceding pause
    f.resolveAudio(); await task;
    assert.equal(f.resumes.length, 1, 'The expected pause notification must not cancel a foreground resume');
    f.audioState('interrupted');
    assert.equal(f.Module.paused, true, 'An interruption after resume must pause the running player');
    assert.equal(f.element('overlay').hidden, false);
  }
  {
    const f = fixture(); const task = f.beginResume();
    await vm.runInContext('stopPlayerForReload()', f.context);
    f.resolveAudio(); await task;
    assert.equal(f.resumes.length, 0, 'Reload cancellation must also cover runtimes that need no explicit teardown');
  }
  {
    const f = fixture(); f.hide(); await f.beginResume();
    assert.equal(f.resumes.length, 0, 'Hidden documents must not begin a resume');
    assert.equal(f.start.disabled, false);
  }
  console.log('Input resume: 18 regression scenarios passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
