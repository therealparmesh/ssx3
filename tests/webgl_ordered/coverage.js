(async()=>{try{
 const gl=document.querySelector('canvas').getContext('webgl2',{antialias:false});if(!gl)throw Error('WebGL2 unavailable');let source=await(await fetch('kernel.frag')).text();
 const options=new URLSearchParams(location.search);
 if(options.has('floatCoverageFault')) {
  const begin=source.indexOf('bool triangleWeights('),end=source.indexOf('uint triangleDepth(',begin);
  if(begin<0||end<0)throw Error('Float coverage fault could not install');
  source=source.slice(0,begin)+"bool triangleWeights(vec2 p, vec2 a, vec2 b, vec2 c, bool interpolate,\n                     out vec3 weights) {\n  if (any(lessThan(p, ceil(min(a, min(b, c))))) ||\n      any(greaterThanEqual(p, ceil(max(a, max(b, c))))))\n    return false;\n  float area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);\n  if (area == 0.0)\n    return false;\n  float sg = area > 0.0 ? 1.0 : -1.0;\n  float e0 = (b.x - p.x) * (c.y - p.y) - (c.x - p.x) * (b.y - p.y),\n        e1 = (c.x - p.x) * (a.y - p.y) - (a.x - p.x) * (c.y - p.y),\n        e2 = (a.x - p.x) * (b.y - p.y) - (b.x - p.x) * (a.y - p.y);\n  if (!edgeIn(e0 * sg, (b.y - c.y) * sg, (c.x - b.x) * sg) ||\n      !edgeIn(e1 * sg, (c.y - a.y) * sg, (a.x - c.x) * sg) ||\n      !edgeIn(e2 * sg, (a.y - b.y) * sg, (b.x - a.x) * sg))\n    return false;\n  weights = vec3(0, 0, 1);\n  if (interpolate) {\n    float inverseArea = 1.0 / area;\n    weights.x = e0 * inverseArea;\n    weights.y = e1 * inverseArea;\n    weights.z = 1.0 - weights.x - weights.y;\n  }\n\n  return true;\n}\n"+source.slice(end);
 }
 if(options.has('hardwareCoverageFault')) {
  const original=gl.shaderSource.bind(gl);
  gl.shaderSource=(shader,code)=>original(shader,code.includes('flat out uint primitiveIndex;')?`#version 300 es
precision highp float;precision highp int;
uniform highp usampler2D vertices;uniform vec2 targetSize;
flat out uint primitiveIndex;
void main(){primitiveIndex=uint(gl_VertexID)/6u;uint at=(primitiveIndex*3u+uint(gl_VertexID)%3u)*2u;uvec4 v=texelFetch(vertices,ivec2(int(at%1024u),int(at/1024u)),0);vec2 p=uintBitsToFloat(v.xy);gl_Position=vec4((p+vec2(0.5))/targetSize*2.0-1.0,0,1);}`:code);
 }
 const raster=new Ps2OrderedRaster(gl,source),failures=[];let cases=0,pixels=0;
 const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(c[0]-a[0])*(b[1]-a[1]);
 function inside(v,x,y){const p=[x*16,y*16],area=cross(v[0],v[1],v[2]);if(area===0)return false;const sg=area>0?1:-1;
  if(x<Math.ceil(Math.min(...v.map(p=>p[0]))/16)||x>=Math.ceil(Math.max(...v.map(p=>p[0]))/16)||y<Math.ceil(Math.min(...v.map(p=>p[1]))/16)||y>=Math.ceil(Math.max(...v.map(p=>p[1]))/16))return false;
  for(let i=0;i<3;i++){const a=v[(i+1)%3],b=v[(i+2)%3],e=((a[0]-p[0])*(b[1]-p[1])-(b[0]-p[0])*(a[1]-p[1]))*sg,gx=(a[1]-b[1])*sg,gy=(b[0]-a[0])*sg;if(!(e>0||(e===0&&(gx>0||(gx===0&&gy>0)))))return false;}return true;
 }
 if(!inside([[0,0],[128,0],[0,128]],1,1)||inside([[0,0],[128,0],[0,128]],8,8))throw Error('Independent oracle self-check failed');
 const texture=gl.createTexture(),fbo=gl.createFramebuffer(),depth=gl.createRenderbuffer();
 for(const [width,height]of [[64,64],[512,448],[640,448],[511,447]]){
  gl.bindTexture(gl.TEXTURE_2D,texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.bindRenderbuffer(gl.RENDERBUFFER,depth);gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT32F,width,height);gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,depth);gl.drawBuffers([gl.COLOR_ATTACHMENT0]);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('Target incomplete');
  const anchors=[[10,10],[width>>1,height>>1],[Math.min(78,width-8),Math.max(8,height-79)]];
  for(const [px,py]of anchors){const directions=[];for(const dx of [-16,-1,0,1,16])for(const dy of [-16,-1,0,1,16])if(dx||dy)directions.push([dx,dy]);if(width>=512)directions.push([16383,8191],[8191,16383],[32767,16383],[16383,32767],[32767,32767],[4095,4094]);
   for(const [dx,dy]of directions)for(const side of [-1,1])for(const reverse of [false,true]){
    let vertices=[[px*16-dx,py*16-dy],[px*16+dx,py*16+dy],[px*16-dy*side,py*16+dx*side]];if(reverse)vertices=[vertices[1],vertices[0],vertices[2]];
    const words=new Uint32Array(24),floats=new Float32Array(words.buffer);for(let i=0;i<3;i++){floats[i*8]=vertices[i][0]/16;floats[i*8+1]=vertices[i][1]/16;words[i*8+2]=100;words[i*8+3]=0xff0000ff;}
    for(const mode of ['hardware','ordered']){const config=new Uint32Array(32);config[0]=3;config[4]=mode==='ordered'?0x80000000:0;config[7]=1;config[11]=((width-1)<<16)>>>0;config[12]=((height-1)<<16)>>>0;config[13]=1;config[22]=config[23]=1;config[24]=0xffffff;config[25]=1;config[27]=1;
     gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.disable(gl.SCISSOR_TEST);gl.colorMask(true,true,true,true);gl.depthMask(true);gl.clearColor(0,0,1,1);gl.clearDepth(0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);const hardwareBefore=raster.stats.opaqueBatches;raster.render({targetFramebuffer:fbo,colorTexture:texture,depthRenderbuffer:depth,width,height,settings:config,vertexWords:words});if((raster.stats.opaqueBatches>hardwareBefore)!==(mode==='hardware'))throw Error('Route not exercised');
     gl.bindFramebuffer(gl.READ_FRAMEBUFFER,fbo);gl.readBuffer(gl.COLOR_ATTACHMENT0);const data=new Uint8Array(5*5*4);gl.readPixels(px-2,py-2,5,5,gl.RGBA,gl.UNSIGNED_BYTE,data);const error=gl.getError();if(error)throw Error('GL error '+error);
     let count=0,first=null;for(let y=0;y<5;y++)for(let x=0;x<5;x++){const at=(y*5+x)*4,hit=inside(vertices,px-2+x,py-2+y),expected=hit?[255,0,0,255]:[0,0,255,255];pixels++;if(expected.some((v,c)=>data[at+c]!==v)){count++;if(!first)first={x:px-2+x,y:py-2+y,expected,actual:Array.from(data.subarray(at,at+4))};}}
     cases++;if(count&&failures.length<512)failures.push({width,height,anchor:[px,py],direction:[dx,dy],side,reverse,mode,vertices,count,first});
    }
   }
  }
  if(width>=511) for(const [px,py]of anchors) for(const reverse of [false,true]) for(const mirror of [-1,1]) {
    let vertices=[[-32767,-32766],[32766,32765],[32767,32766]].map(([x,y])=>[px*16+x*mirror,py*16+y]);
    if(reverse) vertices=[vertices[1],vertices[0],vertices[2]];
    const words=new Uint32Array(24),floats=new Float32Array(words.buffer);
    for(let i=0;i<3;i++){floats[i*8]=vertices[i][0]/16;floats[i*8+1]=vertices[i][1]/16;words[i*8+2]=100;words[i*8+3]=0xff0000ff;}
    for(const mode of ['hardware','ordered']) {
      const config=new Uint32Array(32);config[0]=3;config[4]=mode==='ordered'?0x80000000:0;config[7]=1;config[11]=((width-1)<<16)>>>0;config[12]=((height-1)<<16)>>>0;config[13]=1;config[22]=config[23]=1;config[24]=0xffffff;config[25]=1;config[27]=1;
      gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.disable(gl.SCISSOR_TEST);gl.colorMask(true,true,true,true);gl.depthMask(true);gl.clearColor(0,0,1,1);gl.clearDepth(0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);raster.render({targetFramebuffer:fbo,colorTexture:texture,depthRenderbuffer:depth,width,height,settings:config,vertexWords:words});
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER,fbo);gl.readBuffer(gl.COLOR_ATTACHMENT0);const data=new Uint8Array(5*5*4);gl.readPixels(px-2,py-2,5,5,gl.RGBA,gl.UNSIGNED_BYTE,data);const error=gl.getError();if(error)throw Error('GL error '+error);
      let count=0,first=null;for(let y=0;y<5;y++)for(let x=0;x<5;x++){const at=(y*5+x)*4,hit=inside(vertices,px-2+x,py-2+y),expected=hit?[255,0,0,255]:[0,0,255,255];pixels++;if(expected.some((v,c)=>data[at+c]!==v)){count++;if(!first)first={x:px-2+x,y:py-2+y,expected,actual:Array.from(data.subarray(at,at+4))};}}
      cases++;if(count&&failures.length<512)failures.push({width,height,anchor:[px,py],skinny:true,reverse,mirror,mode,vertices,count,first});
    }
  }
 }
 window.coverageResult={passed:failures.length===0,cases,pixels,failures,stats:raster.stats,glError:gl.getError(),scope:'Independent integer GS12.4 coverage:2664 cases,66600 sampled pixels at64x64,512x448,640x448,511x447. Includes exact-area2 skinny triangles in all three larger targets; constant colors, depth disabled.'};document.querySelector('pre').textContent=JSON.stringify(coverageResult,null,2);
}catch(error){window.coverageResult={passed:false,error:error.stack}}})();
