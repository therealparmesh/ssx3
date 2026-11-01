mergeInto(LibraryManager.library, {
  ps2_webgl_prepare_context__deps: ['$specialHTMLTargets'],
  ps2_webgl_prepare_context: function() {
    const canvas = Module.webglDirectSurface ? Module.canvas : typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(640, 512)
      : globalThis.document ? document.createElement('canvas') : null;
    if (!canvas) return 0;
    Module.ps2WebglCanvas = canvas;
    specialHTMLTargets['!ps2-webgl'] = canvas;
    return 1;
  },
  ps2_webgl_init_readbacks__deps: ['$GL', '$ps2webglCreateReadbacks'],
  ps2_webgl_init_readbacks: function() {
    Module.ps2WebglReadbacks = ps2webglCreateReadbacks(GLctx);
  },
  ps2_webgl_resize_context: function(width, height) {
    if(Module.webglDirectSurface)return;
    const canvas = Module.ps2WebglCanvas;
    if (!canvas) return;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  }
});
