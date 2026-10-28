// Asset-free browser checks for the shared-pixel renderer. Requires real WebGPU.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const puppeteer = require(process.env.PUPPETEER_MODULE || 'puppeteer-core');
const root = path.join(__dirname, '..');
const kind = process.argv[2] || 'chrome';
assert(['chrome', 'firefox'].includes(kind), 'Select chrome or firefox');
const output = process.env.SSX3_TEST_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'ssx3-pixel-' + kind + '-'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ssx3-pixel-clock-'));
fs.mkdirSync(output, { recursive: true });
let server, browser;
const errors = [], checks = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const html = `<!doctype html><meta charset="utf-8"><title>Pixel renderer check</title><link rel="icon" href="data:,">
<style>body{margin:0}canvas{display:block;width:129px;height:97px}</style><canvas id="canvas" width="129" height="97"></canvas>
<script src="/pixel-producer.js"></script><script>
window.shown=0;window.failures=[];const canvas=document.querySelector('canvas'),link=new MessageChannel();
window.fixtureWorker=new Worker('/fixture-worker.js');
fixtureWorker.addEventListener('error',e=>{window.workerError=e.message});
fixtureWorker.postMessage({type:'connect',port:link.port2},[link.port2]);
window.producer=ps2PixelProducer.create({canvas:canvas.transferControlToOffscreen(),port:link.port1,slotBytes:4,onPresent:()=>++shown,onFailure:e=>failures.push(e.message)});
producer.ready.then(()=>window.initialized=true,e=>window.initError=e.message);
window.send=(width,height,wide,solid)=>{const bytes=new Uint8Array(width*height*4);for(let y=0;y<height;y++)for(let x=0;x<width;x++){
const rgb=solid||[(x*13+y*7)%256,(x*3+y*19)%256,(x*23+y*5)%256];bytes.set([...rgb,[0,127,255][x%3]],(y*width+x)*4)}producer.publish(bytes,width,height,wide)};
</script>`;
const worker = `const stats={bufferWrites:0,textureWrites:0,bufferCopies:0};
const request=GPUAdapter.prototype.requestDevice,writeBuffer=GPUQueue.prototype.writeBuffer,writeTexture=GPUQueue.prototype.writeTexture,copy=GPUCommandEncoder.prototype.copyBufferToTexture;
GPUAdapter.prototype.requestDevice=async function(...args){const device=await request.apply(this,args);self.fixtureDevice=device;return device};
GPUQueue.prototype.writeBuffer=function(...args){++stats.bufferWrites;return writeBuffer.apply(this,args)};
GPUQueue.prototype.writeTexture=function(...args){++stats.textureWrites;return writeTexture.apply(this,args)};
GPUCommandEncoder.prototype.copyBufferToTexture=function(...args){++stats.bufferCopies;return copy.apply(this,args)};
self.addEventListener('message',e=>{if(e.data?.qa==='destroy')fixtureDevice.destroy();if(e.data?.qa==='stats')self.postMessage({qaStats:stats})});
importScripts('/pixel-presenter-worker.js');`;

function sourcePixel(x, y, frame) {
  x = Math.max(0, Math.min(frame.width - 1, x));
  y = Math.max(0, Math.min(frame.height - 1, y));
  return frame.solid || [(x * 13 + y * 7) % 256, (x * 3 + y * 19) % 256, (x * 23 + y * 5) % 256];
}
async function verify(page, label, frame, width = 129, height = 97) {
  const png = await (await page.$('canvas')).screenshot({ type: 'png' });
  fs.writeFileSync(path.join(output, label + '.png'), png);
  const decoded = await page.evaluate(async encoded => {
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); image.close();
    return { width: canvas.width, height: canvas.height, pixels: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data) };
  }, Buffer.from(png).toString('base64'));
  assert.equal(decoded.width, width); assert.equal(decoded.height, height);
  const across = frame.wide ? 16 : 4, down = frame.wide ? 9 : 3;
  const scale = Math.min(width / across, height / down), w = across * scale, h = down * scale;
  const left = (width - w) / 2, top = (height - h) / 2;
  let maximumError = 0, tested = 0;
  for (let y = Math.ceil(top) + 2; y < Math.floor(top + h) - 2; ++y) {
    for (let x = Math.ceil(left) + 2; x < Math.floor(left + w) - 2; ++x) {
      const sx = (x + 0.5 - left) / w * frame.width - 0.5;
      const sy = (y + 0.5 - top) / h * frame.height - 0.5;
      const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
      for (let channel = 0; channel < 3; ++channel) {
        let expected = 0;
        for (let dy = 0; dy < 2; ++dy) for (let dx = 0; dx < 2; ++dx)
          expected += sourcePixel(ix + dx, iy + dy, frame)[channel] * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
        maximumError = Math.max(maximumError, Math.abs(decoded.pixels[(y * width + x) * 4 + channel] - expected));
      }
      assert.equal(decoded.pixels[(y * width + x) * 4 + 3], 255, 'The visible output must remain opaque');
      ++tested;
    }
  }
  assert(tested > 1000); assert(maximumError <= 2, label + ': bilinear pixel error ' + maximumError);
  // Ignore the two-pixel viewport edge margin above: rasterizer edge coverage
  // varies, while the image interior and the distant letterbox stay testable.
  if (top > 2 || left > 2) assert.deepEqual(decoded.pixels.slice(0, 4), [0, 0, 0, 255]);
  checks.push({ label, testedPixels: tested, maximumChannelError: maximumError });
}

(async () => {
  execFileSync('python3', [path.join(root, 'scripts/export_frame_clock.py'), path.join(root, 'web/frame-presentation.js'), path.join(temporary, 'frame-clock.js')]);
  const assets = new Map([
    ['/', ['text/html', Buffer.from(html)]], ['/fixture-worker.js', ['text/javascript', Buffer.from(worker)]],
    ...['pixel-producer.js', 'pixel-presenter-worker.js'].map(name => ['/' + name, ['text/javascript', fs.readFileSync(name === 'pixel-presenter-worker.js' && process.env.SSX3_TEST_PRESENTER ? process.env.SSX3_TEST_PRESENTER : path.join(root, 'web', name))]]),
    ['/frame-clock.js', ['text/javascript', fs.readFileSync(path.join(temporary, 'frame-clock.js'))]],
  ]);
  server = http.createServer((request, response) => {
    const asset = assets.get(new URL(request.url, 'http://127.0.0.1').pathname);
    response.writeHead(asset ? 200 : 404, { 'Content-Type': asset?.[0] || 'text/plain', 'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' });
    response.end(asset?.[1] || 'Not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const executablePath = process.env.SSX3_BROWSER_EXECUTABLE || (kind === 'firefox' ? '/usr/bin/firefox' : '/usr/bin/chromium');
  browser = await puppeteer.launch({ ...(kind === 'firefox' ? { browser: 'firefox', extraPrefsFirefox: { 'dom.webgpu.enabled': true } } : { args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] }),
    executablePath, headless: process.env.SSX3_TEST_HEADLESS === '1', networkEnabled: false, defaultViewport: { width: 400, height: 300, deviceScaleFactor: 1 } });
  const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); assert(await page.evaluate(() => crossOriginIsolated));
  await page.waitForFunction(() => window.initialized || window.initError || window.workerError, { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.initError || window.workerError || null), null);
  const publish = (frame, count = 1) => page.evaluate(({ frame, count }) => { for (let i = 0; i < count; ++i) send(frame.width, frame.height, frame.wide, frame.solid); }, { frame, count });
  const waitShown = count => page.waitForFunction(count => shown === count, { timeout: 15000 }, count);
  const first = { width: 64, height: 13, wide: false };
  await publish(first, 2); await waitShown(2); await verify(page, 'aligned-gradient-and-alpha', first);
  await page.evaluate(() => producer.pause(true)); await sleep(60);
  const cyan = { width: 64, height: 13, wide: false, solid: [0, 255, 255] };
  await publish(cyan); await sleep(120); assert.equal(await page.evaluate(() => shown), 2);
  await verify(page, 'paused-frame-retained', first);
  await page.evaluate(() => producer.pause(false)); await waitShown(3); await verify(page, 'first-resumed-frame', cyan);
  const grown = { width: 128, height: 16, wide: false };
  await publish(grown); await waitShown(4); await verify(page, 'grown-shared-storage', grown);
  const fallback = { width: 19, height: 13, wide: true };
  await publish(fallback); await waitShown(5); await verify(page, 'unaligned-fallback-and-widescreen', fallback);
  await page.evaluate(() => { producer.resize(160, 90); canvas.style.width = '160px'; canvas.style.height = '90px'; });
  await publish(first); await waitShown(6); await verify(page, 'resized-viewport', first, 160, 90);
  const stats = await page.evaluate(() => new Promise(resolve => { function receive(event) { if (!event.data?.qaStats) return; fixtureWorker.removeEventListener('message', receive); resolve(event.data.qaStats); } fixtureWorker.addEventListener('message', receive); fixtureWorker.postMessage({ qa: 'stats' }); }));
  assert(stats.bufferWrites > 0 && stats.textureWrites > 0, 'Both aligned uploads and the fallback must run');
  assert.equal(stats.bufferCopies, stats.bufferWrites, 'Each staged frame must encode its texture copy');
  assert.deepEqual(await page.evaluate(() => failures), []); assert.deepEqual(errors, []);
  await page.evaluate(() => fixtureWorker.postMessage({ qa: 'destroy' }));
  await page.waitForFunction(() => failures.length === 1, { timeout: 10000 });
  const frozen = await page.evaluate(() => shown); await sleep(100); assert.equal(await page.evaluate(() => shown), frozen);
  assert.equal(await page.evaluate(() => window.workerError || null), null); assert.deepEqual(errors, []);
  await page.evaluate(() => { producer.close(); fixtureWorker.terminate(); });
  const sourceHashes = Object.fromEntries([...assets].filter(([name]) => name !== '/').map(([name, asset]) => [name, crypto.createHash('sha256').update(asset[1]).digest('hex')]));
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, kind, checks, stats, errors, sourceHashes,
    scope: 'Asset-free real GPU pixels and lifecycle. Firefox explicitly enables WebGPU. No game/performance or physical-device qualification.' }, null, 2));
  console.log(JSON.stringify({ passed: true, kind, checks: checks.length, stats, output }));
})().catch(error => { console.error(error); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.message, stack: error.stack, checks, errors }, null, 2)); process.exitCode = 1; })
  .finally(async () => { if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); fs.rmSync(temporary, { recursive: true, force: true }); });
