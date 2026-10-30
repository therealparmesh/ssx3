// Exercise actual shell UI reporting without replacing its frame accounting.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const shell=fs.readFileSync(process.env.SSX3_TEST_STATS_SHELL||path.join(__dirname,'../web/shell.html'),'utf8');
const first=shell.indexOf('  onFrame: (displayed) => {'),last=shell.indexOf('\n  noInitialRun: true,',first);assert(first>=0&&last>first);
function fixture(worker,debug=false){
 let now=0,presented=0,nativeFrames=0,text='',pending=false,pendingShown=0,resets=0;const writes=[],reads=[];
 const metric=(name,value)=>()=>{reads.push(name);return typeof value==='function'?value():value};
 const Module={preparing:false,presentCopy:true,bufferedSurface:false,paused:false,failed:false,
  _ps2web_frames:metric('frame',()=>nativeFrames),_ps2web_gpu_ms:metric('gpu',()=>now*.02),_ps2web_idle_ms:i=>{reads.push('idle');return now*[.1,.025,.05][i]},_ps2web_vu_interpreted:metric('interpreted',()=>nativeFrames),audioQueuedMs:metric('audio',40)};
 Object.defineProperty(Module,'HEAPU8',{get(){reads.push('heap');return {length:268435456}}});
 if(worker)Module.workerRuntime={status(name){reads.push('presented');assert.equal(name,'presented');return presented}};
 const statusEl={};
 const scope=vm.createContext({Module,performance:{now:()=>now},params:{has:key=>key==='debug'&&debug},statsEl:{get textContent(){return text},set textContent(value){text=value;writes.push(value)}},statusEl,hasPendingRuntimeCard:()=>pending,showPendingRuntimeCard:()=>++pendingShown,resetFrameStats(){++resets}});
 vm.runInContext('let frames=0,shown=0,fresh=false,last=0,lastWorkerShown=0,lastWorkerFrame=0,lastGpu=0,lastEmuIdle=0,lastRenderIdle=0,lastVuIdle=0,lastInterpreted=0',scope);
 Module.onFrame=vm.runInContext('({'+shell.slice(first,last)+'}).onFrame',scope);
 return {Module,writes,reads,scope,window(count=60,ms=1000){now+=ms;presented+=count;nativeFrames+=count;vm.runInContext('frames='+String(count-1)+';shown='+String(count),scope);Module.onFrame(false)},pending(){pending=true;Module.onFrame(false);return pendingShown},preparing(){Module.preparing=true;Module.onFrame(false);return {preparing:Module.preparing,resets,status:statusEl.textContent}},get text(){return text}};
}
let cases=0;
for(const worker of [false,true]){
 const f=fixture(worker);f.window();assert.deepEqual(f.writes,[],'Normal gameplay must not repaint the diagnostic HUD');++cases;
 for(let i=0;i<100;++i)f.window();assert.equal(f.writes.length,0,'Normal play must remain free of periodic HUD mutations');assert.deepEqual(f.reads,[],'Normal frame callbacks must not collect diagnostic counters');++cases;
 for(const count of [50,61,59,60,0])f.window(count);assert.equal(f.text,'');assert.equal(f.writes.length,0,'Changing frame rates must not reactivate the opt-in HUD');++cases;
 assert.equal(f.pending(),1,'Pending save feedback must run even without a status interval');++cases;
 assert.deepEqual(f.preparing(),{preparing:false,resets:1,status:'SSX 3'},'First-frame startup status must complete without debug mode');assert.equal(f.writes.length,0);++cases;
 const d=fixture(worker,true);d.window();assert.equal(d.writes.length,1);assert.match(d.text,/frame 60.*60\.0 fps.*60 on screen.*GPU 2%/);assert.match(d.text,/heap 256 MB.*audio 40 ms/);assert.match(d.text,/vu1 interpreted 60\/s/);d.window();assert.match(d.text,/frame 120.*GPU 2%/,'Debug deltas must retain their previous sample baselines');assert.equal(d.writes.length,2);++cases;
 d.window(50);assert.match(d.text,/frame 170.*50\.0 fps.*50 on screen/,'Debug mode must report actual slowdowns');d.window();assert.match(d.text,/frame 230.*60\.0 fps.*60 on screen/,'Debug mode must report recovery');++cases;
 const before=d.writes.length;assert.equal(d.pending(),1,'Debug mode must preserve pending save feedback');assert.equal(d.writes.length,before);++cases;
}
console.log('PASS: '+cases+' frame-status cases; normal HUD silence, opt-in actual FPS changes, direct/worker accounting, startup and pending-save feedback');
