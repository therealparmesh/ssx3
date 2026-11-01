(()=>{try{
 const gl=document.querySelector('canvas').getContext('webgl2');if(!gl)throw Error('Missing WebGL2');
 // A minimal bridge exercises the observer through real WebGL mutations.
 globalThis.Ps2OrderedRaster=class{constructor(){this.gl=gl;this.reservedTextureUnits=true;this.textureBindings=[];this.samplerBindings=[];}render(){}bindTextureUnit(unit,texture){if(this.textureBindings[unit]!==texture){gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,texture);}this.textureBindings[unit]=texture;}bindSamplerUnit(unit,sampler){if(this.samplerBindings[unit]!==sampler)gl.bindSampler(unit,sampler);this.samplerBindings[unit]=sampler;}};
 ssx3GlStateGuard.install();const bridge=new Ps2OrderedRaster(),cases=[];
 function expect(name,kind,fn){const n=ssx3GlStateGuard.errors.length;fn();const errors=ssx3GlStateGuard.errors.slice(n);if(kind ? errors.length!==1||errors[0].kind!==kind : errors.length!==0)throw Error(name+': '+JSON.stringify(errors));cases.push({name,passed:true});}
 const fbo=gl.createFramebuffer(),depth=gl.createRenderbuffer(),otherDepth=gl.createRenderbuffer();
 for(const d of [depth,otherDepth]){gl.bindRenderbuffer(gl.RENDERBUFFER,d);gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT32F,4,4);}
 gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,depth);
 expect('matching target depth',null,()=>bridge.render({targetFramebuffer:fbo,depthRenderbuffer:depth}));
 gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,otherDepth);
 expect('wrong target depth detected','target-depth-attachment',()=>bridge.render({targetFramebuffer:fbo,depthRenderbuffer:depth}));
 const a=gl.createTexture(),b=gl.createTexture();bridge.bindTextureUnit(5,a);
 expect('matching cached texture',null,()=>bridge.bindTextureUnit(5,a));
 gl.activeTexture(gl.TEXTURE5);gl.bindTexture(gl.TEXTURE_2D,b);
 expect('stale cached texture detected','cached-texture-binding',()=>bridge.bindTextureUnit(5,a));
 const sa=gl.createSampler(),sb=gl.createSampler();bridge.bindSamplerUnit(7,sa);
 expect('matching cached sampler',null,()=>bridge.bindSamplerUnit(7,sa));gl.bindSampler(7,sb);
 expect('stale cached sampler detected','cached-sampler-binding',()=>bridge.bindSamplerUnit(7,sa));
 gl.deleteSampler(sb);gl.activeTexture(gl.TEXTURE7);if(gl.getParameter(gl.SAMPLER_BINDING)!==null)throw Error('Unexpected native sampler at active unit');
 if(gl.getError())throw Error('GL fixture error');window.fixtureResult={passed:true,cases,expectedErrors:ssx3GlStateGuard.errors,checks:ssx3GlStateGuard.checks};document.querySelector('pre').textContent=JSON.stringify(fixtureResult,null,2);
}catch(e){window.fixtureResult={error:e.stack};}})();
