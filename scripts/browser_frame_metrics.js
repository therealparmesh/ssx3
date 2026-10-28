(disable=>{
  if(disable){Object.defineProperty(WebAssembly,'Suspending',{value:undefined});Object.defineProperty(WebAssembly,'promising',{value:undefined})}
  const make=()=>({intervals:0,withoutImage:0,overwritten:0,longRafGaps:0,maxRafGapMs:0,maxFreshGapMs:0,elapsedMs:0});
  const makeWall=()=>({intervals:0,elapsedMs:0,maxGapMs:0,longGaps:0,events:[]});
  window.qa={timerMaps:0,id:0,active:false,phase:'startup',phases:{},total:make(),lastTime:0,lastId:0,lastFresh:0,stamp:0,flip:false,ring:new Float64Array(32*7),ringIndex:0,events:[],longTasks:[],exclusions:[]};
  qa.wall=makeWall();qa.lastSubmission=null;
  window.qaPhase=name=>{qa.phase=name;if(!qa.phases[name])qa.phases[name]=make()};
  window.qaActive=active=>{qa.active=active;qa.lastTime=0;qa.lastFresh=0;qa.lastSubmission=null;if(active)qa.wall=makeWall();qa.exclusions.push({active,time:performance.now()})};
  // RAF timestamps can remain evenly spaced across a delayed callback. Record
  // actual successful submissions independently so that delay cannot pass QA.
  const submitted=(uploadMs,acquireMs,submitMs,encodeMs,uploadStart)=>{
   ++qa.id;
   if(!qa.active||!Module.running||Module.failed||Module.paused){qa.lastSubmission=null;return}
   const now=performance.now();
   if(qa.lastSubmission!==null){
    const gap=now-qa.lastSubmission;++qa.wall.intervals;qa.wall.elapsedMs+=gap;qa.wall.maxGapMs=Math.max(qa.wall.maxGapMs,gap);
    if(gap>25){++qa.wall.longGaps;if(qa.wall.events.length<200)qa.wall.events.push({time:now,gapMs:gap,phase:qa.phase,uploadMs:uploadMs??null,canvasAcquireMs:acquireMs??null,submitMs:submitMs??null,encodeMs:encodeMs??null,uploadAgeMs:uploadStart===undefined?null:now-uploadStart})}
   }
   qa.lastSubmission=now;
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
    if(visible)submitted(uploadMs,acquireMs,start===undefined?undefined:performance.now()-start,start===undefined||acquireEnd===undefined?undefined:start-acquireEnd,uploadStart);return result;
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
