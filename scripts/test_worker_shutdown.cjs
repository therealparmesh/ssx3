const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const shell = fs.readFileSync(path.join(__dirname, '../web/shell.html'), 'utf8');
const source = shell.slice(shell.indexOf('let stopForReload = null;'), shell.indexOf('function failPlayer('));
(async () => {
  for (const phase of ['ready', 'failed', 'closed', 'connecting', 'reject-stop']) {
    let wakeReleases = 0;
    const calls = [], Module = { running: true, workerRuntime: {
      phase: phase === 'reject-stop' ? 'ready' : phase,
      async request(method) { calls.push(method); if (phase === 'reject-stop') throw new Error('Worker failed during stop'); },
      close() { calls.push('close'); this.phase = 'closed'; },
    } };
    const context = vm.createContext({ Module, playerWakeLock: {setActive(value) {assert.equal(value,false);++wakeReleases;}}, cancelStartup() {}, cancelResume() {}, stopCompiler() {},
      node: { disconnect() { calls.push('disconnect'); } },
      audio: { async close() { await Promise.resolve(); calls.push('audio-close'); } },
    });
    vm.runInContext(source, context);
    const first = vm.runInContext('stopPlayerForReload()', context);
    assert.equal(vm.runInContext('stopPlayerForReload()', context), first, 'Repeated cleanup must share one operation');
    await first;
    assert(wakeReleases > 0, 'Shutdown must release screen wake protection');
    assert.deepEqual(calls, [...(['ready', 'reject-stop'].includes(phase) ? ['stop'] : []), 'close', 'disconnect', 'audio-close']);
    assert.equal(Module.stoppedForReload, true); assert.equal(Module.running, false); assert.equal(Module.paused, true);
    assert.equal(context.node, null); assert.equal(context.audio, null);
  }
  console.log('PASS: worker shutdown after crash, rejected stop, startup and normal play; one cleanup owns audio and worker release');
})().catch(error => { console.error(error); process.exitCode = 1; });
