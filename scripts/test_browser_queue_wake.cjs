// Asset-required regression: withhold the older render-work wake paths.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const puppeteer=require(process.env.PUPPETEER_MODULE||'puppeteer-core');
const output=process.env.SSX3_TEST_OUTPUT||'/tmp/ssx3-queue-wake';
const expected=process.env.SSX3_TEST_EXPECT_WAKE!=='0';
let browser;
(async()=>{
  fs.mkdirSync(output,{recursive:true});
  browser=await puppeteer.launch({browser:'firefox',executablePath:process.env.FIREFOX_EXECUTABLE||'/usr/bin/firefox',headless:process.env.SSX3_TEST_HEADLESS==='1',networkEnabled:false,extraPrefsFirefox:process.env.SSX3_FIREFOX_WEBGPU==='1'?{'dom.webgpu.enabled':true}:{},defaultViewport:{width:1280,height:800}});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.stack));
  page.on('console',m=>{if(['error','warn','warning'].includes(m.type()))errors.push(m.text())});
  let metrics=fs.readFileSync(path.join(__dirname,'browser_frame_metrics.js'),'utf8').replace('SSX3_DISABLE_JSPI','true');
  metrics=metrics.replace('try{new PerformanceObserver',"try{if(PerformanceObserver.supportedEntryTypes.includes('longtask'))new PerformanceObserver");
  await page.evaluateOnNewDocument('if(typeof GPUBuffer!=="undefined"){'+metrics+'}');
  await page.evaluateOnNewDocument(()=>{
    const wait=Atomics.waitAsync,raf=requestAnimationFrame;
    const q=window.qaWakeFault={active:false,heldPromises:0,heldRefreshes:0,registeredRefreshes:0,registrations:0,retiredWhileHeld:0,pending:new Set(),deferred:[],currentId:0};
    Atomics.waitAsync=function(array,index,seen,timeout){
      const result=wait.apply(this,arguments);
      const id=++q.currentId;
      if(!q.active||timeout!==50||!result.async)return result;
      ++q.heldPromises;q.pending.add(id);
      return {async:true,value:result.value.then(value=>new Promise(resolve=>setTimeout(()=>{q.pending.delete(id);resolve(value)},50)))};
    };
    window.requestAnimationFrame=function(callback){
      if(q.active&&callback.name==='check'&&String(callback).includes('Atomics.load')){
        ++q.registeredRefreshes;
        return raf(t=>{++q.heldRefreshes;q.deferred.push(()=>callback(t))});
      }
      return raf(callback);
    };
  });
  await page.goto((process.env.SSX3_TEST_URL||'http://127.0.0.1:8679')+'/?nocard&intro=1');
  await page.waitForFunction(()=>document.querySelector('#start')?.textContent==='Play SSX 3'&&!document.querySelector('#start').disabled,{timeout:120000});
  assert.equal(await page.title(),'SSX 3');
  assert.equal(await page.evaluate(()=>crossOriginIsolated&&Module.bufferedSurface),true);
  await page.evaluate(()=>{
    let current,id,started;
    Object.defineProperty(Module,'renderWorkWake',{configurable:true,get:()=>current,set(value){
      if(typeof value==='function'){++qaWakeFault.registrations;id=qaWakeFault.currentId;started=performance.now()}
      else if(value===undefined&&current&&qaWakeFault.active&&qaWakeFault.pending.has(id)&&performance.now()-started<45)++qaWakeFault.retiredWhileHeld;
      current=value;
    }});
  });
  await page.click('#start');await page.waitForFunction(()=>Module._ps2web_frames()>1600,{timeout:120000});
  await page.evaluate(()=>{qaInstall();qaPhase('withheld queue wake delivery');qaWakeFault.active=true;qaActive(true);window.qaFaultStart={frame:Module._ps2web_frames(),time:performance.now()}});
  await new Promise(r=>setTimeout(r,2000));
  const result=await page.evaluate(()=>{
    qaActive(false);qaWakeFault.active=false;
    const q=qaWakeFault;
    const result={start:qaFaultStart,end:{frame:Module._ps2web_frames(),time:performance.now()},presentation:qa.total,actualSubmissions:qa.wall,heldPromises:q.heldPromises,registeredRefreshes:q.registeredRefreshes,heldRefreshes:q.heldRefreshes,registrations:q.registrations,retiredWhileHeld:q.retiredWhileHeld,failed:!!Module.failed};
    for(const callback of q.deferred.splice(0))queueMicrotask(callback);
    return result;
  });
  result.errors=errors;result.expectedExplicitWake=expected;
  fs.writeFileSync(output+'/result.json',JSON.stringify(result,null,2)+'\n');
  assert.deepEqual(errors,[]);assert.equal(result.failed,false);
  assert(result.heldPromises>0&&result.registeredRefreshes>0,'Both queue wake paths must actually be withheld');
  if(expected){
    assert(result.retiredWhileHeld>0,'The actual native producer must wake the renderer while both older paths are withheld');
    assert(result.end.frame-result.start.frame>=100,'Explicit notification must retain simulation progress');
    assert.equal(result.presentation.withoutImage,0,'Withheld old wake paths must not drain the candidate image queue');
    assert.equal(result.actualSubmissions.longGaps,0);
  }else{
    assert.equal(result.registrations,0);
    assert(result.presentation.withoutImage>0,'The old runtime must reproduce starvation with both wake paths withheld');
  }
  await page.click('#pause');await page.waitForFunction(()=>Module._ps2web_pause_ready()===1);
  const frame=await page.evaluate(()=>Module._ps2web_frames());await new Promise(r=>setTimeout(r,300));assert.equal(await page.evaluate(()=>Module._ps2web_frames()),frame);
  await page.screenshot({path:output+'/paused.png'});
  console.log(JSON.stringify({passed:true,expectedExplicitWake:expected,nativeProgress:result.end.frame-result.start.frame,missingImages:result.presentation.withoutImage,actualMaxMs:result.actualSubmissions.maxGapMs,retiredWhileHeld:result.retiredWhileHeld,errors}));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(browser)await browser.close()});
