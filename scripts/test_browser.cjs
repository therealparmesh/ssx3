const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base=(process.env.SSX3_TEST_URL || 'http://localhost:8620').replace(/\/$/,'');
const output=path.resolve(process.env.SSX3_TEST_OUTPUT || 'build/browser-qa');
fs.mkdirSync(output,{recursive:true});
const artifact=(name)=>path.join(output,name);
const state=process.env.SSX3_TEST_STATE || 'test.state';
const disableJspi=process.env.SSX3_TEST_DISABLE_JSPI==='1';
const configureContext=async context=>{
 if(disableJspi)await context.addInitScript(()=>{
  Object.defineProperty(WebAssembly,'Suspending',{configurable:true,value:undefined});
  Object.defineProperty(WebAssembly,'promising',{configurable:true,value:undefined});
 });
};
let qaBrowser;
(async()=>{
 const browser=qaBrowser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE || undefined,headless:true,args:['--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--disable-vulkan-surface']});
 const context=await browser.newContext({viewport:{width:1280,height:800},acceptDownloads:true});
 await configureContext(context);
 const page=await context.newPage();const messages=[];
 page.on('console',m=>{if(['error','warning'].includes(m.type()))messages.push({type:m.type(),text:m.text()})});
 page.on('pageerror',e=>messages.push({type:'pageerror',text:e.stack}));
 await page.goto(base+'/?state='+encodeURIComponent(state));
 if(disableJspi)assert.deepEqual(await page.evaluate(()=>[typeof WebAssembly.Suspending,typeof WebAssembly.promising]),['undefined','undefined']);
 await page.waitForFunction(()=>!document.querySelector('#start').disabled,null,{timeout:60000});
 assert.equal(await page.title(),'SSX 3');
 assert.match(await page.locator('#prototype').innerText(),/Experimental/);
 await page.screenshot({path:artifact('desktop-start.png')});
 // Verify durable IndexedDB storage before starting the game.
 await page.evaluate(()=>new Promise(resolve=>{
  FS.writeFile('/memcard/player-qa.txt','durable player save');
  storeCard(error=>resolve({error:!!error}));
 }));
 await page.reload();await page.waitForFunction(()=>!document.querySelector('#start').disabled,null,{timeout:60000});
 assert.equal(await page.evaluate(()=>FS.readFile('/memcard/player-qa.txt',{encoding:'utf8'})),'durable player save');
 // A second tab must not load a stale card and later overwrite this tab's save.
 const second=await context.newPage();
 await second.goto(base+'/');
 await second.waitForFunction(()=>Module.failed,null,{timeout:60000});
 assert.match(await second.locator('#help').textContent(),/another SSX 3 tab/);
 assert.equal(await second.evaluate(()=>FS.analyzePath('/memcard').exists),false);
 assert.equal(await second.locator('#import-card').isDisabled(),true);
 await page.evaluate(()=>new Promise((resolve,reject)=>{
  FS.writeFile('/memcard/player-qa.txt','latest save from owning tab');
  storeCard(error=>error?reject(error):resolve());
 }));
 await page.goto('about:blank');
 await second.reload();
 await second.waitForFunction(()=>!document.querySelector('#start').disabled,null,{timeout:60000});
 assert.equal(await second.evaluate(()=>!!Module.failed),false);
 assert.equal(await second.evaluate(()=>FS.readFile('/memcard/player-qa.txt',{encoding:'utf8'})),'latest save from owning tab');
 await second.close();
 await page.goto(base+'/?state='+encodeURIComponent(state));
 await page.waitForFunction(()=>!document.querySelector('#start').disabled,null,{timeout:60000});
 // Two writes arriving during an active save must serialize and both resolve.
 await page.evaluate(()=>{
  window.qaOriginalSync=FS.syncfs;window.qaSyncCallbacks=[];window.qaSaved=[];window.qaConcurrent=0;window.qaMaxConcurrent=0;
  FS.syncfs=(populate,callback)=>{++qaConcurrent;qaMaxConcurrent=Math.max(qaMaxConcurrent,qaConcurrent);qaSyncCallbacks.push(error=>{--qaConcurrent;callback(error)})};
  storeCard(error=>qaSaved.push(['first',!!error]));
 });
 await page.waitForFunction(()=>qaSyncCallbacks.length===1);
 await page.evaluate(()=>{storeCard(error=>qaSaved.push(['second',!!error]));qaSyncCallbacks[0](null)});
 await page.waitForFunction(()=>qaSyncCallbacks.length===2);
 await page.evaluate(()=>qaSyncCallbacks[1](null));
 assert.deepEqual(await page.evaluate(()=>qaSaved),[['first',false],['second',false]]);
 assert.equal(await page.evaluate(()=>qaMaxConcurrent),1);
 // A delayed failure also settles callers queued behind the failed write.
 await page.evaluate(()=>{qaSaved=[];qaSyncCallbacks=[];storeCard(error=>qaSaved.push(['first',!!error]));flushCard();storeCard(error=>qaSaved.push(['second',!!error]));flushCard()});
 await page.evaluate(()=>qaSyncCallbacks[0](new Error('QA queued storage failure')));
 assert.deepEqual(await page.evaluate(()=>qaSaved),[['first',true],['second',true]]);
 // A failed write must report failure to the caller and retain retry state.
 await page.evaluate(()=>{FS.syncfs=(populate,callback)=>callback(new Error('QA storage failure'));window.qaSaveFailed=null;storeCard(error=>qaSaveFailed=!!error)});
 await page.waitForFunction(()=>qaSaveFailed===true);
 assert.match(await page.locator('#save-status').textContent(),/Saving failed/);
 await page.evaluate(()=>{FS.syncfs=qaOriginalSync;return new Promise(resolve=>storeCard(error=>resolve(!error)))});
 assert.equal(await page.locator('#save-status').textContent(),'Saved on this device');
 // Completing an older browser write cannot hide a newer runtime file failure.
 await page.evaluate(()=>{
  FS.syncfs=(populate,done)=>{window.qaOlderSaveDone=done};
  storeCard();flushCard();
  window.qaPendingWait=waitForCard().then(()=>false,()=>true);
  Module.ps2CardSaveFailed();qaOlderSaveDone(null);
 });
 assert.equal(await page.evaluate(()=>qaPendingWait),true);
 assert.match(await page.locator('#save-status').textContent(),/could not be saved/);
 assert(await page.locator('#export-card').isDisabled());
 const pendingUrl=page.url();
 await page.locator('#overlay-options').click();
 await page.locator('#aspect').selectOption('16:9');
 await page.waitForFunction(()=>document.querySelector('#help').textContent.includes('game will retry'));
 assert.equal(page.url(),pendingUrl);
 assert.equal(await page.locator('#aspect').inputValue(),'4:3');
 assert(await page.locator('#recovery-export').isHidden());
 await page.evaluate(async()=>{FS.syncfs=qaOriginalSync;Module.ps2CardSaved();await waitForCard()});
 assert.equal(await page.locator('#save-status').textContent(),'Saved on this device');
 assert(await page.locator('#help').isHidden());
 assert(await page.locator('#export-card').isEnabled());
 await page.locator('#overlay-options').click();
 // Failed imports must restore the old bytes before Play becomes available.
 const cardHash=()=>page.evaluate(async()=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',FS.readFile('/memcard/Mcd001.ps2')))).map(x=>x.toString(16).padStart(2,'0')).join(''));
 await page.evaluate(async()=>{
  const card=new Uint8Array(8650752).fill(17);
  card.set(new TextEncoder().encode('Sony PS2 Memory Card Format '));
  FS.writeFile('/memcard/Mcd001.ps2',card);
  await new Promise((resolve,reject)=>storeCard(error=>error?reject(error):resolve()));
 });
 const oldHash=await cardHash();
 await page.evaluate(()=>{FS.syncfs=(populate,done)=>done(new Error('QA import storage failure'))});
 const replacement=Buffer.alloc(8650752,34);
 Buffer.from('Sony PS2 Memory Card Format ').copy(replacement);
 page.once('dialog',dialog=>dialog.accept());
 await page.locator('#import-file').setInputFiles({name:'replacement.ps2',mimeType:'application/octet-stream',buffer:replacement});
 await page.waitForFunction(()=>!cardImportBusy&&document.querySelector('#help').textContent.includes('previous memory card has been restored'));
 assert.equal(await cardHash(),oldHash);
 assert(await page.locator('#start').isEnabled());
 await page.evaluate(async()=>{
  FS.syncfs=qaOriginalSync;
  FS.unlink('/memcard/Mcd001.ps2');
  await new Promise((resolve,reject)=>storeCard(error=>error?reject(error):resolve()));
 });
 await page.locator('#start').click();
 await page.waitForFunction(()=>Module._ps2web_frames()>6150,null,{timeout:60000});
 const before=await page.evaluate(()=>({frames:Module._ps2web_frames(),prims:Module._ps2web_primitives(),stats:document.querySelector('#stats').textContent,copy:Module.presentCopy}));
 await page.evaluate(()=>{
  window.padEvents=[];window.plugEvents=[];window.pressureEvents=[];
  const pad=Module._ps2web_pad,plug=Module._ps2web_pad_connected,pressure=Module._ps2web_pressure;
  Module._ps2web_pad=(...args)=>{padEvents.push(args);return pad(...args)};
  Module._ps2web_pad_connected=(...args)=>{plugEvents.push(args);return plug(...args)};
  Module._ps2web_pressure=(...args)=>{pressureEvents.push(args);return pressure(...args)};
 });
 await page.keyboard.down('ArrowLeft');await page.keyboard.down('KeyZ');
 await page.waitForFunction(()=>padEvents.some(x=>x[0]===0&&(x[1]&0x4080)===0x4080&&x[2]===0));
 await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
 await page.waitForFunction(()=>Module.paused&&Module._ps2web_pause_ready()&&padEvents.filter(x=>x[0]===0).at(-1)[1]===0);
 assert.deepEqual(await page.evaluate(()=>padEvents.filter(x=>x[0]===0).at(-1)),[0,0,128,128,128,128]);
 await page.keyboard.up('ArrowLeft');await page.keyboard.up('KeyZ');await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 assert.equal(await page.evaluate(()=>Module.paused),true);
 await page.locator('#start').click();await page.waitForFunction(()=>!Module.paused);
 await page.keyboard.press('Enter',{delay:150});
 await page.waitForTimeout(500);
 await page.screenshot({path:artifact('desktop-pause.png')});
 await page.keyboard.press('KeyZ',{delay:150});await page.waitForTimeout(500);
 await page.evaluate(()=>{
  const gamepad=(index,buttons,axes)=>({index,id:'Standard QA gamepad',mapping:'standard',connected:true,buttons:Array.from({length:17},(_,i)=>({pressed:!!buttons[i],touched:!!buttons[i],value:buttons[i]||0})),axes});
  window.qaPads=[gamepad(0,{0:1,6:0.6},[-1,1,0.5,-0.5]),gamepad(1,{9:1},[0,0,0,0])];
  Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>qaPads});pollInput();
 });
 assert.deepEqual(await page.evaluate(()=>padEvents.filter(x=>x[0]===0).at(-1)),[0,0x4100,0,255,191,64]);
 assert.deepEqual(await page.evaluate(()=>padEvents.filter(x=>x[0]===1).at(-1)),[1,8,128,128,128,128]);
 assert.equal(await page.evaluate(()=>(pressureEvents.filter(x=>x[0]===0).at(-1)[3]>>>0)&255),153);
 // Focus loss must keep a held controller released until focus returns.
 await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
 await page.waitForFunction(()=>Module.paused&&Module._ps2web_pause_ready()&&padEvents.filter(x=>x[0]===0).at(-1)[1]===0);
 assert.deepEqual(await page.evaluate(()=>padEvents.filter(x=>x[0]===0).at(-1)),[0,0,128,128,128,128]);
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 assert.equal(await page.evaluate(()=>Module.paused),true);
 await page.locator('#start').click();await page.waitForFunction(()=>!Module.paused);
 await page.waitForFunction(()=>padEvents.filter(x=>x[0]===0).at(-1)[2]===0);
 // Controllers with two axes still steer; invalid axis values stay neutral.
 await page.evaluate(()=>{qaPads[0].axes=[1,-1];pollInput()});
 assert.deepEqual(await page.evaluate(()=>padEvents.filter(x=>x[0]===0).at(-1).slice(2)),[255,0,128,128]);
 await page.evaluate(()=>{qaPads[0].axes=[NaN,Infinity];pollInput()});
 assert.deepEqual(await page.evaluate(()=>padEvents.filter(x=>x[0]===0).at(-1).slice(2)),[128,128,128,128]);
 // Disconnecting player one's controller must not steal player two's controller.
 await page.evaluate(()=>{window.qaFirstPad=qaPads[0];qaPads[0]=null;pollInput()});
 assert.deepEqual(await page.evaluate(()=>padEvents.filter(x=>x[0]===0).at(-1)),[0,0,128,128,128,128]);
 assert.deepEqual(await page.evaluate(()=>padEvents.filter(x=>x[0]===1).at(-1)),[1,8,128,128,128,128]);
 assert.deepEqual(await page.evaluate(()=>plugEvents.filter(x=>x[0]===1).at(-1)),[1,1]);
 // Keyboard remains player one while the surviving controller stays player two.
 await page.keyboard.down('ArrowRight');
 await page.waitForFunction(()=>padEvents.filter(x=>x[0]===0).at(-1)[2]===255);
 assert.deepEqual(await page.evaluate(()=>padEvents.filter(x=>x[0]===1).at(-1)),[1,8,128,128,128,128]);
 await page.keyboard.up('ArrowRight');
 // Reconnecting on a new browser index fills the empty port; array order is irrelevant.
 await page.evaluate(()=>{qaFirstPad.index=4;qaPads=[qaPads[1],null,null,null,qaFirstPad];pollInput()});
 assert.equal(await page.evaluate(()=>padEvents.filter(x=>x[0]===0).at(-1)[1]),0x4100);
 assert.equal(await page.evaluate(()=>padEvents.filter(x=>x[0]===1).at(-1)[1]),8);
 // A temporary API error releases controls without forgetting surviving assignments.
 await page.evaluate(()=>Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>{throw new DOMException('QA temporary restriction','SecurityError')}}));
 await page.evaluate(()=>pollInput());
 assert.deepEqual(await page.evaluate(()=>padEvents.filter(x=>x[0]===0).at(-1)),[0,0,128,128,128,128]);
 await page.evaluate(()=>{Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>qaPads});pollInput()});
 assert.equal(await page.evaluate(()=>padEvents.filter(x=>x[0]===0).at(-1)[1]),0x4100);
 assert.equal(await page.evaluate(()=>padEvents.filter(x=>x[0]===1).at(-1)[1]),8);
 assert.deepEqual(await page.evaluate(()=>plugEvents.filter(x=>x[0]===1).at(-1)),[1,1]);
 await page.evaluate(()=>{qaPads=[];pollInput()});
 assert.deepEqual(await page.evaluate(()=>plugEvents.at(-1)),[1,0]);
 await page.locator('#fullscreen').click();assert.equal(await page.evaluate(()=>document.body.classList.contains('fullscreen')),true);
 await page.locator('#exit-fullscreen').click();assert.equal(await page.evaluate(()=>document.body.classList.contains('fullscreen')),false);
 assert.equal(await page.evaluate(()=>document.activeElement.id),'canvas');
 await page.keyboard.down('KeyZ');await page.waitForFunction(()=>padEvents.filter(x=>x[0]===0).at(-1)[1]&0x4000);await page.keyboard.up('KeyZ');
 // Restricted controller APIs cannot break keyboard input or the frame loop.
 await page.evaluate(()=>Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>{throw new DOMException('QA restriction','SecurityError')}}));
 await page.keyboard.down('ArrowRight');await page.waitForFunction(()=>padEvents.filter(x=>x[0]===0).at(-1)[2]===255);await page.keyboard.up('ArrowRight');
 await page.evaluate(()=>Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[]}));
 await page.locator('#settings summary').click();assert.equal(await page.locator('#scale').isVisible(),true);
 await page.screenshot({path:artifact('desktop-options.png')});
 await page.locator('#settings summary').click();
 await page.waitForTimeout(1000);await page.screenshot({path:artifact('desktop-race.png')});
 const after=await page.evaluate(()=>({frames:Module._ps2web_frames(),prims:Module._ps2web_primitives(),stats:document.querySelector('#stats').textContent,heap:Module.HEAPU8.length,audio:Module.audioQueuedMs()}));
 assert(after.frames>before.frames);assert(after.prims>before.prims);assert(!await page.locator('#overlay').isVisible());
 const layouts=[];
 for(const [name,w,h] of [['small-phone',320,568],['phone',390,844],['android',412,915],['landscape',844,390],['wrapped-landscape',667,375],['compact-landscape',568,320],['short-landscape',568,260]]){
  const mobile=await browser.newContext({viewport:{width:w,height:h},isMobile:true,hasTouch:true,deviceScaleFactor:1});
  await configureContext(mobile);
  const p=await mobile.newPage();p.on('pageerror',e=>messages.push({type:'mobile-pageerror',text:e.stack}));
  await p.goto(base+'/?touch&nocard&state='+encodeURIComponent(state));await p.waitForFunction(()=>!document.querySelector('#start').disabled,null,{timeout:60000});
  const start=await p.locator('#start').boundingBox();assert(start.x>=0&&start.y>=0&&start.x+start.width<=w&&start.y+start.height<=h);
  await p.screenshot({path:artifact(name+'-start.png')});
  await p.locator('#start').click();await p.waitForFunction(()=>Module.running && Module._ps2web_frames()>6150,null,{timeout:60000});
  const bounds=await p.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,buttons:[...document.querySelectorAll('.face .ctl,.dpad,.stick,#controls-toggle,#fullscreen')].map(x=>{const r=x.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,text:x.textContent}})}));
  assert(bounds.scrollWidth<=w);assert(bounds.scrollHeight<=h);
  for(const b of bounds.buttons)assert(b.x>=0&&b.y>=0&&b.x+b.w<=w+1&&b.y+b.h<=h+1,JSON.stringify({name,b}));
  const checkTouchTargets=async()=>{
   const result=await p.evaluate(()=>{
    const bar=document.querySelector('#bar').getBoundingClientRect();
    const controls=[...document.querySelectorAll('#touch [data-btn],#touch [data-dir],#touch .stick')];
    const toolbar=[...document.querySelectorAll('#bar > button:not([hidden]),#settings > summary,#exit-fullscreen')].filter(el=>el.getBoundingClientRect().width);
    return [...controls,...toolbar].map(el=>{
     const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
     return {text:el.textContent,id:el.id,x:r.x,y:r.y,w:r.width,h:r.height,reachable:el===hit||el.contains(hit),aboveToolbar:!controls.includes(el)||innerWidth<=innerHeight||!bar.height||r.bottom<=bar.top};
    });
   });
   for(const b of result){
    assert(b.x>=0&&b.y>=0&&b.x+b.w<=w+1&&b.y+b.h<=h+1,JSON.stringify({name,b}));
    assert(b.reachable&&b.aboveToolbar,JSON.stringify({name,b}));
   }
   return result;
  };
  await p.locator('#settings summary').tap();
  const menu = await p.locator('#settings-menu').boundingBox();
  assert(menu.x>=0 && menu.y>=0 && menu.x+menu.width<=w+1 && menu.y+menu.height<=h+1,JSON.stringify({name,menu}));
  for (const id of ['scale','aspect','boot','effects']) {
   await p.locator('#'+id).scrollIntoViewIfNeeded();
   const rect = await p.locator('#'+id).boundingBox();
   assert(rect.x>=0 && rect.y>=0 && rect.x+rect.width<=w+1 && rect.y+rect.height<=h+1,JSON.stringify({name,id,rect}));
  }
  bounds.settingsMenu=menu;
  await p.locator('#settings summary').tap();
  bounds.targets=await checkTouchTargets();
  const cross=await p.locator('[data-btn="16384"]').boundingBox();await p.touchscreen.tap(cross.x+cross.width/2,cross.y+cross.height/2);
  assert.equal(await p.locator('[data-btn="16384"]').getAttribute('class'),'ctl cr');
  await p.locator('#controls-toggle').tap();assert.equal(await p.locator('#touch').isVisible(),false);
  await p.locator('#controls-toggle').tap();assert.equal(await p.locator('#touch').isVisible(),true);
  await p.screenshot({path:artifact(name+'-controls.png')});
  if(w>h){
   await p.locator('#fullscreen').tap();await p.waitForFunction(()=>document.body.classList.contains('fullscreen')&&document.querySelector('#bar').getBoundingClientRect().height===0);
   bounds.fullscreenTargets=await checkTouchTargets();
   await p.screenshot({path:artifact(name+'-fullscreen.png')});
   await p.locator('#exit-fullscreen').tap();await p.waitForFunction(()=>!document.body.classList.contains('fullscreen'));
   await checkTouchTargets();
  }
  layouts.push({name,...bounds});await mobile.close();
 }
 fs.writeFileSync(artifact('results.json'),JSON.stringify({before,after,layouts,messages,disableJspi},null,2));
 console.log(JSON.stringify({before,after,layouts:layouts.map(x=>({name:x.name,viewport:[x.width,x.height],scroll:[x.scrollWidth,x.scrollHeight]})),messages},null,2));
 assert.equal(messages.filter(x=>x.type==='pageerror'||x.type==='mobile-pageerror').length,0);
 await browser.close();
})().catch(async e=>{console.error(e);if(qaBrowser)await qaBrowser.close();process.exitCode=1;});
