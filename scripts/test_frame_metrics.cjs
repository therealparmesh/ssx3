// Keep raw delayed submissions visible even when RAF timestamps look regular.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.env.SSX3_TEST_FRAME_METRICS || path.join(__dirname, 'browser_frame_metrics.js'), 'utf8')
  .replace('SSX3_DISABLE_JSPI', 'false');

function fixture(kind) {
  let now = 0, observe;
  let domCreates = 0, resizeObservers = 0;
  const callbacks = [];
  class CanvasRenderingContext2D {
    constructor(id) { this.canvas = { id }; }
    drawImage() { if (this.fail) throw new Error('draw failed'); return 7; }
  }
  class GPUCanvasContext {
    constructor(id) { this.canvas = { id }; }
    getCurrentTexture() { this.onAcquire?.(); return {}; }
  }
  class GPUQueue {
    writeBuffer(...args) { this.bufferArgs=args; if(this.failWrite)throw new Error('buffer write failed'); this.onBufferWrite?.(); }
    writeTexture() { this.onWrite?.(); }
    submit() { this.onSubmit?.(); if (this.fail) throw new Error('submit failed'); return 9; }
    onSubmittedWorkDone() { this.completionCalls=(this.completionCalls||0)+1; return this.completion ? this.completion() : Promise.resolve(); }
  }
  class GPUBuffer { mapAsync() {} }
  const context = vm.createContext({ performance: { now: () => now }, CanvasRenderingContext2D,
    GPUCanvasContext, GPUQueue, GPUBuffer,
    Module: { blitFrames: kind === 'copy' ? [] : undefined,
      surfaceFrames: kind === 'surface' ? [] : undefined,
      running: true, _ps2web_frames: () => 100, audioQueuedMs: () => 80 },
    document: { body: { append() {} }, createElement() { ++domCreates; return { style: {} }; } },
    ResizeObserver: class { constructor(callback) { ++resizeObservers; observe = callback; } observe() {} },
    requestAnimationFrame: callback => callbacks.push(callback), setTimeout, clearTimeout,
  });
  context.window = context;
  vm.runInContext(source, context);
  const canvas = kind === 'copy' ? new CanvasRenderingContext2D('canvas') : new GPUCanvasContext('canvas');
  const queue = new GPUQueue();
  const f = {
    context, canvas, queue, pendingCallbacks: callbacks,
    at(time) { now = time; },
    submit() { if (kind === 'copy') return canvas.drawImage({}, 0, 0); canvas.getCurrentTexture(); return queue.submit([]); },
    refresh(stamp) {
      for (const callback of callbacks.splice(0)) callback(stamp);
      if (observe) observe();
    },
    begin() {
      context.qaPhase('test'); context.qaInstall(); context.qaActive(true);
      assert.equal(domCreates, 0, 'Measurement must not create a layout sentinel');
      assert.equal(resizeObservers, 0, 'Measurement must not request per-refresh resize entries');
    },
    presenter(images) {
      let index = 0;
      const present = () => {
        for (let n = 0; n < images[index]; ++n) f.submit();
        ++index;
        context.requestAnimationFrame(present);
      };
      // Both buffered/copy presenters register their persistent callback before QA.
      context.requestAnimationFrame(present);
    },
  };
  return f;
}

for (const kind of ['copy', 'surface']) {
  const f = fixture(kind), { qa } = f.context;
  f.context.qaPhase('raf-relative'); f.context.qaActive(true);
  const present = () => f.submit();
  let wrapper;
  for (const [stamp, actual] of [[1000, 1001], [1016.667, 1026.2], [1033.334, 1034]]) {
    const id = f.context.requestAnimationFrame(present);
    assert.equal(id, 1, 'The native scheduler return value must be preserved');
    if (wrapper) assert.equal(f.pendingCallbacks[0], wrapper, 'Recurring callbacks reuse their wrapper');
    else wrapper = f.pendingCallbacks[0];
    f.at(actual); f.refresh(stamp);
    assert.equal(qa.currentRafStamp, null, 'RAF context must end with the callback');
  }
  assert.equal(qa.wall.rafSamples, 3);
  assert.equal(qa.wall.outsideRafSamples, 0);
  assert.equal(qa.wall.longGaps, 1, 'RAF-relative diagnostics must not relax the interval gate');
  const event = qa.wall.events[0];
  assert.equal(event.rafStamp, 1016.667);
  assert(Math.abs(event.rafLagMs - 9.533) < 0.001);
  assert(Math.abs(qa.wall.maxRafLagMs - 9.533) < 0.001);
  f.at(1070); f.submit();
  assert.equal(qa.wall.outsideRafSamples, 1);
  assert.equal(qa.wall.events.at(-1).rafStamp, null);
  assert.equal(qa.wall.events.at(-1).rafLagMs, null, 'Outside-RAF output must not inherit a stale stamp');
  f.context.requestAnimationFrame(present); f.at(1080); f.refresh(1081);
  assert.equal(qa.wall.negativeRafLags, 1, 'Negative clock differences remain visible');
  f.context.qaActive(false); f.context.qaActive(true);
  assert.equal(qa.wall.rafSamples, 0); assert.equal(qa.wall.outsideRafSamples, 0);
  assert.equal(qa.wall.negativeRafLags, 0); assert.equal(qa.wall.maxRafLagMs, 0);
}

{
  const f = fixture('surface'), { qa } = f.context, receiver = { tag: 'native callback receiver' };
  let seenReceiver, seenStamp;
  function callback(stamp) { seenReceiver = this; seenStamp = stamp; assert.equal(qa.currentRafStamp, stamp); return 42; }
  f.context.requestAnimationFrame(callback);
  assert.equal(f.pendingCallbacks.shift().call(receiver, 123), 42);
  assert.equal(seenReceiver, receiver); assert.equal(seenStamp, 123);
  assert.equal(qa.currentRafStamp, null);
  let inner, innerThrows = false;
  f.context.requestAnimationFrame(() => { assert.equal(qa.currentRafStamp, 200); inner(201); assert.equal(qa.currentRafStamp, 200); return 12; });
  const outer = f.pendingCallbacks.shift();
  f.context.requestAnimationFrame(() => { assert.equal(qa.currentRafStamp, 201); if (innerThrows) throw new Error('callback failure'); return 9; });
  inner = f.pendingCallbacks.shift();
  assert.equal(outer(200), 12);
  assert.equal(qa.currentRafStamp, null);
  innerThrows = true;
  assert.throws(() => outer(200), /callback failure/);
  assert.equal(qa.currentRafStamp, null, 'Exceptions through nested callbacks must restore the prior scope');
  const invalid = {};
  assert.equal(f.context.requestAnimationFrame(invalid), 1);
  assert.equal(f.pendingCallbacks.shift(), invalid, 'Invalid callbacks are passed to native validation');
}

for (const kind of ['copy', 'surface']) {
  const f = fixture(kind), { qa, Module } = f.context;
  f.begin();
  for (const [stamp, actual] of [[1000, 1000], [1016.667, 1016.667], [1033.334, 1050]]) {
    f.at(actual); assert.equal(f.submit(), kind === 'copy' ? 7 : 9); f.refresh(stamp);
  }
  assert.equal(qa.total.longRafGaps, 0, 'Nominal timestamps reproduce the previous false pass');
  assert.equal(qa.wall.intervals, 2);
  assert.equal(qa.wall.longGaps, 1, kind + ': actual delayed presentation is counted');
  assert(Math.abs(qa.wall.maxGapMs - 33.333) < 0.001);
  assert.equal(qa.wall.events[0].phase, 'test');

  f.context.qaActive(false); f.at(5000); f.submit();
  f.context.qaActive(true); f.at(6000); f.submit(); f.at(6016); f.submit();
  assert.equal(qa.wall.intervals, 1);
  assert.equal(qa.wall.longGaps, 0, 'Setup/pause time must not enter a new measurement');
  for (const flag of ['paused', 'failed', 'running']) {
    Module[flag] = flag !== 'running'; f.at(7000); f.submit();
    Module[flag] = flag === 'running'; f.at(8000); f.submit();
    assert.equal(qa.wall.longGaps, 0, 'Inactive player output cannot bridge a timing interval');
  }

  f.context.qaActive(true); f.at(0); f.submit(); f.at(30); f.submit();
  assert.equal(qa.wall.intervals, 1, 'A zero-valued first timestamp is valid');
  for (let i = 2; i <= 300; ++i) { f.at(i * 30); f.submit(); }
  assert.equal(qa.wall.longGaps, 300);
  assert.equal(qa.wall.events.length, 200, 'Diagnostic storage stays bounded');

  const before = qa.id;
  if (kind === 'copy') {
    new f.context.CanvasRenderingContext2D('other').drawImage({}, 0, 0);
    f.canvas.fail = true; assert.throws(() => f.submit(), /draw failed/);
  } else {
    new f.context.GPUCanvasContext('other').getCurrentTexture(); f.queue.submit([]);
    f.queue.fail = true; assert.throws(() => f.submit(), /submit failed/);
    f.queue.fail = false; f.queue.submit([]);
  }
  assert.equal(qa.id, before, 'Unrelated or failed output cannot count as a successful presentation');
}

for (const kind of ['copy', 'surface']) {
  const f = fixture(kind);
  f.presenter([1, 1, 0, 2, 1]);
  f.begin();
  for (let i = 0; i < 5; ++i) {
    const stamp = 1000 + i * 1000 / 60;
    f.at(stamp + (i === 3 ? 13 : 0));
    f.refresh(stamp);
  }
  assert.equal(f.context.qa.total.intervals, 4);
  assert.equal(f.context.qa.total.withoutImage, 1, kind + ': a skipped refresh fails QA');
  assert.equal(f.context.qa.total.overwritten, 1, kind + ': two images in one refresh fail QA');
  assert(f.context.qa.wall.longGaps > 0, kind + ': nominal stamps cannot hide a late callback');
}

for (const kind of ['copy', 'surface']) {
  const f = fixture(kind), module = f.context.Module;
  module.presentCopy = kind === 'copy';
  const frames = module.presentCopy ? module.blitFrames : module.surfaceFrames;
  const free = module.presentCopy ? (module.blitFree = [{}]) : (module.surfaceFree = [{}]);
  frames.push({}, {}); f.presenter([1, 0, 0]); f.begin();
  f.at(1000); f.refresh(1000); f.at(1016.667); f.refresh(1016.667);
  assert.equal(f.context.qa.events[0].queuedImages, 2, 'A skipped image with queued frames must remain distinguishable');
  assert.equal(f.context.qa.events[0].freeSlots, 1);
  frames.length = 0; free.push({}, {}); f.at(1033.334); f.refresh(1033.334);
  assert.equal(f.context.qa.events[1].queuedImages, 0, 'An empty producer queue must be recorded directly');
  assert.equal(f.context.qa.events[1].freeSlots, 3);
}

{
  const f = fixture('surface'); f.begin();
  f.at(1000); f.submit();
  f.at(1016.667); f.queue.onWrite = () => f.at(1024);
  f.queue.writeTexture({}, new Uint8Array(4), {}, {});
  f.canvas.onAcquire = () => f.at(1025); f.queue.onSubmit = () => f.at(1027); f.submit();
  const event = f.context.qa.wall.events[0];
  assert(Math.abs(event.uploadMs - 7.333) < 0.001);
  assert.equal(event.canvasAcquireMs, 1); assert.equal(event.submitMs, 2); assert.equal(event.encodeMs, 0);
  assert(Math.abs(event.uploadAgeMs - 10.333) < 0.001);
  assert.equal(event.gapMs, 27, 'Native API time must remain part of actual successful submission timing');
}

{
  const f = fixture('copy');
  delete f.context.Module.blitFrames;
  assert.throws(() => f.context.qaInstall(), /Initialize the buffered or copy presenter/);
}

// Buffer-backed uploads must receive the same timing coverage and preserve
// every optional-argument form of the native API.
{
  const f=fixture('surface');f.begin();f.at(0);f.submit();f.at(16);
  f.queue.onBufferWrite=()=>f.at(28);f.canvas.onAcquire=()=>f.at(31);f.queue.onSubmit=()=>f.at(34);
  const buffer={},data=new Uint8Array(128);
  f.queue.writeBuffer(buffer,0,data,0,data.length);f.submit();
  const event=f.context.qa.wall.events[0];
  assert.equal(event.gapMs,34);assert.equal(event.uploadMs,12);assert.equal(event.canvasAcquireMs,3);
  assert.equal(event.submitMs,3);assert.equal(event.uploadAgeMs,18);
  f.context.qaActive(false);f.queue.onBufferWrite=undefined;
  for(const args of [[buffer,2,data],[buffer,2,data,3],[buffer,2,data,3,4]]){
    f.queue.writeBuffer(...args);assert.deepEqual(f.queue.bufferArgs,args);
  }
  f.queue.failWrite=true;assert.throws(()=>f.queue.writeBuffer(buffer,0,data),/buffer write failed/);
}
console.log('Frame metrics: RAF-relative lag, cached callbacks, texture/buffer timing, native call forms, delayed output, lifecycle and bounded diagnostics passed');

async function gpuCompletionTests() {
  const flush=async()=>{for(let i=0;i<8;++i)await Promise.resolve();};
  const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
  const enable=f=>{f.context.qaGpuCompletions(true);f.begin();};
  {
    const f=fixture('surface');f.begin();f.at(1);f.submit();await flush();
    assert.equal(f.queue.completionCalls,undefined,'Default measurements must not request GPU fences');
    assert.equal(f.context.qa.gpu.enabled,false);assert.equal(f.context.qa.gpu.frames,0);
  }
  {
    const f=fixture('surface'),pending=[];
    f.queue.completion=function(){assert.equal(this,f.queue);const d=deferred();pending.push(d);return d.promise;};
    f.presenter([1,1]);enable(f);f.at(1001);f.refresh(1000);f.at(1017.667);f.refresh(1016.667);
    const state=f.context.qa.gpu;
    assert.equal(state.pending,2);assert.equal(state.maxPending,2);assert.equal(f.context.qa.wall.longGaps,0);
    assert.throws(()=>f.context.qaGpuCompletions(false),/Stop measurement/);
    assert.throws(()=>f.context.qaGpuSettled(),/Stop measurement/);
    f.context.qaActive(false);f.context.qaPhase('later');const settled=f.context.qaGpuSettled(1000);settled.catch(()=>{});
    f.at(1040);pending[1].resolve();await flush();assert.equal(state.completed,1);assert.equal(state.pending,1);
    f.at(1070);pending[0].resolve();assert.equal(await settled,state);
    assert.equal(state.frames,2);assert.equal(state.requested,2);assert.equal(state.completed,2);assert.equal(state.pending,0);
    assert.equal(state.maxNotificationLagMs,69);assert.equal(state.maxRafNotificationLagMs,70);
    assert.equal(state.unknownRafSamples,0);assert.equal(state.clockErrors,0);
    assert.equal(state.events.length,1);assert.equal(state.events[0].id,1);assert.equal(state.events[0].phase,'test');
  }
  {
    const f=fixture('surface'),pending=[];f.queue.completion=()=>{const d=deferred();pending.push(d);return d.promise;};
    f.presenter([1,1]);enable(f);f.at(1001);f.refresh(1000);f.at(1002);pending[0].resolve();await flush();
    f.at(1026.2);f.refresh(1016.667);f.at(1027);pending[1].resolve();await flush();
    const {qa}=f.context;assert.equal(qa.wall.longGaps,1,'Completion diagnostics must retain the existing CPU gate');
    assert.equal(qa.gpu.events.length,1,'A long CPU interval retains its completion even when the GPU is fast');
    assert.equal(qa.gpu.events[0].id,qa.wall.events[0].id);
    assert(Math.abs(qa.gpu.events[0].afterSubmitMs-.8)<.001);assert(Math.abs(qa.gpu.events[0].afterRafMs-10.333)<.001);
  }
  for(const failure of [()=>Promise.reject(Error('device lost')),()=>{throw Error('queue rejected');},()=>{throw 0;},()=>undefined,()=>({get then(){throw Error('invalid promise');}})]) {
    const f=fixture('surface');f.queue.completion=failure;enable(f);f.at(1000);assert.equal(f.submit(),9);await flush();
    const state=f.context.qa.gpu;assert.equal(state.requested,1);assert.equal(state.completed,0);assert.equal(state.rejected,1);assert.equal(state.pending,0);
    assert.equal(state.events.length,1);assert.equal(f.context.qa.id,1,'Diagnostic failure must not discard successful output');
  }
  {
    const f=fixture('surface');enable(f);f.context.qaActive(false);f.submit();assert.equal(f.context.qa.gpu.frames,0);
    f.context.qaActive(true);f.context.Module.paused=true;f.submit();f.context.Module.paused=false;
    f.queue.submit([]);new f.context.GPUCanvasContext('other').getCurrentTexture();f.queue.submit([]);
    f.queue.fail=true;assert.throws(()=>f.submit(),/submit failed/);f.queue.fail=false;
    assert.equal(f.context.qa.gpu.frames,0,'Inactive, unrelated and failed output must not request completion');
  }
  {
    const f=fixture('copy');enable(f);f.submit();f.context.qaActive(false);
    const state=await f.context.qaGpuSettled();assert.equal(state.frames,0);assert.equal(state.completed,0,'CPU-copy output must not fabricate GPU samples');
  }
  {
    const f=fixture('surface'),pending=[];f.queue.completion=()=>{const d=deferred();pending.push(d);return d.promise;};enable(f);
    for(let i=0;i<180;++i){f.at(i);f.submit();}
    const state=f.context.qa.gpu;assert.equal(state.frames,180);assert.equal(state.requested,16);assert.equal(state.skipped,164);assert.equal(state.pending,16);assert.equal(state.maxPending,16);
    assert.equal(f.queue.completionCalls,16,'A hung queue must not accumulate unbounded completion promises');
    f.context.qaActive(false);await assert.rejects(f.context.qaGpuSettled(0),/timed out/);assert.equal(state.pending,16,'Timeout does not prove pending work completed');
    f.context.qaActive(true);f.at(500);f.submit();const next=f.context.qa.gpu;
    assert.equal(next.skipped,1);assert.equal(next.requested,0,'Reset must not bypass the realm-wide pending cap');
    f.context.qaActive(false);f.at(1000);for(const d of pending)d.resolve();await flush();assert.equal(state.completed,16);assert.equal(state.pending,0);assert.equal(await f.context.qaGpuSettled(0),next);
    assert.equal(next.completed,0,'Old completions must not leak into the next window');
  }
  {
    const f=fixture('surface');enable(f);
    for(let batch=0;batch<13;++batch){for(let i=0;i<16;++i){f.at(batch*200+i);f.submit();}f.at(batch*200+100);await flush();}
    const state=f.context.qa.gpu;assert.equal(state.requested,208);assert.equal(state.completed,208);assert.equal(state.skipped,0);assert.equal(state.events.length,200,'Completion event storage stays bounded');
  }
  {
    const f=fixture('surface'),d=deferred();f.queue.completion=()=>d.promise;enable(f);f.at(1000);f.submit();
    const old=f.context.qa.gpu;f.context.qaActive(false);const settled=f.context.qaGpuSettled(1000);settled.catch(()=>{});
    f.context.qaActive(true);const current=f.context.qa.gpu;assert.notEqual(current,old);f.at(1010);d.resolve();assert.equal(await settled,old);
    assert.equal(old.completed,1);assert.equal(old.pending,0);assert.equal(current.frames,0);assert.equal(current.pending,0,'Old callbacks must not mutate the next measurement');
    f.context.qaActive(false);f.context.qaGpuCompletions(false);f.context.qaActive(true);f.submit();await flush();
    assert.equal(f.context.qa.gpu.enabled,false);assert.equal(f.context.qa.gpu.frames,0);assert.equal(f.queue.completionCalls,1,'Disabling diagnostics restores fence-free measurement');
  }
  {
    const f=fixture('surface'),d=deferred();f.queue.completion=()=>d.promise;enable(f);f.at(1000);f.submit();f.at(999);d.resolve();await flush();
    assert.equal(f.context.qa.gpu.clockErrors,1);assert.equal(f.context.qa.gpu.events[0].afterSubmitMs,-1,'Invalid clock differences must remain visible');
    f.context.qaActive(false);assert.throws(()=>f.context.qaGpuSettled(-1),/Invalid/);assert.throws(()=>f.context.qaGpuSettled(NaN),/Invalid/);
  }
  console.log('GPU completion metrics: opt-in/default inactivity, queue ownership, timing, failures, capacity, bounded events, settlement and reset isolation passed');
}
gpuCompletionTests().catch(error=>{console.error(error);process.exitCode=1;});
