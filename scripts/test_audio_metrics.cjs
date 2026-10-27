const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {instrumentAudioWorklet}=require('./browser_audio_metrics.js');
const shell=fs.readFileSync(path.join(__dirname,'../web/shell.html'),'utf8');
const raw=shell.match(/const workletSource = `([\s\S]*?)`;/)?.[1];assert(raw);
let instrument=instrumentAudioWorklet;
if(process.env.SSX3_AUDIO_METRIC_BASELINE_DRIVER){
  const driver=fs.readFileSync(process.env.SSX3_AUDIO_METRIC_BASELINE_DRIVER,'utf8');
  const a=driver.indexOf("source = source.replace('this.left = 0;',");
  const b=driver.indexOf('const instrumented =',a);assert(a>=0&&b>a);
  instrument=source=>vm.runInNewContext(driver.slice(a,b)+';source',{source});
}
function fixture({read=0,queued=0,refill=false}={}){
  const buffer=new SharedArrayBuffer(16+4096*4),ring=new Uint32Array(buffer,0,4),samples=new Int16Array(buffer,16);
  const qaBuffer=new SharedArrayBuffer(256),qa=new Int32Array(qaBuffer,0,16),stats=new Float64Array(qaBuffer,128,8);
  ring[0]=(read+queued)>>>0;ring[1]=read;ring[2]=4096;qa[0]=1;qa[8]=0x7fffffff;
  for(let i=0;i<4096;i++){samples[i*2]=4096;samples[i*2+1]=-8192;}
  let Output,writesRead=0;
  const atomics={store(view,index,value){
    if(view.buffer===buffer&&index===1&&refill==='late')Atomics.store(ring,0,(read+128)>>>0);
    return Atomics.store(view,index,value);
  },load(view,index){
    if(view.buffer===buffer&&index===0&&++writesRead===2&&refill===true)
      Atomics.store(ring,0,(read+128)>>>0);
    return Atomics.load(view,index);
  }};
  vm.runInNewContext(instrument(raw),{
    AudioWorkletProcessor:class{},Int16Array,Int32Array,Uint32Array,Float64Array,Atomics:atomics,
    registerProcessor(name,type){assert.equal(name,'ps2-output');Output=type;},
  });
  const output=new Output({processorOptions:{buffer,base:0,qaBuffer}});
  const channels=[new Float32Array(128),new Float32Array(128)];
  const process=()=>output.process([], [channels]);
  return {ring,qa,stats,channels,process};
}
{
  const f=fixture({refill:true});assert.equal(f.process(),true);
  assert.equal(f.ring[1],128);assert(f.channels[0].every(x=>x===0.125));assert(f.channels[1].every(x=>x===-0.25));
  assert.equal(f.qa[3],0,'Refill between observation and playback is not an underrun');
  if(!process.env.SSX3_AUDIO_METRIC_BASELINE_DRIVER){assert.equal(f.qa[11],128);assert.equal(f.qa[12],128);assert.equal(f.qa[13],1);}
}
for(const count of [0,1,32,64,127,128,256]){
  const f=fixture({queued:count});f.process();
  assert.equal(f.qa[3],Math.max(0,128-count),'Actual shortages remain visible');
  assert.equal(f.qa[4],count<128?1:0);assert.equal(f.ring[1],Math.min(128,count));
}
{
  const f=fixture({refill:'late'});f.process();
  assert.equal(f.ring[0],128);assert.equal(f.ring[1],0);
  assert.equal(f.qa[3],128,'Refill after playback took its snapshot cannot hide a real shortage');
  f.process();assert.equal(f.ring[1],128);assert.equal(f.qa[3],128,'The late samples remain available for the next quantum');
}
{
  const f=fixture({read:0xffffffc0,queued:128});f.process();assert.equal(f.ring[1],64);assert.equal(f.qa[3],0,'Unsigned read-counter wrap is not an underrun');
}
{
  const f=fixture({queued:256});f.qa[0]=0;const before=Array.from(f.qa);f.process();assert.equal(f.ring[1],128);assert.deepEqual(Array.from(f.qa),before,'Disabled sampling cannot change metrics');
}
assert.throws(()=>instrumentAudioWorklet(instrumentAudioWorklet(raw)),/uninstrumented/);
assert.throws(()=>instrumentAudioWorklet('different processor'),/uninstrumented/);
console.log('Audio metrics: concurrent refill, true shortages, rollover and disabled sampling passed');
