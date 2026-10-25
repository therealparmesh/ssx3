// Cold boot through the opening movies; observe actual stereo worklet output.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const puppeteer = require(process.env.PUPPETEER_MODULE || 'puppeteer-core');
const output = process.env.SSX3_TEST_OUTPUT || '/tmp/ssx3-media';
const targetFrame = Number(process.env.SSX3_TEST_END_FRAME || 3000);
assert(Number.isSafeInteger(targetFrame) && targetFrame >= 3000);
let browser, monitor;
(async () => {
  fs.mkdirSync(output, {recursive:true});
  browser = await puppeteer.launch({browser:'firefox',executablePath:process.env.FIREFOX_EXECUTABLE || '/usr/bin/firefox',headless:process.env.SSX3_TEST_HEADLESS === '1',networkEnabled:false,
    extraPrefsFirefox:process.env.SSX3_FIREFOX_WEBGPU === '1' ? {'dom.webgpu.enabled':true} : {},defaultViewport:{width:1280,height:800}});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.stack));
  page.on('console', message => {if (['error','warn','warning'].includes(message.type())) errors.push(message.text());});
  let frameMetrics=fs.readFileSync(path.join(__dirname,'browser_frame_metrics.js'),'utf8').replace('SSX3_DISABLE_JSPI','true');
  frameMetrics=frameMetrics.replace('try{new PerformanceObserver',"try{if(PerformanceObserver.supportedEntryTypes.includes('longtask'))new PerformanceObserver");
  frameMetrics+=`;(()=>{const texture=GPUCanvasContext.prototype.getCurrentTexture,submit=GPUQueue.prototype.submit;let pending=false;GPUCanvasContext.prototype.getCurrentTexture=function(){const t=texture.call(this);if(this.canvas.id==='canvas')pending=true;return t};GPUQueue.prototype.submit=function(commands){const r=submit.call(this,commands);if(pending){++qa.id;pending=false}return r}})();`;
  await page.evaluateOnNewDocument('if(typeof GPUBuffer!=="undefined"){'+frameMetrics+'}');
  await page.evaluateOnNewDocument(() => {
    if (typeof AudioWorkletNode === 'undefined' || typeof AudioWorklet === 'undefined') return;
    window.qaAV = {buffer:new SharedArrayBuffer(256),states:[],processorInstrumented:false};
    const RealNode = AudioWorkletNode;
    window.AudioWorkletNode = class extends RealNode {
      constructor(context,name,options) {
        if (name === 'ps2-output') options.processorOptions.qaBuffer = qaAV.buffer;
        super(context,name,options);
      }
    };
    const addModule = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = async function(url, options) {
      let source = await (await fetch(url)).text();
      if (!source.includes("registerProcessor('ps2-output'")) return addModule.call(this,url,options);
      source = source.replace('this.left = 0;', 'this.qa = new Int32Array(options.processorOptions.qaBuffer,0,16); this.stats = new Float64Array(options.processorOptions.qaBuffer,128,8); this.left = 0;');
      source = source.replace("registerProcessor('ps2-output', Output);", `
        const original = Output.prototype.process;
        Output.prototype.process = function(inputs,outputs) {
          const enabled = Atomics.load(this.qa,0) === 1;
          const available = (Atomics.load(this.ring,0) - Atomics.load(this.ring,1)) >>> 0;
          const result = original.call(this,inputs,outputs);
          if (enabled) {
            const left=outputs[0][0],right=outputs[0][1],missing=Math.max(0,left.length-available);
            this.qa[1]++; this.qa[2]+=left.length; this.qa[3]+=missing;
            if (missing) this.qa[4]++;
            this.qa[8]=Math.min(this.qa[8],available); this.qa[9]=Math.max(this.qa[9],available);
            for(let i=0;i<left.length;i++) {
              const l=left[i],r=right[i];
              this.qa[5]=Math.max(this.qa[5],Math.round(Math.max(Math.abs(l),Math.abs(r))*32768));
              if(l===0 && r===0) this.qa[6]++;
              if(l<=-1 || l>=32767/32768 || r<=-1 || r>=32767/32768) this.qa[7]++;
              if(l!==r) this.qa[10]++;
              this.stats[0]+=l*l; this.stats[1]+=r*r;
            }
          }
          return result;
        };
        registerProcessor('ps2-output', Output);`);
      const instrumented = URL.createObjectURL(new Blob([source],{type:'application/javascript'}));
      try {await addModule.call(this,instrumented,options); qaAV.processorInstrumented=true;}
      finally {URL.revokeObjectURL(instrumented);}
    };
  });
  await page.goto((process.env.SSX3_TEST_URL || 'http://127.0.0.1:8680')+'/?nocard&intro=1');
  await page.waitForFunction(()=>document.querySelector('#start')?.textContent==='Play SSX 3'&&!document.querySelector('#start').disabled,{timeout:120000});
  assert.equal(await page.title(),'SSX 3');
  await page.click('#start');
  await page.waitForFunction(()=>Module._ps2web_frames()>1050,{timeout:120000});
  await page.keyboard.down('ArrowUp');await new Promise(r=>setTimeout(r,150));await page.keyboard.up('ArrowUp');
  await page.keyboard.down('z');await new Promise(r=>setTimeout(r,150));await page.keyboard.up('z');
  await new Promise(r=>setTimeout(r,500));
  assert.equal(await page.evaluate(()=>qaAV.processorInstrumented),true);
  await page.evaluate(()=>{
    qaAV.ints=new Int32Array(qaAV.buffer,0,16); qaAV.ints[8]=0x7fffffff;
    audio.addEventListener('statechange',()=>qaAV.states.push({state:audio.state,frame:Module._ps2web_frames(),paused:Module.paused}));
    qaAV.start={frame:Module._ps2web_frames(),time:performance.now(),audioTime:audio.currentTime,sampleRate:audio.sampleRate,baseLatency:audio.baseLatency??null,outputLatency:audio.outputLatency??null};
    qaInstall();qaPhase("opening-film-and-title");qaActive(true);Atomics.store(qaAV.ints,0,1);
  });
  const start = await page.evaluate(()=>qaAV.start);
  monitor=setInterval(async()=>{try{const state=await page.evaluate(()=>({frame:Module._ps2web_frames(),audio:Module.audioQueuedMs(),underrunFrames:qaAV.ints[3],total:qa.total,failed:!!Module.failed}));fs.writeFileSync(output+'/health.json',JSON.stringify(state));console.log('SAMPLE',JSON.stringify(state))}catch(error){console.log('SAMPLE_ERROR',error.message)}},15000);
  console.log('Measuring actual AudioWorklet output',JSON.stringify(start));
  const deadline = Date.now() + 400000;
  while (await page.evaluate(()=>Module._ps2web_frames()) < targetFrame) {
    assert(Date.now() < deadline, 'Opening playback did not reach the target frame');
    assert.equal(await page.evaluate(()=>!!Module.failed), false);
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  clearInterval(monitor); monitor=null;
  await page.evaluate(()=>{qaActive(false);Atomics.store(qaAV.ints,0,0); qaAV.end={frame:Module._ps2web_frames(),time:performance.now(),audioTime:audio.currentTime};});
  await page.click('#pause');
  await page.waitForFunction(()=>Module._ps2web_pause_ready()===1&&audio.state==='suspended');
  const paused = await page.evaluate(()=>({frame:Module._ps2web_frames(),audioTime:audio.currentTime}));
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.deepEqual(await page.evaluate(()=>({frame:Module._ps2web_frames(),audioTime:audio.currentTime})),paused);
  await page.screenshot({path:output+'/paused.png'});
  await page.click('#start');
  await page.waitForFunction(frame=>Module._ps2web_frames()>frame+30&&audio.state==='running',{},paused.frame);
  await page.evaluate(()=>audio.suspend());
  await page.waitForFunction(()=>Module.paused&&Module._ps2web_pause_ready()===1);
  const interruptedFrame=await page.evaluate(()=>Module._ps2web_frames());
  await page.click('#start');
  await page.waitForFunction(frame=>Module._ps2web_frames()>frame+30&&audio.state==='running',{},interruptedFrame);
  await page.click('#pause');
  await page.waitForFunction(()=>Module._ps2web_pause_ready()===1&&audio.state==='suspended');
  const result=await page.evaluate(()=>{
    const q=qaAV.ints,s=new Float64Array(qaAV.buffer,128,8);
    return {browser:navigator.userAgent,instrumented:qaAV.processorInstrumented,start:qaAV.start,end:qaAV.end,
      audio:{quanta:q[1],frames:q[2],underrunFrames:q[3],underrunQuanta:q[4],peak:q[5]/32768,zeroFrames:q[6],fullScaleFrames:q[7],minimumQueuedFrames:q[8],maximumQueuedFrames:q[9],stereoDifferentFrames:q[10],rmsLeft:Math.sqrt(s[0]/q[2]),rmsRight:Math.sqrt(s[1]/q[2])},
      presentation:{...qa.total,freshSubmissionsPerSecond:qa.total.intervals*1000/qa.total.elapsedMs},states:qaAV.states,failed:!!Module.failed,bufferedSurface:Module.bufferedSurface,checks:['actual 48 kHz stereo worklet output','pause freezes simulation and audio clock','explicit resume restores audio and simulation','simulated audio suspension pauses game and resumes']};
  });
  result.audioVsFrameElapsedDifferenceMs=1000*((result.end.audioTime-result.start.audioTime)-(result.end.frame-result.start.frame)/60);
  result.errors=errors;
  fs.writeFileSync(output+'/result.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
  assert.deepEqual(errors,[]); assert.equal(result.failed,false); assert(result.audio.frames>=48000*28);
  assert(Math.abs(result.audioVsFrameElapsedDifferenceMs)<50, "Audio and emulated frame clocks diverged");
  assert.equal(result.presentation.longRafGaps,0);assert.equal(result.presentation.overwritten,0);
  assert.equal(result.presentation.withoutImage,0);assert.equal(result.audio.underrunFrames,0); assert(result.audio.peak>0.01); assert(result.audio.stereoDifferentFrames>0);
  await browser.close(); browser=null;
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{clearInterval(monitor);if(browser)await browser.close();});
