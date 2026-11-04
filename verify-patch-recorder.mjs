/** Exercise event ordering and admission, independently of the provider fixtures. */
import assert from 'node:assert/strict'
import { posix } from 'node:path'
import { installPatchRecorder } from './lib/patch-recorder.js'
import { sha256, workspaceKeyOf } from './lib/store.js'

function fixture() {
  const handlers = new Map()
  const effects = []
  const files = new Map()
  const saved = []
  let saveError = false
  let readError = false
  let afterRead
  const ctx = {
    on(event, handler, options) {
      assert.equal(options?.prepend, true)
      handlers.set(event, handler)
    },
    effect(factory) { effects.push(factory().next().value) },
    fs: {
      resolve: async (path, options) => ({ targetKey: posix.resolve(options.cwd, path) }),
      processPath: target => target.targetKey,
      stat: async target => files.get(target.targetKey)
        ? { type: 'file', version: files.get(target.targetKey).version } : undefined,
      readBytes: async (target, signal, limit) => {
        if (readError) throw new Error('read failed')
        const bytes = files.get(target.targetKey).bytes
        if (bytes.length > limit) throw new Error('too large')
        afterRead?.()
        return bytes
      },
    },
  }
  installPatchRecorder(ctx, async (scope, snapshot) => {
    if (saveError) throw new Error('store failed')
    saved.push({ scope, snapshot })
  })
  return {
    saved,
    put(path, text, version = 'v1') {
      files.set(path, { bytes: typeof text === 'string' ? Buffer.from(text) : text, version })
    },
    setReadError() { readError = true },
    setSaveError() { saveError = true },
    setAfterRead(callback) { afterRead = callback },
    dispose() { effects.forEach(dispose => dispose()) },
    async intent(exec, path = '/work/a.txt', guard = { version: 'v1' }) {
      let forwarded = 0
      if (guard === null) guard = undefined
      const result = await handlers.get('fs/delete-intent')({ targetKey: path }, exec,
        async () => { forwarded++; return guard })
      assert.equal(forwarded, 1)
      assert.equal(result, guard, 'the original admission object must be preserved')
    },
    async finish(exec, result = outcome()) {
      let forwarded = 0
      const decision = { kind: 'continue' }
      assert.equal(await handlers.get('tools/post-execute')(exec, result,
        async () => { forwarded++; return decision }), decision)
      assert.equal(forwarded, 1)
    },
  }
}
function execution(id = 'session-1') {
  return { name: 'apply_patch', callId: 'call-1', rootCallId: 'root-1',
    signal: new AbortController().signal, agent: { id, session: { header: { cwd: '/work' } } } }
}
function operation(index = 0, kind = 'delete', path = './a.txt', before = 'original\n', after = null) {
  return { index, kind, path, patchLine: index + 2, status: 'completed',
    changes: [{ path: posix.resolve('/work', path), before, after }] }
}
function outcome(operations = [operation()]) {
  return { isError: false, value: { phase: 'commit', cancelled: false, operations,
    affectedPaths: [...new Set(operations.flatMap(op => (op.changes ?? []).map(change => change.path)))] } }
}

// Preflight and commit may both request the same intent. One completed deletion
// yields one snapshot, with the original BOM/CRLF bytes rather than the diff basis.
{
  const f = fixture(), exec = execution()
  f.put('/work/a.txt', '\uFEFForiginal\r\n')
  await f.intent(exec)
  await f.intent(exec)
  await f.finish(exec)
  assert.equal(f.saved.length, 1)
  assert.deepEqual(f.saved[0].scope, { workspaceKey: workspaceKeyOf('/work'), chatKey: 'session-1' })
  const s = f.saved[0].snapshot
  assert.equal(s.before, '\uFEFForiginal\r\n')
  assert.equal(s.beforeHash, sha256(s.before))
  assert.equal(s.afterAbsent, true)
  assert.equal(s.after, null)
  assert.equal(s.rootCallId, 'root-1')
  await f.finish(exec)
  assert.equal(f.saved.length, 1, 'post hooks cannot consume the same capture twice')
}

// Captures are isolated by execution, even when sessions reuse a call id.
{
  const f = fixture(), first = execution(), second = execution('session-2')
  f.put('/work/a.txt', 'original\n')
  await f.intent(first)
  await f.finish(second)
  assert.equal(f.saved.length, 0)
  await f.finish(first)
  assert.equal(f.saved[0].scope.chatKey, 'session-1')
}

// All operation paths participate, including aliases, moves and unknown outcomes.
for (const later of [
  operation(1, 'add', './sub/../a.txt', null, 'replacement\n'),
  { ...operation(1, 'move', './b.txt'), destination: '/work/a.txt' },
  { index: 1, kind: 'delete', path: '/work/a.txt', patchLine: 3, status: 'unknown' },
]) {
  const f = fixture(), exec = execution()
  f.put('/work/a.txt', 'original\n')
  await f.intent(exec)
  await f.finish(exec, outcome([operation(), later]))
  assert.equal(f.saved.length, 0, 'compound operations on one target are not isolated deletions')
}

// A failure on a different target must not hide earlier completed deletions.
{
  const f = fixture(), exec = execution()
  f.put('/work/a.txt', 'original\n')
  await f.intent(exec)
  await f.finish(exec, outcome([operation(),
    { index: 1, kind: 'delete', path: './b.txt', patchLine: 3, status: 'failed' }]))
  assert.equal(f.saved.length, 1)
}

// Invalid, unavailable or changed raw content never turns into an empty snapshot;
// capture/storage errors never change the tool's admission or post decision.
const errors = []
const originalError = console.error
console.error = (...args) => errors.push(args)
try {
  for (const guard of [{ version: 'v2' }, null]) {
    const f = fixture(), exec = execution()
    f.put('/work/a.txt', 'original\n')
    await f.intent(exec)
    f.put('/work/a.txt', '\uFEFForiginal\r\n', 'v2')
    f.setReadError()
    await f.intent(exec, '/work/a.txt', guard)
    await f.finish(exec)
    assert.equal(f.saved.length, 0, 'failed/unguarded commit capture invalidates the preflight bytes')
  }
  for (const scenario of ['unguarded', 'wrong-version', 'read-failed', 'binary', 'invalid-utf8',
    'oversized', 'changed-during-read', 'wrong-content', 'failed', 'cancelled-no-value', 'disposed', 'save-failed']) {
    const f = fixture(), exec = execution()
    f.put('/work/a.txt', 'original\n')
    if (scenario === 'read-failed') f.setReadError()
    if (scenario === 'save-failed') f.setSaveError()
    if (scenario === 'binary') f.put('/work/a.txt', 'a\0b')
    if (scenario === 'invalid-utf8') f.put('/work/a.txt', Buffer.from([0xff]))
    if (scenario === 'oversized') f.put('/work/a.txt', Buffer.alloc(1024 * 1024 + 1, 97))
    if (scenario === 'wrong-content') f.put('/work/a.txt', 'other\n')
    if (scenario === 'changed-during-read') f.setAfterRead(() => f.put('/work/a.txt', 'other', 'v2'))
    await f.intent(exec, '/work/a.txt', scenario === 'unguarded' ? null
      : { version: scenario === 'wrong-version' ? 'v0' : 'v1' })
    if (scenario === 'disposed') f.dispose()
    await f.finish(exec, scenario === 'failed' ? { isError: true }
      : scenario === 'cancelled-no-value' ? { isError: false } : outcome())
    assert.equal(f.saved.length, 0, scenario)
  }
} finally { console.error = originalError }
assert.ok(errors.length >= 4, 'capture/save failures should be observable')
console.log('verify-patch-recorder: PASSED')
