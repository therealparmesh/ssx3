// Only the browser renderer can suspend. The EE and VU workers reject
// asynchronous imports before entering game code (PS2_WEB_SYNC_GAME_WORKERS).
// Their nested legacy exception bridges need no Asyncify export bookkeeping.
addToLibrary({
  $ps2SyncWorkerExports__deps: ['$Asyncify'],
  $ps2SyncWorkerExports__force: true,
  $ps2SyncWorkerExports__postset: 'ps2SyncWorkerExports();',
  $ps2SyncWorkerExports: () => {
    if (!ENVIRONMENT_IS_PTHREAD) return;
    Asyncify.instrumentWasmExports = exports => exports;
  },
});
