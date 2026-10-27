// Exercise the actual submission helper's argument lifetime and exception paths.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const library = {}, Module = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/frame-presentation.js'), 'utf8'), {
  Module, addToLibrary: entries => Object.assign(library, entries),
});
const submit = library.$ps2webSubmitCommand;
const lists = new Set(), received = [], command = {};
const queue = {submit(commands) {
  assert.equal(commands.length, 1);
  lists.add(commands);
  received.push(commands[0]);
  assert.equal(Module.singleCommandSubmission, null, 'The active argument array cannot be borrowed again');
}};
for (let i = 0; i < 10000; ++i) submit(queue, command);
assert.equal(lists.size, 1, 'Sequential submissions must reuse one argument array');
assert.equal(received.length, 10000);
assert(received.every(value => value === command));
assert.equal(Module.singleCommandSubmission[0], null, 'Idle storage must not retain GPU command buffers');

const before = Module.singleCommandSubmission, failure = new Error('Queue submission failed');
assert.throws(() => submit({submit(commands) {
  assert.equal(commands[0], command);
  throw failure;
}}, command), error => error === failure);
assert.equal(Module.singleCommandSubmission, before, 'A throwing submit must return its borrowed array');
assert.equal(before[0], null);

const outer = {}, inner = {}, order = [];
let outerList, innerList;
submit({submit(commands) {
  outerList = commands;
  submit({submit(nested) { innerList = nested; order.push(nested[0]); }}, inner);
  assert.equal(commands[0], outer, 'A reentrant call must not overwrite the outer argument');
  order.push(commands[0]);
}}, outer);
assert.notEqual(innerList, outerList);
assert.deepEqual(order, [inner, outer]);
assert.equal(outerList[0], null);
assert.equal(innerList[0], null);
assert.equal(Module.singleCommandSubmission, innerList, 'Only one idle array is retained after reentrancy');

assert.throws(() => submit({submit(commands) {
  submit({submit() { throw failure; }}, inner);
}}, outer), error => error === failure);
assert.equal(Module.singleCommandSubmission[0], null, 'Nested exceptions must release command references');
submit(queue, command);
assert.equal(Module.singleCommandSubmission[0], null);
console.log('GPU submission: one-array reuse, exact ordering, cleared references, exceptions and reentrant calls passed');
