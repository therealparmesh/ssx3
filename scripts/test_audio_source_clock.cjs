// Cross-check JavaScript bounds with time codes decoded by the real native DSP.
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const clock = require('./browser_source_clock.js');
const binary = process.argv[2] || 'build/checks/ps2audio_source_clock_tests';
const fixtures = execFileSync(binary, {encoding: 'utf8'}).trim().split('\n').map(JSON.parse);
assert.equal(fixtures.length, 4);
const snapshot = ([source, read, actual, queued]) => ({
  frameBefore: source / 800, frameAfter: source / 800,
  sourceBefore: source, sourceAfter: source,
  writeBefore: (read + queued) >>> 0, read: read >>> 0, writeAfter: (read + queued) >>> 0,
  capacity: 16384, active: 1,
});
let checks = 0;
for (const fixture of fixtures) {
  const start = snapshot(fixture.start), end = snapshot(fixture.end), delayed = snapshot(fixture.delayed);
  for (const [s, tag] of [[start, fixture.start[2]], [end, fixture.end[2]], [delayed, fixture.delayed[2]]]) {
    const b = clock.bounds(s); assert(b.lower <= tag && tag <= b.upper); ++checks;
    // A completed packet can publish output before its source counter.
    const stale = {...s, sourceBefore: s.sourceBefore - 32, sourceAfter: s.sourceAfter - 32,
      writeBefore: (s.writeBefore - 64) >>> 0};
    const c = clock.bounds(stale); assert(c.lower <= tag && tag <= c.upper); ++checks;
  }
  const result = clock.compare(start, end);
  assert(result.passed); assert(result.differenceMs.lower > -50 && result.differenceMs.upper < 50);
  assert(!clock.compare(start, {...end, frameBefore: end.frameBefore + 6, frameAfter: end.frameAfter + 6}).passed);
  assert(!clock.compare(end, delayed).passed);
  // A wide observation may overlap zero; that is insufficient to pass.
  assert(!clock.compare(start, {...end, frameBefore: end.frameBefore - 4}).passed);
  const shift = (0xffffffff - start.read - 128) >>> 0;
  const wrap = s => ({...s, read: (s.read + shift) >>> 0,
    writeBefore: (s.writeBefore + shift) >>> 0, writeAfter: (s.writeAfter + shift) >>> 0});
  assert.deepEqual(clock.compare(wrap(start), wrap(end)), result);
  const reversed = (start.read - 1) >>> 0;
  assert.throws(() => clock.compare(start, {...end, read: reversed,
    writeBefore: (reversed + fixture.end[3]) >>> 0,
    writeAfter: (reversed + fixture.end[3]) >>> 0}), /consumption/);
  checks += 6;
}
const base = snapshot([960000, 900000, 0, 1920]); base.frameBefore = base.frameAfter = 1000;
const palEnd = {...base, sourceBefore: 1056000, sourceAfter: 1056000, read: 996000,
  writeBefore: 997920, writeAfter: 997920, frameBefore: 1100, frameAfter: 1100};
assert(clock.compare(base, palEnd, 50).passed);
assert(!clock.compare(base, {...palEnd, frameBefore: 1105, frameAfter: 1105}, 50).passed);
for (const invalid of [{active: 0}, {sourceBefore: NaN}, {frameAfter: -1}, {capacity: 0},
  {sourceAfter: 1}, {writeAfter: (base.read - 1) >>> 0}])
  assert.throws(() => clock.bounds({...base, ...invalid}));
assert.throws(() => clock.compare(base, base));
assert.throws(() => clock.compare(base, palEnd, 0));
const memory = {buffer: new SharedArrayBuffer(16)}, ring = new Int32Array(memory.buffer);
ring.set([2100, 180, 16384, 1]);
const calls = [];
const Module = {_ps2web_audio_ring: () => 0,
  _ps2web_frames: () => {calls.push('field'); return 120;},
  _ps2web_audio_rate_stats: index => {assert.equal(index, 0); calls.push('source'); return 96000;}};
const captured = clock.capture(Module, memory);
assert.deepEqual(calls, ['field', 'source', 'source', 'field']);
assert.equal(captured.read, 180); assert.equal(captured.writeAfter, 2100);
assert.equal(clock.bounds(captured).queuedMin, 1920);
console.log(JSON.stringify({passed: true, pcmModes: fixtures.length, checks: checks + 11,
  fullIntervalRequired: true, videoOffsetRejected: true, bufferedDelayRejected: true,
  sourcePublicationLagCovered: true, rolloverCovered: true}));
