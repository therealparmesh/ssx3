// Private game/state inputs are supplied by the caller; this is not a release gate.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const p = require(process.env.PUPPETEER_MODULE || 'puppeteer-core');
const sourceClock = require('./browser_source_clock.js');
const kind = process.argv[2] || 'firefox', mode = process.argv[3] || 'performance';
assert(['firefox', 'chrome'].includes(kind));
assert(['performance', 'oracle'].includes(mode));
const referencePath = process.env.SSX3_TEST_REFERENCE;
const minimumSharedImages = Number(process.env.SSX3_TEST_MIN_SHARED_IMAGES || 1);
assert(Number.isSafeInteger(minimumSharedImages) && minimumSharedImages > 0, 'Minimum shared images must be a positive integer');
assert(!process.env.SSX3_TEST_MIN_SHARED_IMAGES || referencePath, 'Minimum shared images requires a reference');
assert(!referencePath || mode === 'oracle', 'Reference comparison requires oracle mode');
const reference = referencePath ? JSON.parse(fs.readFileSync(referencePath, 'utf8')).observation?.pixelHashes : null;
assert(!referencePath || (Array.isArray(reference) && reference.length > 0), 'Reference must contain pixel hashes');
if(reference) for(const frame of reference) {
  assert(Number.isSafeInteger(frame.imageSequence) && frame.imageSequence > 0 &&
    Number.isSafeInteger(frame.width) && frame.width > 0 && Number.isSafeInteger(frame.height) && frame.height > 0 &&
    /^[a-f0-9]{64}$/.test(frame.sha256), 'Invalid reference frame');
}
assert(!reference || new Set(reference.map(frame=>frame.imageSequence)).size === reference.length, 'Duplicate reference image sequence');
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
  await page.evaluateOnNewDocument(expected => { globalThis.qaExpectedImages = expected; },
    reference ? Object.fromEntries(reference.map(frame=>[frame.imageSequence,frame])) : {});
  await page.goto(url.href,{waitUntil:'domcontentloaded'});
  assert.equal(await page.title(),'SSX 3');
  await page.waitForFunction(()=>window.Module&&(Module.failed||document.getElementById('start').textContent==='Play SSX 3'),{timeout:120000});
  assert(await page.evaluate(()=>crossOriginIsolated && navigator.gpu===undefined && !Module.failed));
  const direct=await page.evaluate(()=>!!Module.webglDirectSurface);
  if(mode==='oracle'&&direct)
    await page.evaluate(fs.readFileSync(path.join(__dirname,'../tests/webgl_presenter/capture.js'),'utf8')+'\nvoid 0;');
  // Oracle hashing is separate from performance runs. Observe the native image
  // bytes before page scaling. Prepared-image sequence identifies each queued
  // copy; the native counter at delivery can be shared by multiple images.
  await page.evaluate(({oracle,first,last,oracleEvery,direct})=>{
    Module.qaImages=[];Module.qaHashJobs=[];Module.qaImageSequence=0;Module.qaOracleDifferences=[];
    if(!oracle)return;
    Object.defineProperty(Module,direct?'surfaceFrames':'blitFrames',{configurable:true,get(){return undefined},set(frames){
      Object.defineProperty(Module,direct?'surfaceFrames':'blitFrames',{value:frames,configurable:true,writable:true});
      const push=frames.push;
      frames.push=function(frame){
        const nativeFrame=Module._ps2web_frames(),imageSequence=++Module.qaImageSequence;
        if(nativeFrame>=first&&nativeFrame<last&&imageSequence%oracleEvery===0){
          const image=direct?ssx3ReadWebglFrame(Module.ps2WebglCanvas.getContext('webgl2'),frame):frame.image;
          const record={imageSequence,nativeFrame,width:image.width,height:image.height};Module.qaImages.push(record);
          Module.qaHashJobs.push(crypto.subtle.digest('SHA-256',image.data).then(bytes=>{
            record.sha256=Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');
            const expected=qaExpectedImages[imageSequence];
            if(expected && (expected.sha256!==record.sha256 || expected.width!==record.width || expected.height!==record.height)) {
              let binary='';
              for(let offset=0;offset<image.data.length;offset+=16384)
                binary+=String.fromCharCode(...image.data.subarray(offset,offset+16384));
              Module.qaOracleDifferences.push({...record,expectedSha256:expected.sha256,base64:btoa(binary)});
            }
          }));
        }
        return push.call(this,frame);
      };
    }});
  },{oracle:mode==='oracle',first,last,oracleEvery,direct});
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
  const observation=await page.evaluate(async()=>{await Promise.all(Module.qaHashJobs);return{pixelHashes:Module.qaImages,oracleDifferences:Module.qaOracleDifferences,failed:!!Module.failed,backend:Module.ps2GpuBackend}});
  assert(!observation.failed);assert.deepEqual(errors,[]);assert.deepEqual(warnings,[]);
  if(mode==='oracle')assert(observation.pixelHashes.length>0,'Pixel oracle must observe native images');
  await page.screenshot({path:path.join(out,'window-end.png')});
  for(const difference of observation.oracleDifferences) {
    const file='image-'+difference.imageSequence+'-mismatch.rgba';
    const bytes=Buffer.from(difference.base64,'base64');
    assert.equal(bytes.length,difference.width*difference.height*4, 'Incomplete mismatch capture');
    fs.writeFileSync(path.join(out,file),bytes);
    delete difference.base64;
    difference.file=file;
  }
  const actual=new Map(observation.pixelHashes.map(frame=>[frame.imageSequence,frame]));
  const shared=reference ? reference.filter(frame=>actual.has(frame.imageSequence)).length : 0;
  const comparison=reference ? {referenceImages:reference.length,sharedImages:shared,mismatches:observation.oracleDifferences.length} : null;
  const result={mode,oracleEvery,comparison,presentation:direct?'direct':'copy',browser:await browser.version(),explicitGpuOverrides:false,webgpuWithheld:true,
    origin:url.origin,playerPath:url.pathname,viewport:{width:1280,height:800,dpr:1},metric,observation,errors,warnings,
    limits:'Measurement only. Oracle hashing perturbs timing; compare performance runs separately. Game/state data remain private. Not a complete-race, display scanout, physical audio or release qualification.'};
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2)+'\n');
  // Preserve the complete result and raw pixels before rejecting the run.
  if(reference) {
    assert(shared >= minimumSharedImages, 'Reference comparison has fewer shared image sequences than required');
    assert.equal(observation.oracleDifferences.length,0,'Reference image mismatch; see result.json and captured RGBA files');
  }
  console.log(JSON.stringify({mode,first,last,images:metric.images,fps:metric.fps,nativeFps:metric.nativeFps,maxGap:metric.maxGap,
    underrunFrames:metric.av.underrunFrames,pixelHashes:observation.pixelHashes.length}));
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{if(browser)await browser.close()});
