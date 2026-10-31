const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
let library, extraTime = 0;
const testClock = { now: () => performance.now() + extraTime };
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../web/webgl-readback.js'), 'utf8'), {
  addToLibrary: value => { library = value; }, Uint8Array, Map, Number, Math, Error, performance: testClock, setTimeout,
});
function fixture() {
  const gl = {}, fields = ['PIXEL_PACK_BUFFER_BINDING', 'PIXEL_PACK_BUFFER', 'STREAM_READ', 'PACK_ALIGNMENT',
    'PACK_ROW_LENGTH', 'PACK_SKIP_PIXELS', 'PACK_SKIP_ROWS', 'RGBA', 'UNSIGNED_BYTE', 'SYNC_GPU_COMMANDS_COMPLETE',
    'WAIT_FAILED', 'ALREADY_SIGNALED', 'CONDITION_SATISFIED', 'TIMEOUT_EXPIRED', 'NO_ERROR'];
  fields.forEach((name, i) => { gl[name] = i + 1; });
  const original = { foreign: true }, state = new Map([[gl.PIXEL_PACK_BUFFER_BINDING, original],
    [gl.PACK_ALIGNMENT, 8], [gl.PACK_ROW_LENGTH, 19], [gl.PACK_SKIP_PIXELS, 3], [gl.PACK_SKIP_ROWS, 7]]);
  const buffers = new Set(), fences = new Set(); let seed = 0, lost = false, failure = '';
  gl.getParameter = key => state.get(key);
  gl.bindBuffer = (_, buffer) => state.set(gl.PIXEL_PACK_BUFFER_BINDING, buffer);
  gl.pixelStorei = (key, value) => state.set(key, value);
  gl.createBuffer = () => { if (failure === 'allocation') return null; const buffer = {}; buffers.add(buffer); return buffer; };
  gl.deleteBuffer = buffer => { assert(buffers.delete(buffer)); };
  gl.bufferData = (_, bytes) => { state.get(gl.PIXEL_PACK_BUFFER_BINDING).data = new Uint8Array(bytes); };
  gl.readPixels = (x, y, width, height, format, type, offset) => {
    assert.equal(state.get(gl.PACK_ALIGNMENT), 4); assert.equal(offset, 0);
    for (const key of [gl.PACK_ROW_LENGTH, gl.PACK_SKIP_PIXELS, gl.PACK_SKIP_ROWS]) assert.equal(state.get(key), 0);
    const data = state.get(gl.PIXEL_PACK_BUFFER_BINDING).data;
    for (let i = 0; i < width * height * 4; ++i) data[i] = (seed + i) & 255;
  };
  gl.fenceSync = () => { if (failure === 'fence') return null; const fence = { ready: false }; fences.add(fence); return fence; };
  gl.deleteSync = fence => { assert(fences.delete(fence)); };
  gl.clientWaitSync = fence => failure === 'wait' ? gl.WAIT_FAILED : fence.ready ? gl.ALREADY_SIGNALED : gl.TIMEOUT_EXPIRED;
  gl.flush = () => {};
  gl.getError = () => failure === 'gl' ? 123 : gl.NO_ERROR;
  gl.isContextLost = () => lost;
  gl.getBufferSubData = (_, offset, target) => { if (failure === 'copy') throw Error('copy failed'); target.set(state.get(gl.PIXEL_PACK_BUFFER_BINDING).data.subarray(offset, offset + target.length)); };
  const api = library.$ps2webglCreateReadbacks(gl);
  return { api, buffers, fences, setSeed: value => { seed = value; }, fail: value => { failure = value; },
    lose: () => { lost = true; }, signal: () => fences.forEach(f => { f.ready = true; }),
    restored: () => { assert.equal(state.get(gl.PIXEL_PACK_BUFFER_BINDING), original);
      for (const [key, value] of [[gl.PACK_ALIGNMENT, 8], [gl.PACK_ROW_LENGTH, 19], [gl.PACK_SKIP_PIXELS, 3], [gl.PACK_SKIP_ROWS, 7]]) assert.equal(state.get(key), value); },
  };
}
(async () => {
  const f = fixture();
  f.setSeed(17); const first = f.api.enqueue(0, 0, 3, 2);
  f.setSeed(83); const second = f.api.enqueue(0, 0, 5, 1);
  assert.throws(() => f.api.enqueue(0, 0, 1, 1), /queue is full/); f.restored();
  let firstBytes;
  const waiting = f.api.collect(first, data => { firstBytes = [...data]; });
  await assert.rejects(f.api.collect(first, () => {}), /Invalid.*ticket/);
  setTimeout(f.signal, 5); await waiting;
  assert.deepEqual(firstBytes, Array.from({ length: 24 }, (_, i) => 17 + i));
  f.setSeed(161); const third = f.api.enqueue(0, 0, 2, 3); f.signal();
  await f.api.collect(second, data => assert.deepEqual([...data], Array.from({ length: 20 }, (_, i) => 83 + i)));
  await f.api.collect(third, data => assert.deepEqual([...data], Array.from({ length: 24 }, (_, i) => 161 + i)));
  for (let i = 0; i < 40; ++i) {
    const width = [1, 32, 7, 64][i % 4]; f.setSeed(i);
    const id = f.api.enqueue(0, 0, width, 2); f.signal();
    await f.api.collect(id, data => assert.deepEqual([...data], Array.from({ length: width * 8 }, (_, n) => (i + n) & 255)));
    f.restored();
  }
  assert.equal(f.api.stats.peakBuffers, 2); assert.equal(f.api.stats.pending, 0);
  f.api.dispose(); f.api.dispose(); assert.equal(f.buffers.size, 0); assert.equal(f.fences.size, 0);
  assert.throws(() => f.api.enqueue(0, 0, 1, 1), /unavailable/);

  for (const failure of ['allocation', 'fence', 'gl']) {
    const f = fixture(); f.fail(failure); assert.throws(() => f.api.enqueue(0, 0, 2, 2));
    f.restored(); assert.equal(f.buffers.size, 0); assert.equal(f.fences.size, 0); assert.equal(f.api.stats.pending, 0);
  }
  for (const failure of ['wait', 'copy', 'gl', 'consume']) {
    const f = fixture(), id = f.api.enqueue(0, 0, 2, 2); f.signal(); f.fail(failure);
    await assert.rejects(f.api.collect(id, () => { if (failure === 'consume') throw Error('consumer failed'); }));
    f.restored(); assert.equal(f.buffers.size, 0); assert.equal(f.fences.size, 0); assert.equal(f.api.stats.pending, 0);
  }
  for (const action of ['cancel', 'dispose', 'lose']) {
    const f = fixture(), id = f.api.enqueue(0, 0, 2, 2);
    const waiting = f.api.collect(id, () => assert.fail('Canceled pixels must not reach the consumer'));
    if (action === 'cancel') f.api.cancel(id); else if (action === 'dispose') f.api.dispose(); else f.lose();
    await assert.rejects(waiting); assert.equal(f.buffers.size, 0); assert.equal(f.fences.size, 0); assert.equal(f.api.stats.pending, 0);
  }
  {
    const f = fixture(), id = f.api.enqueue(0, 0, 2, 2);
    assert.equal(f.api.collectNow(id, () => assert.fail('Unready pixels')), false);
    assert.equal(f.api.stats.pending, 1); f.signal();
    let called = false;
    assert.equal(f.api.collectNow(id, data => {assert.equal(data.length,16);called=true;}), true);
    assert.equal(called,true); assert.equal(f.api.stats.pending,0); f.restored(); f.api.dispose();
  }
  for (const failure of ['wait', 'copy', 'gl', 'consume']) {
    const f = fixture(), id = f.api.enqueue(0, 0, 2, 2); f.signal(); f.fail(failure);
    assert.throws(() => f.api.collectNow(id, () => {if(failure==='consume')throw Error('consumer failed');}));
    f.restored(); assert.equal(f.buffers.size,0); assert.equal(f.fences.size,0); assert.equal(f.api.stats.pending,0);
  }
  {
    const f = fixture(), id = f.api.enqueue(0, 0, 2, 2);
    const waiting = f.api.collect(id, () => assert.fail('Timed-out pixels'));
    extraTime += 11000;
    await assert.rejects(waiting, /timed out/); extraTime = 0;
    f.restored(); assert.equal(f.buffers.size, 0); assert.equal(f.fences.size, 0); assert.equal(f.api.stats.pending, 0);
  }
  const invalid = fixture();
  for (const [w, h] of [[0, 1], [1, 0], [-1, 2], [-1, -1], [0.5, 2], [NaN, 1], [Infinity, 1], [4096, 4096]]) assert.throws(() => invalid.api.enqueue(0, 0, w, h));
  assert.equal(invalid.buffers.size, 0);
  console.log('PASS: WebGL PBO ordering, two-buffer reuse, resize, pack-state preservation, cancellation, context loss, timeout and failure cleanup');
})().catch(error => { console.error(error); process.exitCode = 1; });
