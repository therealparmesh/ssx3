const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../web/staged-uploads.js'),'utf8');
let factory;
vm.runInNewContext(source,{addToLibrary:library=>factory=library.$ps2webUploadBuffers,Uint8Array,GPUBufferUsage:{MAP_WRITE:2,COPY_SRC:4},GPUMapMode:{WRITE:2}});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
function setup(){
 const lost=deferred(),buffers=[],maps=[];
 const device={lost:lost.promise,failCreate:false,failRange:false,scopes:0,scopeError:null,
  pushErrorScope(filter){assert.equal(filter,'out-of-memory');++this.scopes},
  popErrorScope(){assert(this.scopes>0);--this.scopes;return Promise.resolve(this.scopeError)},
  createBuffer(desc){
  if(this.failCreate)throw Error('Allocation unavailable');
  const record={memory:new ArrayBuffer(desc.size),state:'mapped',destroyed:false,submitted:false,
   ranges:[],
   getMappedRange(offset=0,size=this.memory.byteLength-offset){assert.equal(this.state,'mapped');assert(!this.destroyed);if(device.failRange)throw Error('Mapped range unavailable');assert.equal(offset%8,0);assert.equal(size%4,0);assert(size>0&&offset+size<=this.memory.byteLength);assert(!this.range);this.ranges.push({offset,size});this.range={offset,bytes:this.memory.slice(offset,offset+size)};return this.range.bytes},
   unmap(){assert.equal(this.state,'mapped');if(this.range){new Uint8Array(this.memory).set(new Uint8Array(this.range.bytes),this.range.offset);this.range=null}this.state='unmapped'},
   mapAsync(mode){assert.equal(mode,2);assert.equal(this.state,'unmapped');assert(this.submitted,'Remap must follow GPU submission');this.state='pending';const done=deferred();maps.push({record:this,done});return done.promise.then(()=>{this.state='mapped'})},
   destroy(){this.destroyed=true}};buffers.push(record);return record;
 }};
 const pool=factory(device),copies=[],encoder={copyBufferToBuffer(source,start,destination,offset,length){assert.equal(source.state,'unmapped');copies.push({source,start,destination,offset,length})}};
 const heap=new Uint8Array(128);for(let i=0;i<heap.length;++i)heap[i]=(i*17+5)&255;
 const data=new Uint8Array(32),params=new Uint8Array(16);
 const stage=()=>pool.stage(encoder,data,params,heap,8,32,72,16);
 const submit=()=>{for(const copy of copies){assert.equal(copy.source.state,'unmapped');copy.destination.set(new Uint8Array(copy.source.memory,copy.start,copy.length),copy.offset);copy.source.submitted=true}copies.length=0};
 const finish=async()=>{for(const item of maps.splice(0))item.done.resolve();await flush()};
 return{device,lost,buffers,maps,pool,copies,encoder,heap,data,params,stage,submit,finish};
}
(async()=>{
 const t=setup(),expectedData=t.heap.slice(8,40),expectedParams=t.heap.slice(72,88);
 const token=t.stage();assert(token);assert.equal(t.maps.length,0,'Encoding cannot start a mapping');t.heap.fill(0);t.submit();t.pool.submitted(token);t.pool.submitted(token);
 assert.equal(t.maps.length,1,'One submission starts exactly one map');assert.deepEqual(t.data,expectedData);assert.deepEqual(t.params,expectedParams);
 assert.equal(t.pool.stats.maps,0);await t.finish();assert.equal(t.pool.stats.maps,1);assert.equal(t.stage(),token,'A completed buffer must be reused');assert.equal(t.buffers.length,1);
 assert.deepEqual(t.buffers[0].ranges,[{offset:0,size:48},{offset:0,size:48}],'Every reused range must match the current upload size');
 const onlyParams=setup();assert(onlyParams.pool.stage(onlyParams.encoder,onlyParams.data,onlyParams.params,onlyParams.heap,0,0,72,16));assert.equal(onlyParams.copies.length,1);assert.equal(onlyParams.copies[0].start,0);
 const oversized=setup();assert.equal(oversized.pool.stage(oversized.encoder,null,null,oversized.heap,0,2*1024*1024,0,4),0);assert.equal(oversized.buffers.length,0);
 const bounded=setup();for(let i=0;i<256;++i)assert(bounded.stage());assert.equal(bounded.stage(),0);assert.equal(bounded.pool.stats.allocatedBytes,16*1024*1024);assert.equal(bounded.buffers.length,256);assert.equal(bounded.pool.stats.fallback,1);
 const cold=setup(),smallTokens=[];for(let i=0;i<256;++i)smallTokens.push(cold.stage());cold.submit();for(const id of smallTokens)cold.pool.submitted(id);await cold.finish();
 const largeHeap=new Uint8Array(1048640);for(let i=0;i<largeHeap.length;++i)largeHeap[i]=(i*13+7)&255;
 const largeData=new Uint8Array(1048576),largeParams=new Uint8Array(16),largeTokens=[];
 for(let i=0;i<8;++i){const id=cold.pool.stage(cold.encoder,largeData,largeParams,largeHeap,8,1048576,1048584,16);assert(id>0&&id<=256,'Retired token slots must be reused');largeTokens.push(id);assert(cold.pool.stats.allocatedBytes<=16*1024*1024)}
 assert.equal(cold.pool.stats.retired,256);assert.equal(cold.pool.stats.buffers,8);assert.equal(cold.buffers.filter(b=>!b.destroyed).length,8);assert.equal(cold.stage(),0,'In-flight large buffers cannot be reclaimed');
 cold.submit();for(const id of largeTokens)cold.pool.submitted(id);await cold.finish();assert.deepEqual(largeData,largeHeap.slice(8,1048584));assert.deepEqual(largeParams,largeHeap.slice(1048584,1048600));assert(cold.stage()>0);assert.equal(cold.buffers.filter(b=>!b.destroyed).find(b=>b.state==='unmapped').ranges.at(-1).size,48,'A small upload reused from a large buffer must expose only its own bytes');cold.pool.dispose();assert(cold.buffers.every(b=>b.destroyed));
 const rangeFailed=setup();rangeFailed.device.failRange=true;assert.equal(rangeFailed.stage(),0);assert.equal(rangeFailed.pool.stats.failures,1);assert(rangeFailed.buffers.every(b=>b.destroyed));assert.equal(rangeFailed.device.scopes,0);assert.equal(rangeFailed.stage(),0);
 const allocation=setup();allocation.device.failCreate=true;assert.equal(allocation.stage(),0);assert.equal(allocation.pool.stats.failures,1);assert.equal(allocation.stage(),0);
 assert.equal(allocation.device.scopes,0,'Allocation failures must close the temporary error scope');
 const oom=setup();oom.device.scopeError={message:'Out of memory'};oom.stage();await flush();assert.equal(oom.stage(),0);assert.equal(oom.pool.stats.failures,1);assert(oom.buffers.every(b=>b.destroyed));assert.equal(oom.device.scopes,0);
 const failed=setup(),failedToken=failed.stage();failed.submit();failed.pool.submitted(failedToken);failed.maps[0].done.reject(Error('Mapping failed'));await flush();await flush();assert.equal(failed.pool.stats.failures,1);assert(failed.buffers.every(b=>b.destroyed));assert.equal(failed.stage(),0);
 const lost=setup(),lostToken=lost.stage();lost.submit();lost.pool.submitted(lostToken);lost.lost.resolve({reason:'unknown'});await flush();assert(lost.buffers.every(b=>b.destroyed));await lost.finish();assert.equal(lost.stage(),0);assert.equal(lost.pool.stats.maps,0);
 const disposed=setup();disposed.stage();disposed.pool.dispose();disposed.pool.dispose();assert.equal(disposed.stage(),0);assert(disposed.buffers.every(b=>b.destroyed));
 const shell=fs.readFileSync(path.join(__dirname,'../web/shell.html'),'utf8'),selector=/stagedUploads:\s*(.+),/.exec(shell)[1];
 for(const [mode,userAgent,expected] of [['asyncify','Mozilla Firefox/158.0',true],['asyncify','Mozilla Firefox/158.0 Android',true],['jspi','Mozilla Firefox/158.0',false],['jspi','Mozilla Chrome/156.0',false],['asyncify','Mozilla Chrome/156.0',false],['asyncify','Mozilla Version/26.0 Mobile Safari/604.1',false],['asyncify','Mozilla FxiOS/158.0 Mobile Safari/604.1',false]])assert.equal(vm.runInNewContext('('+selector.replaceAll('@PS2_WEB_ASYNC@',mode)+')',{navigator:{userAgent}}),expected);
 const cpp=fs.readFileSync(path.join(__dirname,'../runtime/src/gs/gpu/gpu.cpp'),'utf8'),body=cpp.slice(cpp.indexOf('void submit(WGPUTextureView'));
 assert(body.indexOf('wgpuQueueSubmit(')<body.indexOf('ps2_webgpu_uploads_submitted(upload)'),'Start remapping after submitting the command buffer');
 assert(body.indexOf('ps2_webgpu_stage_uploads(')<body.indexOf('wgpuCommandEncoderBeginComputePass('),'Upload copies must precede dependent compute commands');
 console.log('PASS: exact-used mapped ranges and graceful range failure; staged upload bytes, reuse, cold size-class adaptation, submission order, memory bound, allocation/map failure, device loss, disposal and browser selection');
})().catch(error=>{console.error(error);process.exitCode=1});
