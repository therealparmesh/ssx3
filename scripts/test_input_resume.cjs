const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const shell = fs.readFileSync(path.join(__dirname, '../web/shell.html'), 'utf8');
const inputStart = shell.indexOf('const keys = new Set();');
const inputEnd = shell.indexOf('// some browsers cannot show a canvas', inputStart);
const resumeStart = shell.indexOf("document.getElementById('start').addEventListener('click', async () => {");
const resumeEnd = shell.indexOf('\n});\n</script>', resumeStart);
assert(inputStart >= 0 && inputEnd > inputStart && resumeStart >= 0 && resumeEnd > resumeStart);

function controller(index) {
  return { index, connected: true, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
}

function fixture() {
  const pads = [], nativePads = {}, nativePressure = {}, connected = {}, resumes = [], notes = [];
  const elements = new Map(), windowEvents = new Map();
  let resolveAudio, rejectAudio, blocked = false, clock = 0;
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
    document: { hidden: false, getElementById: element, addEventListener() {} },
    window: { addEventListener(type, fn) { windowEvents.set(type, fn); } },
    navigator: { getGamepads() { if (blocked) throw Error('Controller access denied'); return pads; } },
    performance: { now: () => ++clock },
    audio: { resume: () => new Promise((resolve, reject) => { resolveAudio = resolve; rejectAudio = reject; }) },
    fingers: new Map(), touchPad: { buttons: 0, stick: false }, knob: { style: {} },
    touchRoot: { querySelectorAll: () => [] }, canvas: { focus() {} }, statusEl: {},
    fullscreen: false, cardImportBusy: false, resetFrameStats() {}, note: message => notes.push(message),
  });
  vm.runInContext(shell.slice(inputStart, inputEnd), context);
  vm.runInContext(shell.slice(resumeStart, resumeEnd + '\n});'.length), context);
  const poll = () => vm.runInContext('pollInput()', context);
  return { Module, pads, nativePads, connected, resumes, notes, context,
    seed() { Module.paused = false; poll(); Module.paused = true; vm.runInContext('releaseInput()', context); },
    block() { blocked = true; },
    blur() { windowEvents.get('blur')(); },
    beginResume() { return element('start').listeners.get('click')(); },
    resolveAudio() { resolveAudio(); }, rejectAudio() { rejectAudio(Error('Audio interrupted')); },
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
  console.log('Input resume: 7 regression scenarios passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
