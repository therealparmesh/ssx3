const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/../web/sync-game-workers.js', 'utf8');

for (const worker of [false, true]) {
  let library;
  const instrument = exports => Object.fromEntries(Object.entries(exports).map(([name, value]) =>
    [name, typeof value === 'function' ? (...args) => value(...args) : value]));
  const sleep = () => { throw new Error('Unexpected asynchronous game-worker operation'); };
  const context = vm.createContext({
    ENVIRONMENT_IS_PTHREAD: worker,
    Asyncify: { instrumentWasmExports: instrument, handleSleep: sleep },
    addToLibrary: value => { library = value; },
  });
  vm.runInContext(source, context);
  library.$ps2SyncWorkerExports();
  const current = context.Asyncify.instrumentWasmExports;
  assert.equal(current === instrument, !worker, 'Only game workers may change export handling');
  assert.equal(context.Asyncify.handleSleep, sleep, 'The synchronous-worker guard must remain intact');
  assert.throws(() => context.Asyncify.handleSleep(), /Unexpected asynchronous/);
  const memory = { buffer: new SharedArrayBuffer(64) };
  const error = new Error('original exception');
  const exports = { memory, value: 7, add: (a, b) => a + b, fail: () => { throw error; } };
  const result = current(exports);
  assert.equal(result.memory, memory);
  assert.equal(result.value, 7);
  assert.equal(result.add(2, 5), 7);
  assert.throws(result.fail, exception => exception === error);
  if (worker) {
    assert.equal(result, exports, 'Synchronous worker exports must retain their original identities');
    assert.equal(result.add, exports.add);
  }
  library.$ps2SyncWorkerExports();
  assert.equal(current(exports).memory, memory);
}
console.log('Synchronous worker exports: main-thread isolation, identity, memory, exceptions and async guard passed');
