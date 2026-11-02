const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const shell=fs.readFileSync(path.join(__dirname,'../web/shell.html'),'utf8');
const begin=shell.indexOf('function createScreenWakeLock(scope) {'),end=shell.indexOf('// End screen wake-lock lifecycle.',begin);
assert(begin>=0&&end>begin);const create=vm.runInNewContext('('+shell.slice(begin,end).trim()+')',{Promise});
const tick=()=>new Promise(setImmediate);
function fixture({supported=true,deny=false,throws=false}={}) {
 const requests=[],events=new Map(),pageEvents=new Map();
 const scope={document:{visibilityState:'visible',addEventListener:(name,fn)=>events.set(name,fn)},navigator:{},addEventListener:(name,fn)=>pageEvents.set(name,fn)};
 if(supported)scope.navigator.wakeLock={request(type){assert.equal(type,'screen');if(throws)throw Error('unavailable');if(deny)return Promise.reject(Error('denied'));let resolve;const promise=new Promise(r=>resolve=r);const record={resolve};requests.push(record);return promise;}};
 function lock(){const listeners=new Map();return{released:false,releases:0,addEventListener:(name,fn)=>listeners.set(name,fn),release(){++this.releases;this.released=true;listeners.get('release')?.();return Promise.resolve();},revoke(){this.released=true;listeners.get('release')?.();}};}
 return{scope,requests,lock,controller:create(scope),visible(value){scope.document.visibilityState=value?'visible':'hidden';events.get('visibilitychange')();},pagehide(){pageEvents.get('pagehide')();}};
}
(async()=>{
 const f=fixture(),c=f.controller;c.setActive(true);c.setActive(true);assert.equal(f.requests.length,1);
 const first=f.lock();f.requests[0].resolve(first);await tick();assert(c.held);c.setActive(true);assert.equal(f.requests.length,1);
 c.setActive(false);assert.equal(first.releases,1);assert(!c.held);c.setActive(false);assert.equal(first.releases,1);
 c.setActive(true);const second=f.lock();f.requests[1].resolve(second);await tick();assert(c.held);f.visible(false);assert.equal(second.releases,1);assert(!c.held);f.visible(true);assert.equal(f.requests.length,3);
 const third=f.lock();f.requests[2].resolve(third);await tick();assert(c.held);f.pagehide();assert.equal(third.releases,1);f.visible(true);assert.equal(f.requests.length,3);
 const race=fixture();race.controller.setActive(true);race.controller.setActive(false);race.controller.setActive(true);const stale=race.lock(),current=race.lock();race.requests[1].resolve(current);await tick();race.requests[0].resolve(stale);await tick();assert.equal(stale.releases,1);assert.equal(current.releases,0);assert(race.controller.held);
 const pending=fixture();pending.controller.setActive(true);pending.visible(false);const late=pending.lock();pending.requests[0].resolve(late);await tick();assert.equal(late.releases,1);assert(!pending.controller.held);assert.equal(pending.requests.length,1);
 const revoked=fixture();revoked.controller.setActive(true);const removed=revoked.lock();revoked.requests[0].resolve(removed);await tick();removed.revoke();assert(!revoked.controller.held);assert.equal(revoked.requests.length,1,'Platform revocation must not start a retry loop');revoked.controller.setActive(true);assert.equal(revoked.requests.length,2);
 for(const options of [{supported:false},{deny:true},{throws:true}]){const optional=fixture(options);optional.controller.setActive(true);await tick();assert(!optional.controller.held);optional.controller.setActive(false);}
 console.log('PASS screen wake lock: start/resume, duplicate requests, pause, visibility, pagehide, late grants, reordered grants, revocation, unsupported and denied APIs');
})().catch(error=>{console.error(error);process.exitCode=1});
