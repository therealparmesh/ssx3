// Private game/state inputs are supplied by the caller; this is not a release gate.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const p = require(process.env.PUPPETEER_MODULE || 'puppeteer-core');
const sourceClock = require('./browser_source_clock.js');
const kind = process.argv[2] || 'firefox', mode = process.argv[3] || 'performance';
assert(['firefox', 'chrome'].includes(kind));
assert(['performance', 'oracle'].includes(mode));
const oracleEvery = Number(process.env.SSX3_TEST_ORACLE_EVERY || 30);
assert(Number.isSafeInteger(oracleEvery) && oracleEvery > 0, 'SSX3_TEST_ORACLE_EVERY must be a positive integer');
const first = Number(process.env.SSX3_TEST_FIRST_FRAME), last = Number(process.env.SSX3_TEST_LAST_FRAME);
assert(Number.isSafeInteger(first) && first >= 0 && Number.isSafeInteger(last) && last > first,
  'Set SSX3_TEST_FIRST_FRAME and SSX3_TEST_LAST_FRAME to native field boundaries');
assert(process.env.SSX3_TEST_URL && process.env.SSX3_TEST_STATE_URL,
  'Supply SSX3_TEST_URL and SSX3_TEST_STATE_URL for your private player and state');
const url = new URL(process.env.SSX3_TEST_URL);
url.searchParams.set('state', process.env.SSX3_TEST_STATE_URL);
url.searchParams.set('nocard', '');
const out = process.env.SSX3_TEST_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'ssx3-fixed-state-'));
fs.mkdirSync(out, {recursive:true});
let browser, page;
const errors=[], warnings=[];
(async()=>{
  browser=await p.launch({...(kind==='firefox'?{browser:'firefox'}:{}),
    executablePath:kind==='firefox' ? process.env.SSX3_FIREFOX_BIN || '/usr/bin/firefox' : process.env.SSX3_CHROMIUM_BIN || '/usr/bin/chromium',
    headless:false, defaultViewport:{width:1280,height:800,deviceScaleFactor:1}});
  page=await browser.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());if(['warn','warning'].includes(message.type()))warnings.push(message.text())});
  await page.evaluateOnNewDocument(()=>{
    Object.defineProperty(navigator,'gpu',{value:undefined,configurable:true});
    Object.defineProperty(navigator,'getGamepads',{value:()=>[],configurable:true});
  });
  for(const file of ['browser_audio_metrics.js','browser_source_clock.js','browser_fixed_frame_metrics.js'])
    await page.evaluateOnNewDocument(fs.readFileSync(path.join(__dirname,file),'utf8'));
  await page.evaluateOnNewDocument(()=>{
    if(typeof AudioWorkletNode==='undefined'||typeof AudioWorklet==='undefined')return;
    window.qaAV={buffer:new SharedArrayBuffer(256),processorInstrumented:false};
    const RealNode=AudioWorkletNode, addModule=AudioWorklet.prototype.addModule;
    window.AudioWorkletNode=class extends RealNode {
      constructor(context,name,options){if(name==='ps2-output')options.processorOptions.qaBuffer=qaAV.buffer;super(context,name,options)}
    };
    AudioWorklet.prototype.addModule=async function(url,options){
      const source=await (await fetch(url)).text();
      if(!source.includes("registerProcessor('ps2-output'"))return addModule.call(this,url,options);
      const instrumented=URL.createObjectURL(new Blob([ssx3InstrumentAudioWorklet(source)],{type:'application/javascript'}));
      try{await addModule.call(this,instrumented,options);qaAV.processorInstrumented=true}finally{URL.revokeObjectURL(instrumented)}
    };
  });
  await page.goto(url.href,{waitUntil:'domcontentloaded'});
  assert.equal(await page.title(),'SSX 3');
  await page.waitForFunction(()=>window.Module&&(Module.failed||document.getElementById('start').textContent==='Play SSX 3'),{timeout:120000});
  assert(await page.evaluate(()=>crossOriginIsolated && navigator.gpu===undefined && !Module.failed));
  // Oracle hashing is separate from performance runs. Observe the native image
  // bytes before page scaling. Prepared-image sequence identifies each queued
  // copy; the native counter at delivery can be shared by multiple images.
  await page.evaluate(({oracle,first,last,oracleEvery})=>{
    Module.qaImages=[];Module.qaHashJobs=[];Module.qaImageSequence=0;
    if(!oracle)return;
    Object.defineProperty(Module,'blitFrames',{configurable:true,get(){return undefined},set(frames){
      Object.defineProperty(Module,'blitFrames',{value:frames,configurable:true,writable:true});
      const push=frames.push;
      frames.push=function(frame){
        const nativeFrame=Module._ps2web_frames(),imageSequence=++Module.qaImageSequence;
        if(nativeFrame>=first&&nativeFrame<last&&imageSequence%oracleEvery===0){
          const record={imageSequence,nativeFrame,width:frame.image.width,height:frame.image.height};Module.qaImages.push(record);
          Module.qaHashJobs.push(crypto.subtle.digest('SHA-256',frame.image.data).then(bytes=>{
            record.sha256=Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');
          }));
        }
        return push.call(this,frame);
      };
    }});
  },{oracle:mode==='oracle',first,last,oracleEvery});
  await page.bringToFront();await page.click('#start');
  await page.waitForFunction(()=>Module.failed||Module._ps2web_frames()>0,{timeout:90000});
  assert(await page.evaluate(()=>!Module.failed&&Module.ps2GpuBackend==='webgl'&&!Module.workerRuntime),
    'Requires the window-owned WebGL player');
  const metric=await page.evaluate(({first,last})=>ssx3MeasureFixedFrames({Module,memory:wasmMemory,audioContext:audio,qa:qaAV,first,last}),{first,last});
  metric.sourceClock=sourceClock.compare(metric.av.start.sourceClock,metric.av.end.sourceClock);
  assert.equal(metric.nativeFrames,last-first);
  assert.equal(metric.av.start.frame,first);assert.equal(metric.av.end.frame,last);
  assert(metric.sourceClock.passed,'Source audio/video clock observation must be valid');
  assert(metric.images>0&&metric.av.frames>0,'Observe actual images and audio worklet output');
  await page.evaluate(()=>document.getElementById('pause').click());
  await page.waitForFunction(()=>Module._ps2web_pause_ready(),{timeout:30000});
  const observation=await page.evaluate(async()=>{await Promise.all(Module.qaHashJobs);return{pixelHashes:Module.qaImages,failed:!!Module.failed,backend:Module.ps2GpuBackend}});
  assert(!observation.failed);assert.deepEqual(errors,[]);assert.deepEqual(warnings,[]);
  if(mode==='oracle')assert(observation.pixelHashes.length>0,'Pixel oracle must observe native images');
  await page.screenshot({path:path.join(out,'window-end.png')});
  const result={mode,oracleEvery,browser:await browser.version(),explicitGpuOverrides:false,webgpuWithheld:true,
    origin:url.origin,playerPath:url.pathname,viewport:{width:1280,height:800,dpr:1},metric,observation,errors,warnings,
    limits:'Measurement only. Oracle hashing perturbs timing; compare performance runs separately. Game/state data remain private. Not a complete-race, display scanout, physical audio or release qualification.'};
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({mode,first,last,images:metric.images,fps:metric.fps,nativeFps:metric.nativeFps,maxGap:metric.maxGap,
    underrunFrames:metric.av.underrunFrames,pixelHashes:observation.pixelHashes.length}));
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{if(browser)await browser.close()});
