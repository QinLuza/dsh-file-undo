/** Pure current-DSH result fixtures; no host, network, filesystem or credentials. */
import assert from 'node:assert/strict'
import { buildPatchDeletions, matchesPatchDeletionBefore } from './lib/patch-capture.js'

const exec = { name: 'apply_patch', callId: 'call-1', rootCallId: 'root-1' }
function deletion(overrides = {}) {
  return {
    index: 0, kind: 'delete', path: './note.txt', patchLine: 2, status: 'completed',
    changes: [{ path: '/workspace/note.txt', before: 'first\nsecond\n', after: null }],
    ...overrides,
  }
}
function success(operations = [deletion()], overrides = {}) {
  return {
    isError: false,
    value: {
      phase: 'commit', cancelled: false, operations,
      affectedPaths: operations.flatMap(op => (op.changes ?? []).map(change => change.path)),
      ...overrides,
    },
  }
}

const [candidate] = buildPatchDeletions(exec, success())
assert.deepEqual(candidate, {
  kind: 'delete', operationIndex: 0,
  path: '/workspace/note.txt', displayPath: './note.txt',
  before: 'first\nsecond\n', after: null, callId: 'call-1', rootCallId: 'root-1',
})
assert.equal(buildPatchDeletions({ name: 'apply_patch', callId: 'call-2' }, success())[0].rootCallId, undefined)

for (const invalidExec of [null, {}, { ...exec, name: 'write' }, { ...exec, callId: '' }]) {
  assert.deepEqual(buildPatchDeletions(invalidExec, success()), [])
}
for (const invalidResult of [null, {}, { ...success(), isError: true },
  { isError: false, content: [{ type: 'text', text: JSON.stringify(success().value) }] },
  { isError: false, data: success().value },
  success(undefined, { phase: 'preflight' }), success(undefined, { cancelled: undefined }),
  success(undefined, { operations: null }), success(undefined, { affectedPaths: [] }),
  success(undefined, { affectedPaths: [42] }),
]) assert.deepEqual(buildPatchDeletions(exec, invalidResult), [])

for (const status of ['failed', 'unknown', 'skipped']) {
  assert.deepEqual(buildPatchDeletions(exec, success([deletion({ status })])), [])
}
for (const kind of ['add', 'update', 'move']) {
  assert.deepEqual(buildPatchDeletions(exec, success([deletion({ kind })])), [])
}
for (const override of [
  { index: 1 }, { patchLine: 0 }, { patchLine: 2.5 }, { path: '' }, { path: 'bad\0path' },
  { destination: '/workspace/moved.txt' }, { changes: [] },
  { changes: [...deletion().changes, ...deletion().changes] },
  { changes: [{ path: '/workspace/note.txt', before: null, after: null }] },
  { changes: [{ path: '/workspace/note.txt', before: 'text', after: '' }] },
  { changes: [{ path: '/workspace/note.txt', before: 'text' }] },
  { changes: [{ path: '', before: 'text', after: null }] },
]) assert.deepEqual(buildPatchDeletions(exec, success([deletion(override)])), [])

// A stopped patch keeps earlier committed deletions; uncertain siblings add nothing.
const partial = success([
  deletion(),
  deletion({ index: 1, kind: 'update', status: 'unknown', changes: undefined }),
  deletion({ index: 2, status: 'skipped', changes: undefined }),
], { cancelled: true })
assert.deepEqual(buildPatchDeletions(exec, partial), [candidate])
const empty = buildPatchDeletions(exec, success([deletion({
  changes: [{ path: '/workspace/note.txt', before: '', after: null }],
})]))[0]
assert.equal(empty.before, '')

assert.equal(matchesPatchDeletionBefore('first\r\nsecond\r\n', candidate), true)
assert.equal(matchesPatchDeletionBefore('\uFEFFfirst\r\nsecond\r\n', candidate), true)
assert.equal(matchesPatchDeletionBefore('\uFEFF\uFEFFfirst\r\nsecond\r\n', candidate), false)
assert.equal(matchesPatchDeletionBefore('first\rsecond\r', candidate), false)
assert.equal(matchesPatchDeletionBefore('first\nsecond', candidate), false)
assert.equal(matchesPatchDeletionBefore('changed\nsecond\n', candidate), false)
assert.equal(matchesPatchDeletionBefore('', empty), true)
assert.equal(matchesPatchDeletionBefore('\uFEFF', empty), true)
assert.equal(candidate.before, 'first\nsecond\n')

console.log('verify-patch-capture: PASSED')
