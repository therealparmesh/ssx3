// Exercise the actual EM_JS presenter with deterministic refreshes. The producer
// alternates late and catch-up frames; delivered pixel values must remain FIFO.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../host/web.cpp'), 'utf8');
const marker = 'EM_JS(void, ps2web_blit, (const std::uint32_t *rgba, int width, int height, int wide), {';
const start = source.indexOf(marker) + marker.length;
assert(start >= marker.length);
const body = source.slice(start, source.indexOf('\n});', start));
const presented = [], callbacks = [], canvases = [];
class ImageData {
  constructor(width, height) { this.width = width; this.height = height; this.data = new Uint8ClampedArray(width * height * 4); }
}
class OffscreenCanvas {
  constructor(width, height) {
    this.width = width; this.height = height; this.pixel = 0;
    this.context = { putImageData: image => { this.pixel = image.data[0]; }, drawImage: source => { this.pixel = source.pixel; } };
    canvases.push(this);
  }
  getContext() { return this.context; }
}
const ctx = { fillRect() {}, drawImage(source) { presented.push(source.pixel); } };
const Module = { canvas: { width: 8, height: 6, getContext: () => ctx }, paused: false, failed: false, onPresent: () => ++notified };
let notified = 0;
const heap = new Uint8Array(64);
const context = vm.createContext({ Module, HEAPU8: heap, ImageData, OffscreenCanvas, requestAnimationFrame: f => callbacks.push(f) });
const blit = vm.runInContext('(function(rgba,width,height,wide){' + body + '})', context);
const produce = (value, width = 4, height = 3, wide = 0) => { heap.fill(value); blit(0, width, height, wide); heap.fill(255); };
const refresh = () => { const ready = callbacks.splice(0); for (const f of ready) f(); assert.equal(callbacks.length, 1); };
produce(1); refresh(); assert.deepEqual(presented, [], 'Prime before consuming the only completed frame');
produce(2); refresh();
let next = 3;
for (let i = 0; i < 100; ++i) {
  if (i % 2) { produce(next++); produce(next++); }
  refresh();
}
assert.deepEqual(presented, Array.from({ length: 101 }, (_, i) => i + 1), 'Deliver one distinct image per refresh despite alternating zero/two-frame production');
assert.equal(notified, presented.length, 'Only actual canvas copies count as presented');
assert(canvases.length <= 4, 'At most three source canvases and one sharp-scaling canvas are needed');
assert.equal(Module.blitFree.length + Module.blitFrames.length, 3);
Module.paused = true;
produce(150); produce(151); produce(152); produce(153);
const count = presented.length;
refresh(); refresh(); assert.equal(presented.length, count, 'Pause must freeze the displayed image');
assert.equal(Module.blitFree.length + Module.blitFrames.length, 3, 'Catch-up never allocates extra frame slots');
assert.equal(canvases.length, 4, 'Filling the pool uses exactly three source canvases and one sharp-scaling canvas');
Module.paused = false;
refresh(); refresh(); refresh();
assert.deepEqual(presented.slice(-3), [151, 152, 153], 'Overflow bounds latency by keeping the newest three images');
refresh(); assert.equal(presented.length, count + 3, 'An empty queue must not report a duplicate as a fresh image');
produce(160, 2, 2, 1); refresh(); assert.equal(presented.at(-1), 160, 'Size and aspect changes retain the new frame');
Module.failed = true; produce(170); refresh(); assert.equal(presented.at(-1), 160, 'Failure must stop presentation');
assert.equal(Module.blitFree.length + Module.blitFrames.length, 3);
console.log('Presentation: ordered pixels, alternating frame delivery, bounded overflow, pause/resume, resize and failure passed');
