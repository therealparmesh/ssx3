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
 let nextRaf,lose,armed=true,protectedWrite=true,producer,state,worker,stamp=0;
 const uploads=[],viewports=[],failures=[];let destroyed=0,unconfigured=0;
 const device={destroy(){++destroyed},lost:new Promise(resolve=>{lose=resolve}),addEventListener(){},createShaderModule(){return{}},createRenderPipeline(){return{getBindGroupLayout(){return{}}}},createSampler(){return{}},createTexture(){return{createView(){return{}},destroy(){}}},createBindGroup(){return{}},createRenderBundleEncoder(){return{setPipeline(){},setBindGroup(){},draw(){},finish(){return{}}}},createCommandEncoder(){return{beginRenderPass(){return{setViewport(...args){viewports.push(args)},executeBundles(){},end(){}}},finish(){return{}}}},queue:{writeTexture(target,data){
  const before=data[0];
  if(protectedWrite){protectedWrite=false;producer.publish(new Uint8Array([11,11,11,255]),1,1,false)}
  assert.equal(data[0],before,'A pinned upload changed underneath the consumer');uploads.push({first:data[0],bytes:data.byteLength});
 },submit(){}}};
 const atomics={load:Atomics.load,store:Atomics.store,add:Atomics.add,compareExchange(array,index,expected,value){
  if(armed&&index===4&&expected===1&&value===2){armed=false;producer.publish(new Uint8Array(8).fill(99),2,1,true)}
  return Atomics.compareExchange(array,index,expected,value);
 }};
 const gpuContext={configure(){},unconfigure(){++unconfigured},getCurrentTexture(){return{createView(){return{}}}}};
 const canvas={width:64,height:32,getContext(){return gpuContext}};
 const sandbox={Uint8Array,Int32Array,Uint32Array,SharedArrayBuffer,Atomics:atomics,navigator:{gpu:{requestAdapter:async()=>({requestDevice:async()=>device}),getPreferredCanvasFormat:()=> 'bgra8unorm'}},GPUTextureUsage:{COPY_DST:1,TEXTURE_BINDING:2},requestAnimationFrame(fn){nextRaf=fn;return 1},addEventListener(){},postMessage(value){worker.emit(structuredClone(value))}};
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
 producer.pause(true);await deliver();producer.publish(new Uint8Array([23,23,23,255]),1,1,false);await deliver();const count=uploads.length;tick();tick();assert.equal(uploads.length,count,'Pause must freeze presentation');
 producer.resize(80,60);producer.pause(false);await deliver();tick();assert.equal(uploads.at(-1).first,23);assert.deepEqual(viewports.at(-1).slice(0,4),[0,0,80,60]);
 lose({message:'QA device loss'});await Promise.resolve();await Promise.resolve();assert.equal(failures.length,1);const before=uploads.length;tick();assert.equal(uploads.length,before);producer.close();assert.equal(worker.terminated,1);
}
(async()=>{
 for(const mode of [false,true,'stop'])await exercise(mode);
 console.log('PASS: worker/port transport, pixel ownership race, growth, wrap, FIFO, pause, resize, device loss and clean presenter stop');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>fs.rmSync(temp,{recursive:true,force:true}));
