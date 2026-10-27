const fs = require('node:fs');
const assert = require('node:assert/strict');
const puppeteer = require(process.env.PUPPETEER_MODULE || 'puppeteer-core');
const output = process.env.SSX3_TEST_OUTPUT || 'build/browser-copy-wait';
const target = new URL(process.env.SSX3_TEST_URL || 'http://127.0.0.1:8724');
target.search = new URLSearchParams({copy:'',nocard:'',state:process.env.SSX3_TEST_STATE || 'test.state'}).toString();
fs.mkdirSync(output, {recursive:true});
const checks = [], errors = [], warnings = [];
let browser, page, failure;
const metadata = {};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = () => fs.writeFileSync(output+'/results.json',JSON.stringify({metadata,checks,errors,warnings,failure},null,2));
(async()=>{
  browser = await puppeteer.launch({browser:'chrome',executablePath:process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium',headless:process.env.SSX3_TEST_HEADLESS==='1',networkEnabled:false,userDataDir:output+'/profile',args:['--enable-unsafe-webgpu','--enable-features=Vulkan'],defaultViewport:{width:1280,height:800}});
  page = await browser.newPage();
  page.on('pageerror',error=>errors.push(error.stack));
  page.on('console',message=>{if(['error','warn','warning'].includes(message.type()))warnings.push(message.text());});
  const wait = (fn,...args)=>page.waitForFunction(fn,{polling:20,timeout:15000},...args);
  await page.goto(target.href);
  metadata.browser=await browser.version();
  metadata.url=page.url();metadata.viewport={width:1280,height:800};
  await wait(()=>document.querySelector('#start')?.textContent==='Play SSX 3'&&!document.querySelector('#start').disabled);
  assert.equal(await page.title(),'SSX 3');
  await page.click('#start');
  await page.waitForFunction(()=>Module._ps2web_frames()>=6200,{polling:20,timeout:60000});
  assert(await page.evaluate(()=>Module.prepareCopyFrames&&!!Module.blitClock&&!!Module.blitContext), 'Requires the JSPI primary runtime and prepared canvas-copy presenter');
  await page.evaluate(()=>{
    const nativeRAF = requestAnimationFrame, nativeCancel = cancelAnimationFrame;
    const scheduled = new Map(), held = new Map();
    let nextHeld = -1;
    window.qaWait = {holding:false,armed:false,events:[]};
    window.requestAnimationFrame = callback => {
      if(qaWait.holding){const id=nextHeld--;held.set(id,callback);return id;}
      const id = nativeRAF(time=>{scheduled.delete(id);callback(time);});
      scheduled.set(id,callback);return id;
    };
    window.cancelAnimationFrame = id => {if(!held.delete(id)){scheduled.delete(id);nativeCancel(id);}};
    qaWait.freeze = () => {
      qaWait.holding=true;
      for(const [id,callback] of scheduled){nativeCancel(id);held.set(id,callback);}
      scheduled.clear();
    };
    qaWait.thaw = () => {
      qaWait.holding=false;
      const callbacks=[...held.values()];held.clear();
      for(const callback of callbacks)requestAnimationFrame(callback);
    };
    let waiter = Module.surfaceYield;
    Object.defineProperty(Module,'surfaceYield',{configurable:true,get:()=>waiter,set:value=>{
      waiter=value;
      if(value&&qaWait.armed&&Module.blitFrames?.length===3){
        qaWait.armed=false;qaWait.freeze();
        qaWait.events.push({frame:Module._ps2web_frames(),queue:Module.blitFrames.length,audioMs:Module.audioQueuedMs(),holding:true,waiting:typeof value==='function',refresh:Module.blitClock.refreshInterval()});
      }
    }});
    // Hold only the display consumer. The producer may still legitimately
    // replace an image while refresh calibration selects its slow fallback.
    // Overriding the shared array's shift also breaks that producer path.
    const due=Module.blitClock.due;
    Module.blitClock.due=function(...args){const ready=due.apply(this,args);return !qaWait.armed&&ready;};
  });
  async function arm(){
    // Saturate the existing pool and hold consumption until the real producer
    // enters its capacity wait. A steady run may otherwise never fill it.
    await page.evaluate(()=>{
      assertPool();
      const latest=Module.blitFrames.at(-1);
      if(!latest)throw Error('A rendered image is required before saturation');
      while(Module.blitFrames.length<3){
        const frame=Module.blitFree.pop();
        frame.image=new ImageData(new Uint8ClampedArray(latest.image.data),latest.image.width,latest.image.height);
        frame.source=new OffscreenCanvas(frame.image.width,frame.image.height);
        frame.source.getContext('2d').putImageData(frame.image,0,0);frame.wide=latest.wide;
        Module.blitFrames.push(frame);
      }
      qaWait.armed=true;
      function assertPool(){if(Module.blitFrames.length+Module.blitFree.length!==3)throw Error('Copy pool must retain exactly three images');}
    });
    await wait(()=>qaWait.holding&&typeof Module.surfaceYield==='function');
    const event=await page.evaluate(()=>qaWait.events.at(-1));assert.equal(event.queue,3);assert.equal(event.waiting,true);return event;
  }
  async function frozen(label,event){
    await wait(()=>Module._ps2web_pause_ready()===1&&Module.surfaceYield===undefined);
    const frame=await page.evaluate(()=>Module._ps2web_frames());await sleep(350);
    assert.equal(await page.evaluate(()=>Module._ps2web_frames()),frame);
    const result=await page.evaluate(()=>({frame:Module._ps2web_frames(),paused:!!Module.paused,failed:!!Module.failed,holding:qaWait.holding,pauseReady:Module._ps2web_pause_ready(),capacityWait:typeof Module.surfaceYield==='function',shownWaits:Module.shownWaiters?.length??0,audio:audio.state,status:document.querySelector('#status').textContent}));
    assert.equal(result.shownWaits,0);checks.push({label,event,result,freezeMs:350});save();
  }
  async function resume(){
    const frame=await page.evaluate(()=>Module._ps2web_frames());
    await page.evaluate(()=>qaWait.thaw());await page.click('#start');
    await wait(f=>Module._ps2web_frames()>f+35,frame);
    assert.equal(await page.evaluate(()=>audio.state),'running');assert.equal(await page.evaluate(()=>!!Module.failed),false);
  }
  let event=await arm();await page.evaluate(()=>pausePlayer());await frozen('pause while full copy queue awaits held RAF',event);
  await page.screenshot({path:output+'/paused.png'});await resume();
  event=await arm();const other=await browser.newPage();await other.goto('about:blank');await other.bringToFront();
  await wait(()=>document.hidden&&Module.paused);await frozen('real background tab with full queue and held RAF',event);
  await page.bringToFront();await wait(()=>!document.hidden);await other.close();await resume();
  event=await arm();await page.evaluate(()=>Module.onHalt('QA full copy queue recovery'));await frozen('runtime failure retires full copy wait without another RAF',event);
  assert.equal(await page.$eval('#start',element=>element.textContent),'Reload player');
  await page.screenshot({path:output+'/failure.png'});
  const origin=await page.evaluate(()=>performance.timeOrigin);
  await page.evaluate(()=>qaWait.thaw());await page.click('#start');
  await page.waitForFunction(old=>performance.timeOrigin!==old,{polling:20,timeout:30000},origin);
  await page.waitForFunction(()=>document.querySelector('#start')?.textContent==='Play SSX 3'&&!document.querySelector('#start').disabled,{polling:20,timeout:60000});
  await page.click('#start');await page.waitForFunction(()=>Module._ps2web_frames()>=6200,{polling:20,timeout:60000});
  assert.equal(await page.evaluate(()=>!!Module.failed),false);assert.equal(await page.evaluate(()=>audio.state),'running');
  checks.push({label:'reload after stopped full queue creates clean playable runtime',newDocument:true});
  await page.screenshot({path:output+'/reloaded.png'});
  assert.equal(errors.length,0);assert.deepEqual(warnings,[]);
  save();console.log('PASS',JSON.stringify({checks:checks.length,errors,warnings}));await browser.close();
})().catch(async error=>{
  failure=error.stack;
  try {
    metadata.failureState=await page.evaluate(()=>({frame:Module._ps2web_frames(),failed:!!Module.failed,paused:!!Module.paused,refresh:Module.blitClock?.refreshInterval(),ready:Module.blitFrames?.length,free:Module.blitFree?.length,waiting:typeof Module.surfaceYield==='function',armed:window.qaWait?.armed,holding:window.qaWait?.holding}));
    await page.screenshot({path:output+'/unexpected-failure.png'});
  } catch {}
  save();console.error(error);if(browser)await browser.close();process.exitCode=1;
});
