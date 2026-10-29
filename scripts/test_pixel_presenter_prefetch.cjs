const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const {create}=require('../web/pixel-producer.js');
const root=path.join(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'ssx3-clock-'));
execFileSync('python3',[path.join(root,'scripts/export_frame_clock.py'),path.join(root,'web/frame-presentation.js'),temp+'/frame-clock.js']);
class Worker {
 constructor(){Worker.last=this;this.messages=[];this.listeners=new Map();this.terminated=0}
 addEventListener(type,fn){this.listeners.set(type,fn)} removeEventListener(type,fn){if(this.listeners.get(type)===fn)this.listeners.delete(type)}
 postMessage(value){this.messages.push(structuredClone(value))} emit(value){this.listeners.get('message')?.({data:value})} terminate(){++this.terminated}
}
async function exercise(usePort){
 let timerId=0;const timers=new Map();const runTimers=()=>{for(const [id,fn] of [...timers]){timers.delete(id);fn()}};let nextRaf,lose,armed=true,protectedWrite=true,producer,state,worker,stamp=0;
 const uploads=[],viewports=[],failures=[];let destroyed=0,unconfigured=0,bufferDestroyed=0,bufferCopies=0,lastPass,textureCreated=0,textureDestroyed=0,failUpload=0;const order=[];
 const device={destroy(){++destroyed},lost:new Promise(resolve=>{lose=resolve}),addEventListener(){},createShaderModule(){return{}},createRenderPipeline(){return{getBindGroupLayout(){return{}}}},createSampler(){return{}},createBuffer(){return{destroy(){++bufferDestroyed}}},createTexture(){++textureCreated;return{createView(){return{}},destroy(){++textureDestroyed}}},createBindGroup(){return{}},createRenderBundleEncoder(){return{setPipeline(){},setBindGroup(){},draw(){},finish(){return{}}}},createCommandEncoder(){return{copyBufferToTexture(source,destination,size){assert.equal(source.bytesPerRow,size.width*4);assert.equal(source.rowsPerImage,size.height);assert.equal(size.depthOrArrayLayers,1);assert(destination.texture);++bufferCopies;order.push('copy')},beginRenderPass(descriptor){assert(descriptor.colorAttachments[0].view);lastPass=descriptor;order.push('render');return{setViewport(...args){viewports.push(args)},executeBundles(){},end(){}}},finish(){return{}}}},queue:{writeTexture(target,data){
  if(failUpload&&data[0]===failUpload)throw Error('QA upload preparation failed');order.push('write');const before=data[0];
  if(protectedWrite){protectedWrite=false;producer.publish(new Uint8Array([11,11,11,255]),1,1,false)}
  assert.equal(data[0],before,'A pinned upload changed underneath the consumer');uploads.push({first:data[0],bytes:data.byteLength});
 },writeBuffer(target,offset,data,dataOffset,size){assert.equal(offset,0);assert.equal(dataOffset,0);uploads.push({first:data[0],bytes:size});order.push('write')},submit(){order.push('submit')}}};
 const atomics={load:Atomics.load,store:Atomics.store,add:Atomics.add,compareExchange(array,index,expected,value){
  if(armed&&index===4&&expected===1&&value===2){armed=false;producer.publish(new Uint8Array(8).fill(99),2,1,true)}
  return Atomics.compareExchange(array,index,expected,value);
 }};
 const gpuContext={configure(){},unconfigure(){++unconfigured},getCurrentTexture(){return{createView(){return{}}}}};
 const canvas={width:64,height:32,getContext(){return gpuContext}};
 const sandbox={Uint8Array,Int32Array,Uint32Array,SharedArrayBuffer,Atomics:atomics,navigator:{userAgent:'Mozilla/5.0 Firefox/158.0',gpu:{requestAdapter:async()=>({requestDevice:async()=>device}),getPreferredCanvasFormat:()=> 'bgra8unorm'}},GPUBufferUsage:{COPY_SRC:4,COPY_DST:8},GPUTextureUsage:{COPY_DST:1,TEXTURE_BINDING:2},setTimeout(fn){const id=++timerId;timers.set(id,fn);return id},clearTimeout(id){timers.delete(id)},requestAnimationFrame(fn){nextRaf=fn;return 1},addEventListener(){},postMessage(value){worker.emit(structuredClone(value))}};
 class Port {start(){this.started=true}close(){this.closed=true}postMessage(message){worker.emit(structuredClone(message))}}
 sandbox.MessagePort=Port;sandbox.self=sandbox;const context=vm.createContext(sandbox);sandbox.importScripts=()=>vm.runInContext(fs.readFileSync(temp+'/frame-clock.js','utf8'),context);
 vm.runInContext(fs.readFileSync(path.join(root,'web/pixel-presenter-worker.js'),'utf8'),context);
 producer=create({Worker,url:'presenter.js',canvas:{},slotBytes:4,onFailure:e=>failures.push(e.message)});worker=Worker.last;
 let receive=event=>sandbox.onmessage(event),port;
 if(usePort){port=new Port();await sandbox.onmessage({data:{type:'connect',port}});assert.equal(port.started,true);receive=event=>port.onmessage(event)}
 const init=worker.messages.shift();init.canvas=canvas;state=new Int32Array(init.slotState);await receive({data:init});await producer.ready;
 if(usePort==='stop'){
  await receive({data:{type:'stop'}});assert.equal(port.closed,true);assert.equal(destroyed,1);assert.equal(unconfigured,1);
  assert.equal(sandbox.ps2PixelPresenter.running,false);assert.equal(sandbox.ps2PixelPresenter.failed,false);
  lose({message:'Intentional device destruction'});await Promise.resolve();assert.deepEqual(failures,[]);producer.close();return;
 }
 const deliver=async()=>{for(const message of worker.messages.splice(0))await receive({data:message})};
 const tick=()=>{stamp+=1000/60;nextRaf(stamp)};
 producer.publish(new Uint8Array([1,1,1,255]),1,1,false);producer.publish(new Uint8Array([7,7,7,255]),1,1,false);producer.publish(new Uint8Array([3,3,3,255]),1,1,false);await deliver();
 tick();assert.equal(uploads[0]?.first,7,'The old generation must be rejected after acquiring a replaced slot');
 assert.equal(uploads[0].bytes,4);assert.equal(producer.replacements,2);assert.equal(new Uint8Array(init.buffers[1])[0],7);
 await deliver();tick();tick();assert.deepEqual(uploads.map(x=>x.first),[7,99,11]);assert.equal(uploads[1].bytes,8);assert.equal(producer.free.length,3);
 const publish=async(value,sequence)=>{const slot=producer.free.at(-1);Atomics.store(state,slot.id*2+1,sequence);producer.publish(new Uint8Array([value,value,value,255]),1,1,false);await deliver();tick();assert.equal(uploads.at(-1).first,value)};
 await publish(21,-1);await publish(22,0x7FFFFFFF);
 for (const [width,height,value] of [[64,1,41],[64,1,42],[128,2,43]]) {
  const bytes=new Uint8Array(width*height*4).fill(value);producer.publish(bytes,width,height,false);await deliver();tick();
  assert.equal(uploads.at(-1).first,value);assert.equal(uploads.at(-1).bytes,bytes.byteLength);
  const encoded=order.slice(-3);assert.equal(new Set(encoded).size,3);
  assert(encoded.indexOf('write')<encoded.indexOf('submit'),'Pixels must be uploaded before queue submission');
  assert(encoded.indexOf('write')<encoded.indexOf('render'),'The upload must precede rendering');
  assert(encoded.indexOf('render')<encoded.indexOf('submit'));
  assert.equal(lastPass.colorAttachments[0].view,null,'The cached descriptor must not retain its last texture view');
 }
 assert.equal(bufferCopies,0);assert.equal(bufferDestroyed,0);assert.equal(textureCreated-textureDestroyed,1);
 if(usePort==='stop-active') {
  await receive({data:{type:'stop'}});assert.equal(port.closed,true);assert.equal(textureDestroyed,textureCreated);assert.equal(destroyed,1);assert.equal(unconfigured,1);
  const count=uploads.length;tick();assert.equal(uploads.length,count);assert.equal(sandbox.ps2PixelPresenter.running,false);assert.equal(sandbox.ps2PixelPresenter.failed,false);
  lose({message:'Intentional device destruction'});await Promise.resolve();assert.deepEqual(failures,[]);producer.close();return;
 }
 producer.pause(true);await deliver();producer.publish(new Uint8Array([23,23,23,255]),1,1,false);await deliver();const count=uploads.length;tick();tick();assert.equal(uploads.length,count,'Pause must freeze presentation');
 producer.resize(80,60);producer.pause(false);await deliver();tick();assert.equal(uploads.at(-1).first,23);assert.deepEqual(viewports.at(-1).slice(0,4),[0,0,80,60]);assert.equal(textureCreated-textureDestroyed,1);
 runTimers();
 const heldStart=sandbox.ps2PixelPresenter.shown;
 producer.publish(new Uint8Array(64*4).fill(71),64,1,false);producer.publish(new Uint8Array(64*4).fill(72),64,1,false);await deliver();
 tick();assert.equal(uploads.at(-1).first,71);assert.equal(sandbox.ps2PixelPresenter.shown,heldStart+1);
 runTimers();assert.equal(uploads.at(-1).first,72);assert.equal(sandbox.ps2PixelPresenter.shown,heldStart+1,'Preparation must not present the next image');
 assert.equal(sandbox.ps2PixelPresenter.pendingFrames.length,1);const held=Array.from({length:3},(_,id)=>id).find(id=>Atomics.load(state,id*2)===2);assert.notEqual(held,undefined);assert.equal(producer.free.length,2);
 producer.publish(new Uint8Array(64*4).fill(73),64,1,false);await deliver();const beforePreparedDraw=uploads.length;tick();assert.equal(uploads.length,beforePreparedDraw,'A prepared frame must not upload again in RAF');assert.equal(sandbox.ps2PixelPresenter.shown,heldStart+2);
 runTimers();assert.equal(uploads.at(-1).first,73);producer.pause(true);await deliver();tick();assert.equal(sandbox.ps2PixelPresenter.shown,heldStart+2);producer.pause(false);await deliver();tick();assert.equal(sandbox.ps2PixelPresenter.shown,heldStart+3);assert.equal(producer.free.length,3);
 if(usePort==='stop-prepared'||usePort==='prepare-failure') {
  const shown=sandbox.ps2PixelPresenter.shown;
  if(usePort==='prepare-failure')failUpload=74;
  producer.publish(new Uint8Array(64*4).fill(74),64,1,false);await deliver();runTimers();
  if(usePort==='prepare-failure') {
   assert.equal(failures.length,1);assert.match(failures[0],/upload preparation failed/);assert.equal(sandbox.ps2PixelPresenter.failed,true);assert.equal(sandbox.ps2PixelPresenter.shown,shown);
  } else {
   assert.equal(sandbox.ps2PixelPresenter.pendingFrames.length,1);assert(Array.from({length:3},(_,id)=>Atomics.load(state,id*2)).includes(2));
   await receive({data:{type:'stop'}});assert.equal(timers.size,0);assert.equal(sandbox.ps2PixelPresenter.pendingFrames.length,0);assert.equal(textureDestroyed,textureCreated);assert.equal(destroyed,1);assert.equal(unconfigured,1);assert.equal(port.closed,true);
  }
  const count=uploads.length;tick();runTimers();assert.equal(uploads.length,count);assert.equal(sandbox.ps2PixelPresenter.running,false);producer.close();return;
 }
 lose({message:'QA device loss'});await Promise.resolve();await Promise.resolve();assert.equal(failures.length,1);const before=uploads.length;tick();assert.equal(uploads.length,before);producer.close();assert.equal(worker.terminated,1);
}
async function exerciseInitializationStop(phase){
 let adapterResolve,deviceResolve,deviceCalls=0,destroyed=0,configured=0,rafs=0,closed=0;const messages=[];
 const device={destroy(){++destroyed},lost:new Promise(()=>{}),addEventListener(){}};
 const devicePromise=new Promise(r=>deviceResolve=r),adapterPromise=new Promise(r=>adapterResolve=r);
 const adapter={requestDevice(){++deviceCalls;return phase==='device'?devicePromise:Promise.resolve(device)}};
 class Port{start(){}close(){++closed}postMessage(m){messages.push(m)}}
 const scope={SharedArrayBuffer,Uint8Array,Int32Array,MessagePort:Port,navigator:{userAgent:'Mozilla/5.0 Firefox/158.0',gpu:{requestAdapter:()=>adapterPromise,getPreferredCanvasFormat:()=> 'bgra8unorm'}},requestAnimationFrame(){++rafs},postMessage(m){messages.push(m)},addEventListener(){},importScripts(){scope.ps2webFrameClock=()=>({reset(){}})}};scope.self=scope;
 const context=vm.createContext(scope);vm.runInContext(fs.readFileSync(path.join(root,'web/pixel-presenter-worker.js'),'utf8'),context);const port=new Port();await scope.onmessage({data:{type:'connect',port}});
 const initializing=port.onmessage({data:{type:'init',version:1,canvas:{getContext(){return{configure(){++configured;throw Error('Initialization continued after stop')}}}},buffers:Array.from({length:3},()=>new SharedArrayBuffer(4)),slotState:new SharedArrayBuffer(24)}});
 if(phase==='device'){adapterResolve(adapter);await new Promise(setImmediate);assert.equal(deviceCalls,1)}
 await port.onmessage({data:{type:'stop'}});
 if(phase==='adapter')adapterResolve(adapter);else deviceResolve(device);
 await initializing;
 assert.equal(deviceCalls,phase==='device'?1:0,'Cancelled adapter request must not create a device');
 assert.equal(destroyed,phase==='device'?1:0,'Device returned after stop must be destroyed');
 assert.equal(configured,0);assert.equal(rafs,0);assert.equal(closed,1);assert.deepEqual(messages,[]);assert.equal(scope.ps2PixelPresenter.running,false);assert.equal(scope.ps2PixelPresenter.failed,false);
}
(async()=>{
 for(const phase of ['adapter','device'])await exerciseInitializationStop(phase);
 for(const mode of [false,true,'stop','stop-active','stop-prepared','prepare-failure'])await exercise(mode);
 console.log('PASS: Firefox preparation, worker/port transport, pixel ownership, upload order, resource cleanup, initialization cancellation, pause, resize and device loss');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>fs.rmSync(temp,{recursive:true,force:true}));
