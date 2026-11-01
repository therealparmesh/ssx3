// Asset-free direct GPU presentation and CPU-region fallback checks.
namespace {
void verify_direct_surface() {
    EM_ASM({
        Module.webglDirectSurface=true;Module.bufferedSurface=true;
        Module.canvas.width=128;Module.canvas.height=96;
        Module.qaBitmapCount=0;Module.qaBitmapPixels=0;
        Module.qaExpectedFrames=[];
        const frames=Module.surfaceFrames;const shift=frames.shift;
        Module.qaRestoreDirectShift=()=>{frames.shift=shift;};
        frames.shift=function(){
            const frame=shift.call(this);
            if(frame&&Module.qaBitmapFrame)Module.qaBitmapFrame({...frame,qaSeed:Module.qaExpectedFrames.shift()},ssx3CaptureWebglFrame(GLctx,frame));
            return frame;
        };
        Module.qaBitmapFrame=(frame,crop)=>{
            const meta=frame.qaSeed;
            if(meta.seed!==Module.qaBitmapCount+1)throw new Error("Bitmap frame FIFO order mismatch");
            const data=crop.getContext('2d').getImageData(0,0,frame.width,frame.height).data;
            const view=new DataView(data.buffer);
            for(let y=0;y<frame.height;y++)for(let x=0;x<frame.width;x++){
                const index=(meta.y+(meta.half?Math.floor(y/2):y))*meta.sourceWidth+meta.x+x;
                const expected=(0xff000000|meta.seed|(((index*7+meta.seed*3)&255)<<8)|(((index*11+meta.seed*5)&255)<<16))>>>0;
                if(view.getUint32((y*frame.width+x)*4,true)!==expected)
                    throw new Error('Bitmap CPU pixel oracle mismatch: '+JSON.stringify([meta.seed,x,y,view.getUint32((y*frame.width+x)*4,true),expected]));
            }
            Module.qaBitmapCount++;Module.qaBitmapPixels+=frame.width*frame.height;
        };
    });
    ps2::gs::gpu::SurfaceTarget target{};target.kind=ps2::gs::gpu::SurfaceTarget::Canvas;target.selector="#canvas";target.width=128;target.height=96;
    check(ps2::gs::gpu::attach_surface(target),"Bitmap fixture attaches real WebGL surface");
    for(unsigned seed=1;seed<=32;seed++){
        const auto original=source(seed);
        std::vector<std::uint32_t> data(original.width*original.height);
        for(unsigned i=0;i<data.size();i++)data[i]=pixel(seed,i);
        ps2::gs::State upload{};upload.bitbltbuf=std::uint64_t(original.fbw)<<48;upload.trxreg=original.width|(std::uint64_t(original.height)<<32);
        ps2::gs::gpu::image_begin(upload);ps2::gs::gpu::image_data(reinterpret_cast<const std::uint8_t*>(data.data()),data.size()*4);
        auto shown=original;
        if(seed%8==0){shown.dbx=4;shown.dby=3;shown.width=16;shown.height=7;shown.halved=true;}
        EM_ASM({Module.qaExpectedFrames.push({seed:$0,sourceWidth:$1,x:$2,y:$3,half:!!$4});},seed,original.width,shown.dbx,shown.dby,shown.halved);
        check(ps2::gs::gpu::present(shown),"Bitmap frame is queued without replacement");
    }
    for(unsigned wait=0;EM_ASM_INT({return Module.qaBitmapCount;})<32 && wait<500;wait++)emscripten_sleep(10);
    check(EM_ASM_INT({return Module.qaBitmapCount===32 && !Module.webglGpuError && Module.webglGpuStats.produced===32 && Module.webglGpuStats.presented===32 && Module.webglGpuStats.maximumQueued<=3;}),"All GPU bitmap frames reach the CPU pixel oracle in FIFO order");
    EM_ASM({window.qaProbe.bitmaps=({frames:Module.qaBitmapCount,pixels:Module.qaBitmapPixels,stats:{...Module.webglGpuStats}});delete Module.qaBitmapFrame;});
    EM_ASM({
        Module.qaCpuCount=0;Module.qaCpuPixels=0;
        Module.qaBitmapFrame=(frame,crop)=>{
            const meta=frame.qaSeed;
            if(meta.cpuSeed!==Module.qaCpuCount)throw new Error("CPU surface FIFO order mismatch");
            const data=crop.getContext('2d').getImageData(0,0,frame.width,frame.height).data;
            if(data.length!==meta.expected.length)throw new Error("CPU surface dimensions mismatch");
            for(let i=0;i<data.length;i++)if(data[i]!==meta.expected[i])throw new Error('CPU surface byte mismatch: '+JSON.stringify([meta.cpuSeed,i,data[i],meta.expected[i]]));
            Module.qaCpuCount++;Module.qaCpuPixels+=frame.width*frame.height;
        };
    });
    for(unsigned seed=0;seed<24;seed++){
        const unsigned formats[]={ps2::gs::PSMCT32,ps2::gs::PSMCT24,ps2::gs::PSMCT16,ps2::gs::PSMCT16S};
        DisplaySource shown{0,1,formats[seed%4],seed%2?3u:63u,seed%2?1022u:1u,seed%2?16u:7u,9u,seed%3==0};
        std::vector<std::uint32_t> expected;std::uint32_t width=0,height=0;
        check(ps2::gs::gpu::display(shown,expected,width,height),"Legacy CPU-region oracle returns image");
        EM_ASM({Module.qaExpectedFrames.push({cpuSeed:$0,expected:Array.from(HEAPU8.subarray($1,$1+$2))});},seed,expected.data(),expected.size()*4);
        if(seed==0){
            const auto produced=EM_ASM_INT({return Module.webglGpuStats.produced;});
            glBindTexture(GL_ARRAY_BUFFER,0);bool rejected=false;
            try{ps2::gs::gpu::present(shown);}catch(const std::exception&){rejected=true;}
            check(rejected,"CPU surface fallback reports earlier GL fault");
            check(glGetError()==GL_NO_ERROR,"CPU fallback consumes prior GL fault");
            check(produced==EM_ASM_INT({return Module.webglGpuStats.produced;}),"Failed CPU fallback must not enqueue an image");
        }
        check(ps2::gs::gpu::present(shown),"CPU-region fallback queues on GPU surface");
    }
    for(unsigned wait=0;EM_ASM_INT({return Module.qaCpuCount;})<24&&wait<500;wait++)emscripten_sleep(10);
    check(EM_ASM_INT({return Module.qaCpuCount===24&&!Module.webglGpuError&&Module.webglGpuStats.produced===56&&Module.webglGpuStats.presented===56&&Module.webglGpuStats.maximumQueued<=3;}),"All CPU fallback images present without replacement");
    EM_ASM({window.qaProbe.cpuSurface=({frames:Module.qaCpuCount,pixels:Module.qaCpuPixels,priorFaultRejected:true,stats:{...Module.webglGpuStats}});delete Module.qaBitmapFrame;Module.qaRestoreDirectShift();delete Module.qaRestoreDirectShift;delete Module.qaExpectedFrames;});
}
}
