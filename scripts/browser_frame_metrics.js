(disable=>{
  // New-document observers can also run in startup or hosting frames where
  // WebGPU is unavailable. Leave those contexts untouched.
  if(typeof GPUBuffer==='undefined')return;
  if(disable){Object.defineProperty(WebAssembly,'Suspending',{value:undefined});Object.defineProperty(WebAssembly,'promising',{value:undefined})}
  const make=()=>({intervals:0,withoutImage:0,overwritten:0,longRafGaps:0,maxRafGapMs:0,maxFreshGapMs:0,elapsedMs:0});
  const makeWall=()=>({intervals:0,elapsedMs:0,maxGapMs:0,longGaps:0,rafSamples:0,outsideRafSamples:0,negativeRafLags:0,maxRafLagMs:0,events:[]});
  window.qa={timerMaps:0,id:0,active:false,phase:'startup',phases:{},total:make(),lastTime:0,lastId:0,lastFresh:0,stamp:0,flip:false,ring:new Float64Array(32*7),ringIndex:0,events:[],longTasks:[],exclusions:[]};
  qa.wall=makeWall();qa.lastSubmission=null;
  const makeGpu=enabled=>({enabled,frames:0,requested:0,completed:0,rejected:0,skipped:0,pending:0,maxPending:0,unknownRafSamples:0,clockErrors:0,maxNotificationLagMs:0,maxRafNotificationLagMs:0,events:[]});
  const gpuWaiters=new WeakMap();
  let gpuPending=0;
  qa.gpuEnabled=false;qa.gpu=makeGpu(false);
  // Opt-in only: completion requests can affect GPU progress. Notification
  // latency is an upper bound on completion, not a physical presentation time.
  window.qaGpuCompletions=enabled=>{
   if(qa.active)throw new Error('Stop measurement before changing GPU diagnostics');
   qa.gpuEnabled=!!enabled;
  };
  window.qaGpuSettled=(timeoutMs=5000)=>{
   if(qa.active)throw new Error('Stop measurement before awaiting GPU diagnostics');
   if(!Number.isFinite(timeoutMs)||timeoutMs<0)throw new TypeError('Invalid GPU diagnostic timeout');
   const state=qa.gpu;
   if(!state.pending)return Promise.resolve(state);
   return new Promise((resolve,reject)=>{
    let waiting=gpuWaiters.get(state);
    if(!waiting){waiting=new Set();gpuWaiters.set(state,waiting)}
    const entry={resolve,timer:null};waiting.add(entry);
    entry.timer=setTimeout(()=>{waiting.delete(entry);if(!waiting.size)gpuWaiters.delete(state);reject(new Error('GPU completion notifications timed out'));},timeoutMs);
   });
  };
  function gpuCompletion(queue,id,phase,rafStamp,submittedAt,longInterval){
   const state=qa.gpu;++state.frames;
   // Keep a hung device from accumulating an unbounded number of promises.
   // Skipped observations remain explicit and cannot establish full coverage.
   if(gpuPending>=16){++state.skipped;return}
   ++gpuPending;++state.requested;++state.pending;state.maxPending=Math.max(state.maxPending,state.pending);
   if(rafStamp===null)++state.unknownRafSamples;
   const finish=error=>{
    --gpuPending;--state.pending;
    if(error){++state.rejected;if(state.events.length<200)state.events.push({id,phase,error:String(error?.message||error)})}
    else{
     ++state.completed;const notifiedAt=performance.now(),afterSubmitMs=notifiedAt-submittedAt,afterRafMs=rafStamp===null?null:notifiedAt-rafStamp;
     const invalid=!Number.isFinite(afterSubmitMs)||afterSubmitMs<0||(afterRafMs!==null&&(!Number.isFinite(afterRafMs)||afterRafMs<0));
     if(invalid)++state.clockErrors;
     if(Number.isFinite(afterSubmitMs))state.maxNotificationLagMs=Math.max(state.maxNotificationLagMs,afterSubmitMs);
     if(afterRafMs!==null&&Number.isFinite(afterRafMs))state.maxRafNotificationLagMs=Math.max(state.maxRafNotificationLagMs,afterRafMs);
     if((longInterval||invalid||afterSubmitMs>25||afterRafMs>25)&&state.events.length<200)state.events.push({id,phase,submittedAt,notifiedAt,rafStamp,afterSubmitMs,afterRafMs});
    }
    if(!state.pending){const waiting=gpuWaiters.get(state);if(waiting){gpuWaiters.delete(state);for(const entry of waiting){clearTimeout(entry.timer);entry.resolve(state)}}}
   };
   try{const result=queue.onSubmittedWorkDone();if(!result||typeof result.then!=='function')throw new TypeError('GPU queue did not return a completion promise');Promise.resolve(result).then(()=>finish(),error=>finish(error||new Error('GPU completion rejected')))}catch(error){finish(error||new Error('GPU completion request failed'))}
  }
  // Submission spacing alone cannot identify a missed compositor frame.
  // Retain it, and separately record where a submit falls within its RAF.
  // Reuse wrappers for recurring callbacks; the observer adds no per-frame
  // callback allocation to a persistent presenter or sampler.
  qa.currentRafStamp=null;
  const nativeRaf=window.requestAnimationFrame,rafCallbacks=new WeakMap();
  window.requestAnimationFrame=function(callback){
   if(typeof callback!=='function')return nativeRaf.apply(this,arguments);
   let wrapped=rafCallbacks.get(callback);
   if(!wrapped){
    wrapped=function(stamp){
     const previous=qa.currentRafStamp;qa.currentRafStamp=stamp;
     try{return callback.call(this,stamp)}finally{qa.currentRafStamp=previous}
    };
    rafCallbacks.set(callback,wrapped);
   }
   return nativeRaf.call(this,wrapped);
  };
  window.qaPhase=name=>{qa.phase=name;if(!qa.phases[name])qa.phases[name]=make()};
  window.qaActive=active=>{qa.active=active;qa.lastTime=0;qa.lastFresh=0;qa.lastSubmission=null;if(active){qa.wall=makeWall();qa.gpu=makeGpu(qa.gpuEnabled)}qa.exclusions.push({active,time:performance.now()})};
  // Preserve actual successful submission intervals independently of nominal
  // RAF spacing. RAF-relative lag is diagnostic, not a replacement loss gate.
  const submitted=(uploadMs,acquireMs,submitMs,encodeMs,uploadStart,queue)=>{
   ++qa.id;
   if(!qa.active||!Module.running||Module.failed||Module.paused){qa.lastSubmission=null;return}
   const now=performance.now();
   const rafStamp=qa.currentRafStamp,rafLagMs=rafStamp===null?null:now-rafStamp;
   if(rafLagMs===null)++qa.wall.outsideRafSamples;
   else{++qa.wall.rafSamples;if(rafLagMs<0)++qa.wall.negativeRafLags;qa.wall.maxRafLagMs=Math.max(qa.wall.maxRafLagMs,rafLagMs)}
   let longInterval=false;
   if(qa.lastSubmission!==null){
    const gap=now-qa.lastSubmission;++qa.wall.intervals;qa.wall.elapsedMs+=gap;qa.wall.maxGapMs=Math.max(qa.wall.maxGapMs,gap);
    if(gap>25){longInterval=true;++qa.wall.longGaps;if(qa.wall.events.length<200)qa.wall.events.push({id:qa.id,time:now,gapMs:gap,phase:qa.phase,rafStamp,rafLagMs,uploadMs:uploadMs??null,canvasAcquireMs:acquireMs??null,submitMs:submitMs??null,encodeMs:encodeMs??null,uploadAgeMs:uploadStart===undefined?null:now-uploadStart})}
   }
   qa.lastSubmission=now;
   if(queue&&qa.gpuEnabled)gpuCompletion(queue,qa.id,qa.phase,rafStamp,now,longInterval);
  };
  const map=GPUBuffer.prototype.mapAsync;GPUBuffer.prototype.mapAsync=function(mode,offset,size){if(qa.active&&this.size===16)++qa.timerMaps;return map.call(this,mode,offset,size)};
  const draw=CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage=function(image,sx,sy,sw,sh,dx,dy,dw,dh){
   let result;
   if(arguments.length===5)result=draw.call(this,image,sx,sy,sw,sh);
   else if(arguments.length===3)result=draw.call(this,image,sx,sy);
   else if(arguments.length===9)result=draw.call(this,image,sx,sy,sw,sh,dx,dy,dw,dh);
   else result=draw.apply(this,arguments);
   if(this.canvas.id==='canvas')submitted();return result;
  };
  if(typeof GPUCanvasContext!=='undefined'&&typeof GPUQueue!=='undefined'){
   const texture=GPUCanvasContext.prototype.getCurrentTexture,submit=GPUQueue.prototype.submit,write=GPUQueue.prototype.writeTexture;
   let pending=false,uploadStart,uploadMs,acquireMs,acquireEnd;
   if(typeof write==='function')GPUQueue.prototype.writeTexture=function(destination,data,layout,size){
    if(!qa.active)return write.call(this,destination,data,layout,size);
    const start=performance.now(),result=write.call(this,destination,data,layout,size);
    uploadStart=start;uploadMs=performance.now()-start;return result;
   };
   const bufferWrite=GPUQueue.prototype.writeBuffer;
   if(typeof bufferWrite==='function')GPUQueue.prototype.writeBuffer=function(buffer,offset,data,dataOffset,size){
    // Match the texture-upload observer without allocating argument arrays.
    const start=qa.active?performance.now():undefined;
    let result;
    if(arguments.length===3)result=bufferWrite.call(this,buffer,offset,data);
    else if(arguments.length===4)result=bufferWrite.call(this,buffer,offset,data,dataOffset);
    else result=bufferWrite.call(this,buffer,offset,data,dataOffset,size);
    if(start!==undefined){uploadStart=start;uploadMs=performance.now()-start}return result;
   };
   GPUCanvasContext.prototype.getCurrentTexture=function(){
    const start=qa.active?performance.now():0,result=texture.call(this);
    if(this.canvas.id==='canvas'){pending=true;acquireEnd=qa.active?performance.now():undefined;acquireMs=acquireEnd===undefined?undefined:acquireEnd-start}return result;
   };
   GPUQueue.prototype.submit=function(commands){
    const visible=pending;pending=false;const start=qa.active&&visible?performance.now():undefined,result=submit.call(this,commands);
    if(visible)submitted(uploadMs,acquireMs,start===undefined?undefined:performance.now()-start,start===undefined||acquireEnd===undefined?undefined:start-acquireEnd,uploadStart,this);return result;
   };
  }
  const add=(s,dt,n,freshGap)=>{++s.intervals;s.elapsedMs+=dt;s.maxRafGapMs=Math.max(s.maxRafGapMs,dt);s.maxFreshGapMs=Math.max(s.maxFreshGapMs,freshGap);if(dt>25)++s.longRafGaps;if(n===0)++s.withoutImage;else s.overwritten+=Math.max(0,n-1)};
  window.qaInstall=()=>{
   // Install after the persistent presenter has registered its RAF callback.
   // Their callback order remains presenter first, sampler second each refresh.
   if(!Module.surfaceFrames&&!Module.blitFrames)throw new Error('Initialize the buffered or copy presenter before frame metrics');
   qa.sampler='after-presenter-raf';
   const observe=()=>{
    if(!qa.active||!qa.id||!Module.running||Module.failed||Module.paused){qa.lastTime=qa.lastFresh=0;return}
    const t=qa.stamp,n=qa.id-qa.lastId,frame=Module._ps2web_frames(),offset=(qa.ringIndex++%32)*7;
    qa.ring[offset]=t;qa.ring[offset+1]=performance.now();qa.ring[offset+2]=qa.id;qa.ring[offset+3]=frame;qa.ring[offset+4]=Module.shownPending?1:0;qa.ring[offset+5]=Module.yieldWaiters?.length||0;qa.ring[offset+6]=Module.audioQueuedMs();
    if(qa.lastTime){
     const dt=t-qa.lastTime,freshGap=n&&qa.lastFresh?t-qa.lastFresh:0;
     add(qa.total,dt,n,freshGap);add(qa.phases[qa.phase],dt,n,freshGap);
     if((n===0||dt>25)&&qa.events.length<200)qa.events.push({phase:qa.phase,t,dt,n,frame,queuedImages:(Module.presentCopy?Module.blitFrames:(Module.surfaceFrames||Module.blitFrames))?.length??null,freeSlots:(Module.presentCopy?Module.blitFree:(Module.surfaceFree||Module.blitFree))?.length??null,ringIndex:qa.ringIndex,ring:qa.ring.slice()});
    }
    if(n||!qa.lastFresh)qa.lastFresh=t;
    qa.lastTime=t;qa.lastId=qa.id;
   };
   const tick=t=>{if(qa.active){qa.stamp=t;observe()}requestAnimationFrame(tick)};requestAnimationFrame(tick);
   try{new PerformanceObserver(list=>{for(const e of list.getEntries())if(qa.active&&qa.longTasks.length<200)qa.longTasks.push({start:e.startTime,duration:e.duration,name:e.name})}).observe({type:'longtask',buffered:false})}catch{}
  };})(SSX3_DISABLE_JSPI);
