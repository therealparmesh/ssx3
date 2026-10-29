// Exercise the shell's actual sizing function across direct and worker modes.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const shell = fs.readFileSync(process.env.SSX3_TEST_CANVAS_SHELL || path.join(__dirname, '../web/shell.html'), 'utf8');
const first = shell.indexOf('function fitCanvas() {');
const last = shell.indexOf("\nwindow.addEventListener('resize', fitCanvas)", first);
assert(first >= 0 && last > first);
const source = shell.slice(first, last);
const cases = [
  [1280, 800, 1, 1280, 800],
  [1280, 800, 2, 2560, 1600],
  [393, 852, 3, 786, 1704],
  [5120, 1440, 2, 8191, 2304],
  [1440, 5120, 2, 2304, 8191],
  [7680, 4320, 2, 8191, 4607],
  [16384, 16384, 2, 8191, 8191],
  [4096, 4096, 2, 8191, 8191],
  [1280, 800, 1.25, 1600, 1000],
  [1280, 800, undefined, 1280, 800],
  [0, 0, 2, 1, 1],
  [0, 5120, 2, 1, 8191],
];
let checked = 0;
for (const worker of [false, true]) for (const running of [false, true]) {
  const resizes = [], properties = [];
  let width = 64, height = 64;
  const canvas = {
    clientWidth: 0, clientHeight: 0,
    get width() { return width; }, set width(value) { assert(!worker, 'Transferred canvas must not be resized in the page'); width = value; },
    get height() { return height; }, set height(value) { assert(!worker, 'Transferred canvas must not be resized in the page'); height = value; },
  };
  const Module = { running, offscreenTransferred: worker, _ps2web_resize: (...args) => resizes.push(args) };
  const context = vm.createContext({ canvas, Module, window: {}, document: {
    getElementById(id) { assert.equal(id, 'bar'); return { getBoundingClientRect: () => ({ height: 47 }) }; },
    body: { style: { setProperty: (...args) => properties.push(args) } },
  } });
  vm.runInContext(source, context);
  for (const [cssWidth, cssHeight, dpr, expectedWidth, expectedHeight] of cases) {
    canvas.clientWidth = cssWidth; canvas.clientHeight = cssHeight; context.window.devicePixelRatio = dpr;
    context.fitCanvas();
    const dimensions = worker ? [Module.workerCanvasWidth, Module.workerCanvasHeight] : [canvas.width, canvas.height];
    assert.deepEqual(dimensions, [expectedWidth, expectedHeight], `Invalid canvas size for ${cssWidth}x${cssHeight} @ ${dpr}`);
    assert.deepEqual([canvas.clientWidth, canvas.clientHeight], [cssWidth, cssHeight]);
    assert.deepEqual(properties.at(-1), ['--toolbar-height', '47px']);
    if (worker || running) assert.deepEqual(resizes.at(-1), dimensions);
    else assert.equal(resizes.length, 0, 'A direct runtime must not be called before startup');
    const count = resizes.length;
    context.fitCanvas();
    assert.equal(resizes.length, count, 'An unchanged display must not trigger another native resize');
    ++checked;
  }
}
console.log(`PASS: ${checked} canvas sizing cases; bounded high-DPI output, direct/worker startup, aspect, hidden layout and resize coalescing`);
