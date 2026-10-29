const assert = require('node:assert/strict');
const { install } = require(process.env.SSX3_TEST_READBACK_PROGRESS || '../web/readback-progress.js');
function deferred() { let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}; }
function fixture() {
  const timers=new Map(),submitted=[];let serial=0,deviceSerial=0;
  class GPUBuffer { constructor(job){this.job=job}mapAsync(...args){this.args=args;if(this.job instanceof Error)throw this.job;return this.job.promise} }
  class GPUDevice {
    constructor(){this.id=++deviceSerial;this.queue={submit:commands=>{submitted.push({device:this.id,count:commands.length});this.action?.()}}}
    createBuffer(desc){if(desc instanceof Error)throw desc;this.descriptor=desc;return new GPUBuffer(desc.job)}
  }
  class GPUAdapter {async requestDevice(){return new GPUDevice()}}
  const scope={GPUAdapter,GPUDevice,GPUBuffer,setTimeout(fn,ms){const id=++serial;timers.set(id,{fn,ms});return id},clearTimeout(id){timers.delete(id)}};
  return {scope,timers,submitted,tick(){const [id,timer]=timers.entries().next().value;timers.delete(id);timer.fn()}};
}
const read=(device,job,...args)=>device.createBuffer({job}).mapAsync(1,...args);
(async()=>{
  const f=fixture(),original=f.scope.GPUBuffer.prototype.mapAsync,originalCreate=f.scope.GPUDevice.prototype.createBuffer;
  const control=install(f.scope),device=await new f.scope.GPUAdapter().requestDevice();
  const a=deferred(),b=deferred(),pa=read(device,a),pb=read(device,b);
  assert.equal(control.pendingTimers,1,'READ mappings on one device must share a progress timer');assert.equal(f.timers.size,1);
  f.tick();assert.deepEqual(f.submitted,[{device:device.id,count:0}]);assert.equal(control.pendingTimers,1);
  a.resolve();await pa;assert.equal(control.pendingTimers,1,'One completed map must not retire another map');
  const late=f.timers.values().next().value.fn;control.close();control.close();late();assert.equal(f.timers.size,0);assert.equal(control.pendingTimers,0);
  assert.equal(f.scope.GPUBuffer.prototype.mapAsync,original);assert.equal(f.scope.GPUDevice.prototype.createBuffer,originalCreate);b.resolve();await pb;

  const m=fixture(),multi=install(m.scope),first=await new m.scope.GPUAdapter().requestDevice(),second=await new m.scope.GPUAdapter().requestDevice();
  const x=deferred(),y=deferred(),px=read(first,x),py=read(second,y);assert.equal(multi.pendingTimers,2);
  first.action=()=>x.resolve();second.action=()=>y.resolve();m.tick();assert.deepEqual(m.submitted,[{device:first.id,count:0}]);await px;
  assert.equal(multi.pendingTimers,1);m.tick();await py;assert.deepEqual(m.submitted,[{device:first.id,count:0},{device:second.id,count:0}]);assert.equal(multi.pendingTimers,0);multi.close();

  const g=fixture(),errors=[],c=install(g.scope,e=>errors.push(e.message)),gd=await new g.scope.GPUAdapter().requestDevice();
  const lost=deferred(),pending=read(gd,lost);gd.action=()=>{throw Error('Device lost')};g.tick();assert.deepEqual(errors,['Device lost']);assert.equal(c.pendingTimers,0);lost.reject(Error('Map rejected'));await assert.rejects(pending,/Map rejected/);
  const h=fixture(),d=install(h.scope),hd=await new h.scope.GPUAdapter().requestDevice(),stop=deferred(),p=read(hd,stop);hd.action=()=>d.close();h.tick();assert.equal(h.timers.size,0,'Reentrant stop must not schedule another poll');stop.resolve();await p;
  assert.throws(()=>hd.createBuffer({job:Error('Invalid map')}).mapAsync(1),/Invalid map/);assert.throws(()=>hd.createBuffer(Error('Invalid buffer')),/Invalid buffer/);

  const w=fixture(),writeControl=install(w.scope),wd=await new w.scope.GPUAdapter().requestDevice(),write=deferred(),writeBuffer=wd.createBuffer({job:write}),writePromise=writeBuffer.mapAsync(2,4,8);
  assert.equal(writePromise,write.promise,'Upload maps retain their original promise');assert.deepEqual(writeBuffer.args,[2,4,8]);assert.equal(writeControl.pendingTimers,0);assert.deepEqual(w.submitted,[]);write.resolve();await writePromise;
  const rp=deferred(),up=deferred(),readPromise=read(wd,rp),uploadPromise=wd.createBuffer({job:up}).mapAsync(2);assert.equal(writeControl.pendingTimers,1);assert.equal(uploadPromise,up.promise);up.resolve();await uploadPromise;assert.equal(writeControl.pendingTimers,1);rp.resolve();await readPromise;assert.equal(writeControl.pendingTimers,0);writeControl.close();

  const stale=fixture(),staleControl=install(stale.scope),sd=await new stale.scope.GPUAdapter().requestDevice(),old=deferred(),oldPromise=read(sd,old),oldTimer=stale.timers.values().next().value.fn;
  old.resolve();await oldPromise;const fresh=deferred(),freshPromise=read(sd,fresh);oldTimer();assert.deepEqual(stale.submitted,[],'A retired poll must not submit or disturb a newer map');assert.equal(staleControl.pendingTimers,1);stale.tick();fresh.resolve();await freshPromise;staleControl.close();

  const re=fixture(),reControl=install(re.scope),rd=await new re.scope.GPUAdapter().requestDevice(),r1=deferred(),r2=deferred(),r1p=read(rd,r1);let r2p;
  rd.action=()=>{if(!r2p)r2p=read(rd,r2)};re.tick();assert.equal(re.timers.size,1,'A reentrant map must not create a second queue poll');r1.resolve();r2.resolve();await Promise.all([r1p,r2p]);assert.equal(reControl.pendingTimers,0);reControl.close();

  const unknown=fixture(),job=deferred(),preexisting=new unknown.scope.GPUDevice().createBuffer({job}),unknownControl=install(unknown.scope);
  assert.equal(preexisting.mapAsync(1),job.promise,'Buffers without known ownership retain their native promise');assert.equal(unknownControl.pendingTimers,0);job.resolve();await job.promise;
  const ownMap=unknown.scope.GPUBuffer.prototype.mapAsync,foreignMap=function(){return ownMap.apply(this,arguments)};unknown.scope.GPUBuffer.prototype.mapAsync=foreignMap;unknownControl.close();assert.equal(unknown.scope.GPUBuffer.prototype.mapAsync,foreignMap,'Shutdown must preserve a later wrapper');
  console.log('PASS: per-device/coalesced progress, buffer ownership, concurrent maps, rejection, cancellation, stale/reentrant polls, upload identity and prototype restoration');
})().catch(error=>{console.error(error);process.exitCode=1});
