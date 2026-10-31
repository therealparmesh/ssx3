const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {create}=require('../web/pixel-producer.js');
const root=path.join(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'ssx3-prime-'));
execFileSync('python3',[root+'/scripts/export_frame_clock.py',root+'/web/frame-presentation.js',temp+'/frame-clock.js']);
async function exercise(firefox){
 let raf,listener,shown=0,workerCreated=0;const messages=[],timers=new Map(),pixels=[],failures=[];let timerId=0;
 class Worker{constructor(){++workerCreated}addEventListener(type,fn){if(type==='message')listener=fn}removeEventListener(){}postMessage(m){messages.push(structuredClone(m))}terminate(){}}
 for(const depth of [0,1,4,2.5,NaN])assert.throws(()=>create({Worker,primeFrames:depth}),/priming depth/);
 assert.equal(workerCreated,0,'Invalid depth must fail before creating a worker');
 const queue={writeTexture(_destination,data){pixels.push(data[0])},submit(){}};
 const device={queue,lost:new Promise(()=>{}),addEventListener(){},createShaderModule(){return{}},createRenderPipeline(){return{getBindGroupLayout(){return{}}}},createSampler(){return{}},createTexture(){return{createView(){return{}},destroy(){}}},createBindGroup(){return{}},createRenderBundleEncoder(){return{setPipeline(){},setBindGroup(){},draw(){},finish(){return{}}}},createCommandEncoder(){return{beginRenderPass(){return{setViewport(){},executeBundles(){},end(){}}},finish(){return{}}}}};
 const canvas={width:4,height:3,getContext(){return{configure(){},getCurrentTexture(){return{createView(){return{}}}}}}};
 const scope={Uint8Array,Int32Array,SharedArrayBuffer,Atomics,MessagePort:class{},navigator:{userAgent:firefox?'Firefox/158.0':'Chromium/156.0',gpu:{requestAdapter:async()=>({requestDevice:async()=>device}),getPreferredCanvasFormat:()=> 'bgra8unorm'}},GPUTextureUsage:{COPY_DST:1,TEXTURE_BINDING:2},setTimeout(fn){const id=++timerId;timers.set(id,fn);return id},clearTimeout(id){timers.delete(id)},requestAnimationFrame(fn){raf=fn},addEventListener(){},postMessage(m){listener({data:structuredClone(m)})}};
 scope.self=scope;const context=vm.createContext(scope);scope.importScripts=()=>vm.runInContext(fs.readFileSync(temp+'/frame-clock.js','utf8'),context);
 vm.runInContext(fs.readFileSync(root+'/web/pixel-presenter-worker.js','utf8'),context);
 const producer=create({Worker,url:'presenter',canvas:{},slotBytes:4,primeFrames:3,onPresent(){++shown},onFailure(e){failures.push(e.message)}});
 const deliver=async()=>{for(const m of messages.splice(0)){if(m.type==='init')m.canvas=canvas;await scope.onmessage({data:m})}};
 await deliver();await producer.ready;
 let stamp=0;const tick=()=>{raf(stamp+=1000/60)};
 const publish=async value=>{producer.publish(new Uint8Array([value,0,0,255]),1,1,false);await deliver()};
 const prepare=()=>{for(const [id,fn] of [...timers]){timers.delete(id);fn()}};
 await publish(1);await publish(2);tick();assert.equal(shown,0,'Two images cannot satisfy full-depth startup');
 await publish(3);tick();assert.equal(shown,1);prepare();
 tick();prepare();tick();assert.equal(shown,3);assert.deepEqual(pixels,[1,2,3]);
 // Pause with one pinned/prepared image. Resume must count it toward depth,
 // retain its ownership and wait for two fresh images, then show it first.
 await publish(4);prepare();producer.pause(true);await deliver();tick();
 producer.pause(false);await deliver();tick();assert.equal(shown,3);
 await publish(5);tick();assert.equal(shown,3);
 await publish(6);tick();assert.equal(shown,4);prepare();tick();prepare();tick();
 assert.equal(shown,6);assert.deepEqual(pixels,[1,2,3,4,5,6]);assert.equal(producer.free.length,3);
 assert.equal(producer.replacements,0);assert.deepEqual(failures,[]);producer.close();
}
(async()=>{await exercise(false);await exercise(true);console.log('PASS: full-depth startup/resume; two-frame wait; prepared-frame ownership/order; recovered slots; invalid-depth side-effect guard; Firefox and default scheduling.');})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(temp,{recursive:true,force:true}));
