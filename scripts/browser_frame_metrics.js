(disable=>{
  if(disable){Object.defineProperty(WebAssembly,'Suspending',{value:undefined});Object.defineProperty(WebAssembly,'promising',{value:undefined})}
  const make=()=>({intervals:0,withoutImage:0,overwritten:0,longRafGaps:0,maxRafGapMs:0,maxFreshGapMs:0,elapsedMs:0});
  window.qa={timerMaps:0,id:0,active:false,phase:'startup',phases:{},total:make(),lastTime:0,lastId:0,lastFresh:0,stamp:0,flip:false,ring:new Float64Array(32*7),ringIndex:0,events:[],longTasks:[],exclusions:[]};
  window.qaPhase=name=>{qa.phase=name;if(!qa.phases[name])qa.phases[name]=make()};
  window.qaActive=active=>{qa.active=active;qa.lastTime=0;qa.lastFresh=0;qa.exclusions.push({active,time:performance.now()})};
  const map=GPUBuffer.prototype.mapAsync;GPUBuffer.prototype.mapAsync=function(mode,offset,size){if(qa.active&&this.size===16)++qa.timerMaps;return map.call(this,mode,offset,size)};
  const draw=CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage=function(image,sx,sy,sw,sh,dx,dy,dw,dh){
   let result;
   if(arguments.length===5)result=draw.call(this,image,sx,sy,sw,sh);
   else if(arguments.length===3)result=draw.call(this,image,sx,sy);
   else if(arguments.length===9)result=draw.call(this,image,sx,sy,sw,sh,dx,dy,dw,dh);
   else result=draw.apply(this,arguments);
   if(this.canvas.id==='canvas')++qa.id;return result;
  };
  const add=(s,dt,n,freshGap)=>{++s.intervals;s.elapsedMs+=dt;s.maxRafGapMs=Math.max(s.maxRafGapMs,dt);s.maxFreshGapMs=Math.max(s.maxFreshGapMs,freshGap);if(dt>25)++s.longRafGaps;if(n===0)++s.withoutImage;else s.overwritten+=Math.max(0,n-1)};
  window.qaInstall=()=>{
   const sentinel=document.createElement('div');sentinel.style.cssText='position:fixed;left:-100px;top:-100px;width:1px;height:1px;contain:strict;visibility:hidden';document.body.append(sentinel);
   new ResizeObserver(()=>{
    if(!qa.active||!qa.id||!Module.running||Module.failed||Module.paused){qa.lastTime=qa.lastFresh=0;return}
    const t=qa.stamp,n=qa.id-qa.lastId,frame=Module._ps2web_frames(),offset=(qa.ringIndex++%32)*7;
    qa.ring[offset]=t;qa.ring[offset+1]=performance.now();qa.ring[offset+2]=qa.id;qa.ring[offset+3]=frame;qa.ring[offset+4]=Module.shownPending?1:0;qa.ring[offset+5]=Module.yieldWaiters?.length||0;qa.ring[offset+6]=Module.audioQueuedMs();
    if(qa.lastTime){
     const dt=t-qa.lastTime,freshGap=n&&qa.lastFresh?t-qa.lastFresh:0;
     add(qa.total,dt,n,freshGap);add(qa.phases[qa.phase],dt,n,freshGap);
     if((n===0||dt>25)&&qa.events.length<200)qa.events.push({phase:qa.phase,t,dt,n,frame,ringIndex:qa.ringIndex,ring:qa.ring.slice()});
    }
    if(n||!qa.lastFresh)qa.lastFresh=t;
    qa.lastTime=t;qa.lastId=qa.id;
   }).observe(sentinel);
   const tick=t=>{if(qa.active){qa.stamp=t;qa.flip=!qa.flip;sentinel.style.width=qa.flip?'1px':'2px'}requestAnimationFrame(tick)};requestAnimationFrame(tick);
   try{new PerformanceObserver(list=>{for(const e of list.getEntries())if(qa.active&&qa.longTasks.length<200)qa.longTasks.push({start:e.startTime,duration:e.duration,name:e.name})}).observe({type:'longtask',buffered:false})}catch{}
  };})(SSX3_DISABLE_JSPI);
