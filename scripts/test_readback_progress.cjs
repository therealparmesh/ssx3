const assert = require('node:assert/strict');
const { install } = require('../web/readback-progress.js');
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; }
function fixture() {
  const timers = new Map(), submitted = []; let serial = 0, submitAction;
  class GPUAdapter { async requestDevice() { return { queue: { submit(commands) { submitted.push(commands.length); submitAction?.(); } } }; } }
  class GPUBuffer { constructor(job) { this.job=job; } mapAsync() { if(this.job instanceof Error)throw this.job; return this.job.promise; } }
  const scope = { GPUAdapter, GPUBuffer, setTimeout(fn,ms) { const id=++serial; timers.set(id,{fn,ms}); return id; }, clearTimeout(id) { timers.delete(id); } };
  return { scope,timers,submitted,action:fn=>{submitAction=fn},tick() { const [id,timer]=timers.entries().next().value; timers.delete(id); timer.fn(); } };
}
(async()=>{
  const f=fixture(), original=f.scope.GPUBuffer.prototype.mapAsync, originalRequest=f.scope.GPUAdapter.prototype.requestDevice;
  const control=install(f.scope);await new f.scope.GPUAdapter().requestDevice();
  const a=deferred(),b=deferred(),pa=new f.scope.GPUBuffer(a).mapAsync(),pb=new f.scope.GPUBuffer(b).mapAsync();
  assert.equal(control.pendingTimers,2);f.tick();assert.deepEqual(f.submitted,[0]);
  a.resolve();await pa;assert.equal(control.pendingTimers,1);
  const late=f.timers.values().next().value.fn;control.close();control.close();late();assert.equal(f.timers.size,0);assert.equal(control.pendingTimers,0);
  assert.equal(f.scope.GPUBuffer.prototype.mapAsync,original);assert.equal(f.scope.GPUAdapter.prototype.requestDevice,originalRequest);
  b.resolve();await pb;
  const g=fixture(),errors=[],c=install(g.scope,e=>errors.push(e.message));await new g.scope.GPUAdapter().requestDevice();
  const lost=deferred(),pending=new g.scope.GPUBuffer(lost).mapAsync();g.action(()=>{throw Error('Device lost')});g.tick();assert.deepEqual(errors,['Device lost']);assert.equal(c.pendingTimers,0);assert.equal(g.timers.size,0);lost.reject(Error('Map rejected'));await assert.rejects(pending,/Map rejected/);
  const h=fixture(),d=install(h.scope);await new h.scope.GPUAdapter().requestDevice();const stop=deferred(),p=new h.scope.GPUBuffer(stop).mapAsync();h.action(()=>d.close());h.tick();assert.equal(h.timers.size,0,'Reentrant stop must not schedule another poll');stop.resolve();await p;
  assert.throws(()=>new h.scope.GPUBuffer(Error('Invalid map')).mapAsync(),/Invalid map/);
  console.log('PASS: pending-map progress, rejection, cancellation, prototype restoration and reentrant stop');
})().catch(e=>{console.error(e);process.exitCode=1});
