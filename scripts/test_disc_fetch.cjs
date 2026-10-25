// Exercise the actual EM_JS network bridge without downloading a game image.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../host/web.cpp'), 'utf8');
const start = source.indexOf('EM_JS(void, ps2web_fetch,');
const bodyStart = source.indexOf('{\n', start) + 1;
const body = source.slice(bodyStart, source.indexOf('\n});', bodyStart));

async function check({ status = 206, range = 'bytes 1000-1015/4096', length = 16, reject = false, hang = false, bodyHang = false }) {
  const heap = new SharedArrayBuffer(1024);
  let cancelled = false, read = false, request;
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  const context = vm.createContext({
    HEAP32: new Int32Array(heap), HEAPU8: new Uint8Array(heap),
    UTF8ToString: () => 'https://game.example/disc.iso',
    Atomics: { store: Atomics.store, notify: () => done() },
    console: { warn() {} },
    AbortController,
    setTimeout: (callback, ms) => { assert.equal(ms, 15000); return setTimeout(callback, 10); },
    clearTimeout,
    fetch: async (url, options) => {
      request = { url, options };
      const waitForAbort = () => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true }));
      if (hang) return waitForAbort();
      if (reject) throw new Error('connection lost');
      return {
        status, headers: new Headers({ 'Content-Range': range }),
        body: { async cancel() { cancelled = true; } },
        async arrayBuffer() { read = true; if (bodyHang) return waitForAbort(); return Uint8Array.from({ length }, (_, i) => i + 1).buffer; },
      };
    },
  });
  vm.runInContext('globalThis.readChunk=function(url,offset,size,out,state){' + body + '\n}', context);
  context.readChunk(0, 1000, 16, 128, 0);
  await finished;
  assert.equal(request.options.headers.Range, 'bytes=1000-1015');
  const ok = status === 206 && range === 'bytes 1000-1015/4096' && length === 16 && !reject && !hang && !bodyHang;
  assert.equal(context.HEAP32[0], ok ? 3 : 4);
  assert.deepEqual([...context.HEAPU8.subarray(128, 144)], ok ? Array.from({ length: 16 }, (_, i) => i + 1) : new Array(16).fill(0));
  if (!reject && !hang && (status !== 206 || range !== 'bytes 1000-1015/4096')) {
    assert.equal(cancelled, true);
    assert.equal(read, false);
  }
}

(async () => {
  await check({});
  await check({ status: 200 });
  await check({ status: 401 });
  await check({ range: 'bytes 2000-2015/4096' });
  await check({ range: 'bytes 1000-1015/1000' });
  await check({ length: 8 });
  await check({ reject: true });
  await check({ hang: true });
  await check({ bodyHang: true });
  console.log('PASS: exact disc ranges, ignored Range, authentication failure, invalid range, truncation, network failure, header timeout and body timeout');
})().catch((error) => { console.error(error); process.exitCode = 1; });
