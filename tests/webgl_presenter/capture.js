// Test-only logical-frame capture. Never linked into the game player.
globalThis.ssx3CaptureWebglFrame = function (gl, frame) {
  const previous = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
  const pack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
  const names = [
    gl.PACK_ALIGNMENT,
    gl.PACK_ROW_LENGTH,
    gl.PACK_SKIP_PIXELS,
    gl.PACK_SKIP_ROWS,
  ];
  const state = names.map((name) => gl.getParameter(name));
  const raw = new Uint8Array(frame.width * frame.height * 4);
  let readBuffer;
  try {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    names.forEach((name, i) => gl.pixelStorei(name, i ? 0 : 4));
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, frame.fbo);
    readBuffer = gl.getParameter(gl.READ_BUFFER);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(
      0,
      0,
      frame.width,
      frame.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      raw,
    );
    if (gl.getError()) throw Error("Logical frame capture failed");
  } finally {
    if (readBuffer !== undefined) gl.readBuffer(readBuffer);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previous);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
    names.forEach((name, i) => gl.pixelStorei(name, state[i]));
  }
  const pixels = new Uint8ClampedArray(raw.length);
  for (let y = 0; y < frame.height; y++)
    pixels.set(
      raw.subarray(
        (frame.height - 1 - y) * frame.width * 4,
        (frame.height - y) * frame.width * 4,
      ),
      y * frame.width * 4,
    );
  const canvas = new OffscreenCanvas(frame.width, frame.height);
  canvas
    .getContext("2d")
    .putImageData(new ImageData(pixels, frame.width, frame.height), 0, 0);
  return canvas;
};
