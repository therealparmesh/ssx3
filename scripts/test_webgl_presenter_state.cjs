const fs = require("node:fs"),
  assert = require("node:assert/strict"),
  p = require(process.env.PUPPETEER_MODULE || "puppeteer-core");
const kind = process.argv[2] || "chrome",
  output =
    process.env.SSX3_TEST_OUTPUT ||
    fs.mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), "ssx3-presenter-"),
    );
fs.mkdirSync(output, { recursive: true });
const origin =
  process.env.SSX3_WEBGL_PRESENTER_ORIGIN || "http://127.0.0.1:8370/";
assert(["chrome", "firefox"].includes(kind), "Choose chrome or firefox");
(async () => {
  const browser = await p.launch({
    ...(kind === "firefox" ? { browser: "firefox" } : {}),
    executablePath:
      kind === "firefox"
        ? process.env.SSX3_FIREFOX_BIN || "/usr/bin/firefox"
        : process.env.SSX3_CHROMIUM_BIN || "/usr/bin/chromium",
    headless: false,
  });
  try {
    const page = await browser.newPage();
    await page.goto(new URL("fixture.html", origin).href);
    const state = await page.evaluate(() => {
      const program = gl.createProgram();
      for (const [kind, source] of [
        [
          gl.VERTEX_SHADER,
          "#version 300 es\nvoid main(){gl_Position=vec4(0); }",
        ],
        [
          gl.FRAGMENT_SHADER,
          "#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(1);}",
        ],
      ]) {
        const s = gl.createShader(kind);
        gl.shaderSource(s, source);
        gl.compileShader(s);
        gl.attachShader(program, s);
        gl.deleteShader(s);
      }
      gl.linkProgram(program);
      gl.useProgram(program);
      const vao = gl.createVertexArray(),
        fbo0 = gl.createFramebuffer(),
        fbo1 = gl.createFramebuffer(),
        tex0 = gl.createTexture(),
        tex2 = gl.createTexture(),
        sampler = gl.createSampler(),
        unpack = gl.createBuffer();
      gl.bindVertexArray(vao);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo0);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo1);
      GL.framebuffers[9] = fbo0;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex0);
      gl.bindSampler(0, sampler);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, tex2);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, unpack);
      gl.viewport(3, 4, 51, 65);
      gl.colorMask(true, false, true, false);
      gl.clearColor(0.125, 0.25, 0.5, 0.75);
      gl.enable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.SCISSOR_TEST);
      gl.enable(gl.DITHER);
      gl.disable(gl.CULL_FACE);
      const flags = [
        gl.BLEND,
        gl.DEPTH_TEST,
        gl.STENCIL_TEST,
        gl.CULL_FACE,
        gl.SCISSOR_TEST,
        gl.RASTERIZER_DISCARD,
        gl.DITHER,
      ];
      function check() {
        const mask = gl.getParameter(gl.COLOR_WRITEMASK),
          viewport = gl.getParameter(gl.VIEWPORT),
          clear = gl.getParameter(gl.COLOR_CLEAR_VALUE);
        const active = gl.getParameter(gl.ACTIVE_TEXTURE),
          texture = gl.getParameter(gl.TEXTURE_BINDING_2D);
        gl.activeTexture(gl.TEXTURE0);
        const texture0 = gl.getParameter(gl.TEXTURE_BINDING_2D),
          sampler0 = gl.getParameter(gl.SAMPLER_BINDING);
        gl.activeTexture(active);
        return (
          gl.getParameter(gl.CURRENT_PROGRAM) === program &&
          gl.getParameter(gl.VERTEX_ARRAY_BINDING) === vao &&
          gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) === fbo0 &&
          gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) === fbo1 &&
          active === gl.TEXTURE2 &&
          texture === tex2 &&
          texture0 === tex0 &&
          sampler0 === sampler &&
          gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING) === unpack &&
          JSON.stringify(Array.from(viewport)) === "[3,4,51,65]" &&
          JSON.stringify(Array.from(mask)) === "[true,false,true,false]" &&
          JSON.stringify(Array.from(clear)) === "[0.125,0.25,0.5,0.75]" &&
          JSON.stringify(flags.map((n) => gl.isEnabled(n))) ===
            "[true,true,false,false,true,false,true]"
        );
      }
      const before = Array.from(qa.live, ([k, s]) => [k, new Set(s)]);
      const p = Module.webglGpuPresenter;
      p.source(16, 16);
      const afterSource = check();
      p.enqueue(qa.meta, () => {});
      const afterEnqueue = check();
      p.enqueue(qa.meta, () => {});
      qa.step(1000);
      const afterDraw = check();
      p.dispose();
      const afterDispose = check();
      const resources = before.every(
        ([kind, set]) =>
          set.size === qa.live.get(kind).size &&
          Array.from(set).every((x) => qa.live.get(kind).has(x)),
      );
      return {
        afterSource,
        afterEnqueue,
        afterDraw,
        afterDispose,
        resources,
        foreignRegistryPreserved: GL.framebuffers[9] === fbo0,
        ownedRegistryRemoved: GL.framebuffers.filter(Boolean).length === 1,
        error: gl.getError(),
      };
    });
    assert(
      Object.entries(state).every(([key, value]) =>
        key === "error" ? value === 0 : value === true,
      ),
      JSON.stringify(state),
    );
    fs.writeFileSync(
      output + "/" + kind + "-state.json",
      JSON.stringify({ passed: true, state }, null, 2),
    );
    console.log("PASS", kind, "foreign GL state and resource ownership");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
