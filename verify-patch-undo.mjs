/**
 * Patch-deletion undo/redo over real temporary files and the persisted ledger.
 * The guarded provider enforces policy, atomic creation, and version matching;
 * race hooks run before its checks, so merely passing an intent cannot pass.
 * This is an API contract test, not a replacement for a real DSH Loader smoke.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { readFileSync, writeFileSync, statSync, lstatSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

const tempParent = resolve(tmpdir())
const root = await mkdtemp(join(tempParent, 'file-undo-patch-'))
const home = join(root, 'home')
const workspace = join(root, 'workspace')
await mkdir(home)
await mkdir(workspace)
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = join(home, '.dsh')

let cases = 0
let sequence = 0
const error = (code, message = code) => Object.assign(new Error(message), { code })
const missing = path => {
  try { statSync(path); return false } catch (cause) {
    if (cause.code === 'ENOENT') return true
    throw cause
  }
}
const rejectCode = async (run, code) => assert.rejects(run, cause => cause.code === code)

try {
  // HOME must be isolated before modules compute their persistence paths.
  const { appendSnapshot, loadSnapshots, sha256, hasKnownAfter } = await import('./lib/store.js')
  const { buildApi } = await import('./lib/api.js')

  function provider() {
    const versions = new Map()
    const state = {
      beforeMutation: undefined, afterRead: undefined,
      readError: false, statError: false, writes: 0, deletes: 0, textReads: 0,
      pathType: undefined, redirectTo: undefined,
    }
    const bump = path => versions.set(path, (versions.get(path) ?? 0) + 1)
    const externalWrite = (path, content) => {
      writeFileSync(path, content, 'utf8')
      bump(path)
    }
    const inspect = path => {
      try {
        const info = statSync(path, { bigint: true })
        return {
          type: info.isFile() ? 'file' : 'directory',
          size: Number(info.size),
          version: `${versions.get(path) ?? 0}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`,
        }
      } catch (cause) {
        if (cause.code === 'ENOENT') return undefined
        throw cause
      }
    }
    const checkPolicy = (path, policy) => {
      if (!policy || policy.mode !== 'workspace-write') throw error('FS_PERMISSION_DENIED')
      const rel = relative(policy.workspaceRoot, path)
      if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
        throw error('FS_PERMISSION_DENIED')
      }
    }
    const read = async target => {
      if (state.readError) throw error('FS_PERMISSION_DENIED')
      const bytes = readFileSync(target.targetKey)
      const hook = state.afterRead
      state.afterRead = undefined
      if (hook) await hook(target.targetKey)
      return bytes
    }
    const beforeMutation = async path => {
      const hook = state.beforeMutation
      state.beforeMutation = undefined
      if (hook) await hook(path)
    }
    const fs = {
      resolve: async path => ({ targetKey: state.redirectTo ?? resolve(workspace, path), displayPath: path }),
      processPath: target => target.targetKey,
      lstat: async path => {
        // Simulate link observations at the provider seam without requiring
        // Windows symlink privileges. Ordinary file observations are real.
        if (state.pathType !== undefined) return { type: state.pathType }
        try {
          const info = lstatSync(path)
          return { type: info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other' }
        } catch (cause) {
          if (cause.code === 'ENOENT') return undefined
          throw cause
        }
      },
      stat: async target => {
        if (state.statError) throw error('FS_PERMISSION_DENIED')
        return inspect(target.targetKey)
      },
      readBytes: read,
      // Official readText normalizes BOM; byte-preserving patch paths must use readBytes.
      readText: async target => {
        state.textReads++
        return new TextDecoder('utf-8', { fatal: true }).decode(await read(target))
      },
      writeText: async (target, content, expected, _signal, policy) => {
        const path = target.targetKey
        checkPolicy(path, policy)
        await beforeMutation(path)
        assert.ok(expected, 'patch writes require a guarded intent')
        if (expected.kind === 'createIfAbsent') {
          // wx is the actual exclusive creation operation, not an exists-then-write check.
          try { writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' }) } catch (cause) {
            if (cause.code === 'EEXIST') throw error('FS_STALE_VERSION')
            throw cause
          }
        } else {
          assert.equal(expected.kind, 'replaceIfVersion')
          const info = inspect(path)
          if (!info || info.version !== expected.version) throw error('FS_STALE_VERSION')
          // Synchronous check and mutation prevent another test task interleaving here.
          writeFileSync(path, content, 'utf8')
        }
        bump(path)
        state.writes++
        return { kind: 'written' }
      },
      deleteFile: async (target, expected, _signal, policy) => {
        const path = target.targetKey
        checkPolicy(path, policy)
        await beforeMutation(path)
        assert.ok(expected?.version, 'patch deletions require the observed version')
        const info = inspect(path)
        if (!info || info.version !== expected.version) throw error('FS_STALE_VERSION')
        unlinkSync(path)
        bump(path)
        state.deletes++
        return { kind: 'deleted' }
      },
    }
    return { fs, state, externalWrite }
  }

  async function fixture(label, before = 'original\n', options = {}) {
    const id = `patch-${++sequence}`
    const path = join(workspace, `${id}.txt`)
    // Keep ledger paths short under Windows' already-long isolated temp home.
    // Workspace-key normalization has its own tests; these exercise API semantics.
    const scope = { workspaceKey: 'patch-workspace', chatKey: id }
    const disk = provider()
    const policy = { mode: 'workspace-write', workspaceRoot: workspace }
    const ctx = {
      fs: disk.fs,
      sandboxPolicy: { resolve() { throw new Error('patch undo must resolve the original session policy') } },
    }
    const resolver = options.missingPolicy ? undefined : async requested => {
      assert.deepEqual(requested, scope, 'policy is resolved for the snapshot scope')
      await options.onPolicy?.()
      return options.policy ?? policy
    }
    const api = buildApi(ctx, () => scope, undefined, resolver)
    await appendSnapshot(scope, {
      id, filePath: path, command: 'apply_patch', op: 'delete',
      callId: `call-${id}`, rootCallId: `root-${id}`,
      before, beforeHash: sha256(before), after: null, afterHash: null,
      ...(options.legacy ? {} : { afterAbsent: true }),
      time: Date.now() + sequence, state: 'recorded',
    })
    const row = async selected => (await loadSnapshots(scope)).find(item => item.id === (selected ?? id))
    return { label, id, path, scope, api, row, ...disk }
  }

  async function test(label, run) {
    await run()
    cases++
    console.log(`  ✓ ${label}`)
  }

  for (const [label, original, lines] of [
    ['UTF-8 deletion', '原始文件\nemoji 😀\n', 2],
    ['empty file deletion', '', 0],
    ['BOM and CRLF deletion', '\uFEFFone\r\ntwo\r\n', 2],
  ]) {
    await test(`${label}: exact restore, redo, and persisted state`, async () => {
      const t = await fixture(label, original)
      const detail = await t.api.detail({ id: t.id })
      assert.equal(detail.preview.canApply, true)
      assert.equal(detail.preview.currentHash, null)
      assert.equal(detail.item.hasAfter, true)
      assert.equal(hasKnownAfter(await t.row()), true)
      const history = (await t.api.history()).items.find(item => item.id === t.id)
      assert.equal(history.added, lines, 'history counts the lines restored by undoing a known deletion')
      assert.equal(history.removed, 0)
      await t.api.apply({ id: t.id, expectedCurrentHash: null })
      assert.deepEqual(readFileSync(t.path), Buffer.from(original, 'utf8'))
      assert.equal((await t.row()).state, 'reverted')
      assert.equal((await t.row()).afterAbsent, true)
      const restored = await t.api.detail({ id: t.id })
      assert.equal(restored.preview.canReapply, true)
      assert.equal(restored.preview.currentHash, sha256(original))
      assert.equal(t.state.textReads, 0, 'known deletion details do not reread normalized, unbounded text')
      await t.api.reapply({ id: t.id, expectedCurrentHash: sha256(original) })
      assert.equal(missing(t.path), true)
      assert.equal((await t.row()).state, 'reapplied')
      assert.equal(t.state.writes, 1)
      assert.equal(t.state.deletes, 1)
      await t.api.apply({ id: t.id, expectedCurrentHash: null })
      assert.deepEqual(readFileSync(t.path), Buffer.from(original, 'utf8'))
    })
  }

  await test('external recreation is never overwritten, including identical bytes', async () => {
    for (const recreated of ['unrelated external file\n', 'original\n']) {
      const t = await fixture('recreated')
      t.externalWrite(t.path, recreated)
      assert.equal((await t.api.detail({ id: t.id })).preview.canApply, false)
      await rejectCode(() => t.api.apply({ id: t.id }), 'external_modified')
      assert.equal(readFileSync(t.path, 'utf8'), recreated)
      assert.equal((await t.row()).state, 'recorded')
      assert.equal(t.state.writes, 0)
    }
  })

  await test('dangling symlinks and non-file paths are refused before restoration', async () => {
    for (const pathType of ['symlink', 'directory', 'other']) {
      const t = await fixture(pathType)
      // stat still reports absence: lstat must prevent treating a dangling
      // link as a safe destination for createIfAbsent.
      t.state.pathType = pathType
      await rejectCode(() => t.api.apply({ id: t.id, expectedCurrentHash: null }), 'external_modified')
      assert.equal(missing(t.path), true)
      assert.equal((await t.row()).state, 'recorded')
      assert.equal(t.state.writes, 0)
    }
  })

  await test('ancestor redirects are refused both at observation and just before publication', async () => {
    for (const afterObservation of [false, true]) {
      const options = {}
      const t = await fixture('ancestor redirect', 'original\n', options)
      const redirected = join(workspace, `redirected-${t.id}.txt`)
      if (afterObservation) options.onPolicy = () => { t.state.redirectTo = redirected }
      else t.state.redirectTo = redirected
      await rejectCode(() => t.api.apply({ id: t.id, expectedCurrentHash: null }), 'external_modified')
      assert.equal(missing(t.path), true)
      assert.equal(missing(redirected), true)
      assert.equal((await t.row()).state, 'recorded')
      assert.equal(t.state.writes, 0)
    }
  })

  await test('permission/read errors never masquerade as an absent file', async () => {
    for (const fault of ['readError', 'statError']) {
      const t = await fixture(fault)
      t.externalWrite(t.path, 'external\n')
      t.state[fault] = true
      const detail = await t.api.detail({ id: t.id })
      assert.equal(detail.preview.canApply, false)
      assert.ok(detail.preview.reasons.some(reason => reason.code === 'file_read_failed'))
      await assert.rejects(() => t.api.apply({ id: t.id }))
      assert.equal(readFileSync(t.path, 'utf8'), 'external\n')
      assert.equal((await t.row()).state, 'recorded')
      assert.equal(t.state.writes + t.state.deletes, 0)
    }
  })

  await test('exclusive creation refuses a file created after observation', async () => {
    const t = await fixture('create race')
    t.state.beforeMutation = path => t.externalWrite(path, 'won the race\n')
    await rejectCode(() => t.api.apply({ id: t.id, expectedCurrentHash: null }), 'stale')
    assert.equal(readFileSync(t.path, 'utf8'), 'won the race\n')
    assert.equal((await t.row()).state, 'recorded')
    assert.equal(t.state.writes, 0)
  })

  await test('redo checks versions even when a racing writer preserves the same bytes', async () => {
    const t = await fixture('delete race')
    await t.api.apply({ id: t.id, expectedCurrentHash: null })
    t.state.beforeMutation = path => t.externalWrite(path, 'original\n')
    await rejectCode(() => t.api.reapply({ id: t.id, expectedCurrentHash: sha256('original\n') }), 'stale')
    assert.equal(readFileSync(t.path, 'utf8'), 'original\n')
    assert.equal((await t.row()).state, 'reverted')
    assert.equal(t.state.deletes, 0)
  })

  await test('a version change during reading prevents redo', async () => {
    const t = await fixture('read race')
    await t.api.apply({ id: t.id, expectedCurrentHash: null })
    t.state.afterRead = path => t.externalWrite(path, 'changed during read\n')
    await rejectCode(() => t.api.reapply({ id: t.id }), 'stale')
    assert.equal(readFileSync(t.path, 'utf8'), 'changed during read\n')
    assert.equal((await t.row()).state, 'reverted')
    assert.equal(t.state.deletes, 0)
  })

  await test('external changes after restore block deletion', async () => {
    const t = await fixture('changed restore')
    await t.api.apply({ id: t.id, expectedCurrentHash: null })
    t.externalWrite(t.path, 'user edits after restore\n')
    assert.equal((await t.api.detail({ id: t.id })).preview.canReapply, false)
    await rejectCode(() => t.api.reapply({ id: t.id }), 'external_modified')
    assert.equal(readFileSync(t.path, 'utf8'), 'user edits after restore\n')
    assert.equal((await t.row()).state, 'reverted')
  })

  await test('BOM-only and line-ending-only external changes are preserved', async () => {
    for (const changed of ['one\r\ntwo\r\n', '\uFEFFone\ntwo\n']) {
      const t = await fixture('byte changes', '\uFEFFone\r\ntwo\r\n')
      await t.api.apply({ id: t.id, expectedCurrentHash: null })
      t.externalWrite(t.path, changed)
      assert.equal((await t.api.detail({ id: t.id })).preview.canReapply, false)
      await rejectCode(() => t.api.reapply({ id: t.id }), 'external_modified')
      assert.deepEqual(readFileSync(t.path), Buffer.from(changed, 'utf8'))
      assert.equal(t.state.deletes, 0)
    }
  })

  await test('missing or read-only session policy denies restoration without changing the ledger', async () => {
    for (const options of [
      { missingPolicy: true, code: 'session_policy_unavailable' },
      { policy: { mode: 'read-only', workspaceRoot: workspace }, code: 'FS_PERMISSION_DENIED' },
    ]) {
      const t = await fixture('policy', 'original\n', options)
      await rejectCode(() => t.api.apply({ id: t.id, expectedCurrentHash: null }), options.code)
      assert.equal(missing(t.path), true)
      assert.equal((await t.row()).state, 'recorded')
      assert.equal(t.state.writes + t.state.deletes, 0)
    }
  })

  await test('legacy after:null stays unknown and is never promoted to a captured deletion', async () => {
    const t = await fixture('legacy', 'original\n', { legacy: true })
    assert.equal(hasKnownAfter(await t.row()), false)
    assert.equal((await t.row()).afterAbsent, undefined)
    t.externalWrite(t.path, 'different live text\n')
    const detail = await t.api.detail({ id: t.id })
    assert.equal(detail.item.hasAfter, false)
    assert.equal(detail.preview.canApply, false)
    assert.ok(detail.preview.reasons.some(reason => reason.code === 'unknown_state'))
    await rejectCode(() => t.api.rewindPreview({ id: t.id }), 'unsupported_checkpoint')
    assert.equal(readFileSync(t.path, 'utf8'), 'different live text\n')
  })

  await test('redo resolves the current session policy instead of reusing old write permission', async () => {
    const options = {}
    const t = await fixture('policy revoked', 'original\n', options)
    await t.api.apply({ id: t.id, expectedCurrentHash: null })
    options.policy = { mode: 'read-only', workspaceRoot: workspace }
    await rejectCode(() => t.api.reapply({ id: t.id }), 'FS_PERMISSION_DENIED')
    assert.equal(readFileSync(t.path, 'utf8'), 'original\n')
    assert.equal((await t.row()).state, 'reverted')
    assert.equal(t.state.deletes, 0)
  })

  await test('mixed edit chain with a deleted tail rewinds and redoes the entire recorded chain', async () => {
    const t = await fixture('mixed chain', 'unused')
    const path = join(workspace, 'mixed-chain.txt')
    const ids = ['mixed-edit-1', 'mixed-edit-2', 'mixed-delete']
    const texts = ['first\n', 'second\n', 'third\n', null]
    for (let index = 0; index < ids.length; index++) {
      await appendSnapshot(t.scope, {
        id: ids[index], filePath: path,
        command: index === 2 ? 'apply_patch' : 'edit', op: index === 2 ? 'delete' : 'edit',
        before: texts[index], beforeHash: sha256(texts[index]),
        after: texts[index + 1], afterHash: texts[index + 1] === null ? null : sha256(texts[index + 1]),
        ...(index === 2 ? { afterAbsent: true } : {}),
        time: Date.now() + index, state: 'recorded',
      })
    }
    for (let cycle = 0; cycle < 2; cycle++) {
      const preview = await t.api.rewindPreview({ id: ids[0] })
      assert.equal(preview.status, 'ok')
      assert.equal(preview.expectedCurrentHash, null)
      assert.equal(preview.invalidatedCount, 2)
      const restored = await t.api.rewindApply({ id: ids[0], expectedCurrentHash: null })
      assert.equal(restored.ledgerSynced, true)
      assert.equal(restored.invalidated, 2)
      assert.equal(readFileSync(path, 'utf8'), 'first\n')
      assert.equal((await t.row(ids[0])).revertReason, 'direct')
      assert.equal((await t.row(ids[2])).revertReason, 'cascade')
      assert.equal((await t.row(ids[2])).cascadeOf, ids[0])
      await rejectCode(() => t.api.reapply({ id: ids[2] }), 'cascade_invalidated')
      const redone = await t.api.reapply({ id: ids[0], expectedCurrentHash: sha256('first\n') })
      assert.equal(redone.revived, 2)
      assert.equal(redone.ledgerSynced, true)
      assert.equal(missing(path), true)
      for (const id of ids) assert.equal((await t.row(id)).state, 'reapplied')
    }
    assert.equal(t.state.writes, 2)
    assert.equal(t.state.deletes, 2)
  })

  await test('a later recreation and deletion supersedes the old deletion even while the path is absent', async () => {
    const t = await fixture('cross-call absence', 'original A\n')
    const createId = `${t.id}-create`
    const deleteId = `${t.id}-delete`
    const first = await t.row()
    await appendSnapshot(t.scope, {
      id: createId, filePath: t.path, command: 'write', op: 'create', callId: 'create-call',
      before: null, beforeHash: null, after: 'new B\n', afterHash: sha256('new B\n'),
      time: first.time + 1, state: 'recorded',
    })
    await appendSnapshot(t.scope, {
      id: deleteId, filePath: t.path, command: 'apply_patch', op: 'delete', callId: 'delete-call',
      before: 'new B\n', beforeHash: sha256('new B\n'), after: null, afterHash: null, afterAbsent: true,
      time: first.time + 2, state: 'recorded',
    })
    const preview = await t.api.preview({ id: t.id })
    assert.equal(preview.canApply, false)
    assert.ok(preview.reasons.some(reason => reason.code === 'superseded_by_later_ops'))
    await rejectCode(() => t.api.apply({ id: t.id, expectedCurrentHash: null }), 'superseded_by_later_ops')
    // A caller bypassing preview receives the same refusal, not an old-file restore.
    await rejectCode(() => t.api.apply({ id: t.id }), 'superseded_by_later_ops')
    assert.equal(missing(t.path), true)
    for (const id of [t.id, createId, deleteId]) assert.equal((await t.row(id)).state, 'recorded')
    assert.equal(t.state.writes, 0)

    // Explicit rewind owns the whole lineage, including the known absent
    // state between the first deletion and the later creation.
    for (let cycle = 0; cycle < 2; cycle++) {
      const rewind = await t.api.rewindPreview({ id: t.id })
      assert.equal(rewind.status, 'ok')
      assert.equal(rewind.invalidatedCount, 2)
      assert.equal(rewind.expectedCurrentHash, null)
      const restored = await t.api.rewindApply({ id: t.id, expectedCurrentHash: null })
      assert.equal(restored.ledgerSynced, true)
      assert.equal(readFileSync(t.path, 'utf8'), 'original A\n')
      assert.equal((await t.row(createId)).cascadeOf, t.id)
      assert.equal((await t.row(deleteId)).cascadeOf, t.id)
      const redone = await t.api.reapply({ id: t.id, expectedCurrentHash: sha256('original A\n') })
      assert.equal(redone.revived, 2)
      assert.equal(redone.ledgerSynced, true)
      assert.equal(missing(t.path), true)
      for (const id of [t.id, createId, deleteId]) assert.equal((await t.row(id)).state, 'reapplied')
      await rejectCode(() => t.api.apply({ id: t.id }), 'superseded_by_later_ops')
    }
  })

  await test('an unrecorded recreation breaks an absence chain and cannot be erased by rewind', async () => {
    const t = await fixture('unknown recreation', 'original A\n')
    const first = await t.row()
    const laterId = `${t.id}-later`
    // The file was recreated outside recorded tools before this deletion.
    // Equal final absence does not establish continuity through that gap.
    await appendSnapshot(t.scope, {
      id: laterId, filePath: t.path, command: 'apply_patch', op: 'delete', callId: 'later-call',
      before: 'external B\n', beforeHash: sha256('external B\n'),
      after: null, afterHash: null, afterAbsent: true,
      time: first.time + 1, state: 'recorded',
    })
    await rejectCode(() => t.api.rewindPreview({ id: t.id }), 'external_modified')
    await rejectCode(() => t.api.rewindApply({ id: t.id, expectedCurrentHash: null }), 'external_modified')
    assert.equal(missing(t.path), true)
    assert.equal((await t.row()).state, 'recorded')
    assert.equal((await t.row(laterId)).state, 'recorded')
    assert.equal(t.state.writes + t.state.deletes, 0)
  })

  await test('confirmed deletion ledger repair preserves raw bytes and enables guarded redo', async () => {
    const original = '\uFEFFrestored\r\n'
    const t = await fixture('repair deletion', original)
    t.externalWrite(t.path, original)
    assert.equal((await t.api.preview({ id: t.id })).status, 'stale_ledger')
    const repaired = await t.api.confirmStaleLedger({ id: t.id })
    assert.equal(repaired.repaired, t.path)
    assert.equal(t.state.writes + t.state.deletes, 0, 'ledger repair does not mutate the file')
    assert.deepEqual(readFileSync(t.path), Buffer.from(original, 'utf8'))
    assert.equal((await t.row()).revertReason, 'direct')
    await t.api.reapply({ id: t.id, expectedCurrentHash: sha256(original) })
    assert.equal(missing(t.path), true)
  })

  await test('direct ledger repair cannot promote unknown or superseded patch records', async () => {
    for (const legacy of [true, false]) {
      const t = await fixture('unsafe repair', 'original\n', { legacy })
      t.externalWrite(t.path, 'original\n')
      if (!legacy) {
        await appendSnapshot(t.scope, {
          id: `${t.id}-create`, filePath: t.path, command: 'write', op: 'create',
          before: null, beforeHash: null, after: 'original\n', afterHash: sha256('original\n'),
          time: (await t.row()).time + 1, state: 'recorded',
        })
      }
      const code = legacy ? 'unknown_state' : 'superseded_by_later_ops'
      const preview = await t.api.preview({ id: t.id })
      assert.equal(preview.canApply, false)
      assert.ok(preview.reasons.some(reason => reason.code === code))
      // Call repair directly despite the absence of a stale-ledger preview.
      await rejectCode(() => t.api.confirmStaleLedger({ id: t.id }), code)
      await rejectCode(() => t.api.reapply({ id: t.id }), 'not_reverted')
      assert.equal((await t.row()).state, 'recorded')
      assert.equal(readFileSync(t.path, 'utf8'), 'original\n')
      assert.equal(t.state.writes + t.state.deletes, 0)
    }
  })

  console.log(`\nALL ${cases} PATCH UNDO CHECKS PASSED`)
} finally {
  assert.match(relative(tempParent, resolve(root)), /^file-undo-patch-[a-z0-9]+$/i)
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
