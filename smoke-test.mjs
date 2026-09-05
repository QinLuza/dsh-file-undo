/**
 * Isolated smoke test for dsh-file-undo against the DSH 0.1.1-rc.2 contracts
 * (v0.3.0 scoped-store edition).
 *
 * - HOME/USERPROFILE are redirected to a throwaway home BEFORE lib is imported,
 *   so snapshots and the git archive never touch the real ~/.dsh. (The old
 *   run-smoke.ps1 wrapper is gone; the redirection now lives here.)
 * - ctx is a minimal harness faithful to the rc.2 + v0.3.0 seams:
 *   ctx.on + waterfall (cordis 4.0.1 composition), ctx.effect(generator),
 *   ctx.inject(services, cb) — headless form: the callback never runs because
 *   webServer never becomes available in this harness,
 *   ctx.commands.register, fs.resolve(path,{cwd})/readText/writeText(5-arg),
 *   sandboxPolicy.resolve({ session } | { mode }).
 * - Agent shape follows the v0.3.0 scope contract: agent.id = chatKey,
 *   agent.session.header.cwd = workspaceKey source. Events without a faithful
 *   agent produce no snapshots at all (by design), so every event carries one.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const workspace = await mkdtemp(join(tmpdir(), 'file-undo-ws-'))
const fakeHome = await mkdtemp(join(tmpdir(), 'file-undo-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome

const { apply, archiveSettled, name: pluginName, inject: pluginInject } = await import('./lib/index.js')
const { workspaceKeyOf } = await import('./lib/store.js')

let failures = 0
function check(label, cond, extra = '') {
  const mark = cond ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${label}${extra ? ` — ${extra}` : ''}`)
  if (!cond) failures += 1
}

// ── contract-faithful fs (shapes verified from dsh-fs-local@0.1.1-rc.2) ──────
let lastWritePolicy = 'none'
const fs = {
  async resolve(path, _opts) {
    // Faithful to dsh-fs-local: absolute inputs resolve to themselves, only
    // relative ones join the (session) cwd. The undo path re-resolves the
    // STORED absolute filePath, so joining here would corrupt it.
    const absolute = /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\')
    return { targetKey: absolute ? path : join(workspace, path), displayPath: path }
  },
  async readText(target) {
    return readFile(target.targetKey, 'utf8')
  },
  async writeText(target, content, expected, signal, policy) {
    lastWritePolicy = policy
    await writeFile(target.targetKey, content, 'utf8')
    return { kind: 'written' }
  },
}

const sandboxPolicy = {
  resolve(opts = {}) {
    const mode = opts.mode ?? opts.session?.mode ?? 'workspace-write'
    return { mode, workspaceRoot: workspace }
  },
}

// ── faithful agent (v0.3.0 scope contract: agent.id + session.header.cwd) ────
const AGENT = {
  id: 'smoke-session',
  session: { header: { cwd: workspace }, mode: 'workspace-write' },
}

// ── minimal ctx: cordis 4.0.1 listener/effect/waterfall/inject composition ──
const listeners = new Map()
const registeredCommands = new Map()
const ctx = {
  fs,
  sandboxPolicy,
  commands: {
    register(definition) {
      registeredCommands.set(definition.name, definition)
      return () => registeredCommands.delete(definition.name)
    },
  },
  on(name, listener) {
    const list = listeners.get(name) ?? []
    list.push(listener)
    listeners.set(name, list)
    return () => {
      const i = list.indexOf(listener)
      if (i >= 0) list.splice(i, 1)
    }
  },
  effect(genFn, label) {
    const it = genFn()
    let step = it.next()
    while (!step.done) step = it.next(step.value)
    return step.value
  },
  /**
   * Reactive service wait (cordis semantics). Headless harness: webServer is
   * never registered, so the callback must never run — mirroring how the
   * plugin's HTTP surface simply stays unmounted without a web server.
   */
  inject(_services, _cb) {
    return () => {}
  },
}

/** Mirror of cordis Events.waterfall: outermost-first, last arg = inner next. */
function waterfall(name, arg, inner) {
  const cbs = [...(listeners.get(name) ?? [])]
  let chain = inner
  for (const cb of cbs.reverse()) {
    const prev = chain
    chain = () => cb(arg, prev)
  }
  return chain()
}

// ── mount the plugin ─────────────────────────────────────────────────────────
apply(ctx)
const undo = registeredCommands.get('undo')
check('/undo command registered', undo !== undefined)
check('module exports name + inject', pluginName === 'file-undo' && Array.isArray(pluginInject) && ['commands', 'tools', 'fs', 'sandboxPolicy'].every(s => pluginInject.includes(s)), `name=${pluginName} inject=[${pluginInject}]`)

async function callUndo(rawInput) {
  return undo.handler({ rawInput, agent: AGENT })
}

const scopedSnapshots = join(fakeHome, '.dsh', 'file-undo', workspaceKeyOf(workspace), 'smoke-session', 'snapshots.jsonl')

const fileA = join(workspace, 'a.txt')
await writeFile(fileA, 'hello', 'utf8')

/** Fire a full tool lifecycle (pre snapshot → work → post backfill) like the real harness does. */
/** Multi-arg waterfall — post-execute listeners are (exec, result, next). */
function waterfallArgs(name, args, inner) {
  const cbs = [...(listeners.get(name) ?? [])]
  let chain = inner
  for (const cb of cbs.reverse()) {
    const prev = chain
    chain = () => cb(...args, prev)
  }
  return chain()
}

async function runTool(exec, work) {
  await waterfall('tools/pre-execute', exec, async () => {
    await work()
    return { kind: 'allow' }
  })
  await waterfallArgs('tools/post-execute', [exec, { isError: false }], async () => ({ kind: 'allow' }))
}

// 1) write mutation: pre snapshot captures before-state, tool writes, post backfills.
await runTool({ name: 'write', arguments: { file_path: 'a.txt', content: 'WORLD' }, agent: AGENT, callId: 'call-w1' }, async () => {
  await writeFile(fileA, 'WORLD', 'utf8')
})
check('write snapshotted before-state', (await readFile(fileA, 'utf8')) === 'WORLD')

// 2) edit mutation on top.
await runTool({ name: 'edit', arguments: { file_path: 'a.txt', old_string: 'WORLD', new_string: 'WORLD!' }, agent: AGENT, callId: 'call-e1' }, async () => {
  await writeFile(fileA, 'WORLD!', 'utf8')
})

// 2b) /undo sessions: the switcher directory. This smoke run has NO sessionQuery
// seam, so the command must report "unavailable" rather than throwing — the
// panel hides the switcher in exactly this case.
const sessionsOut = await callUndo('sessions')
check('/undo sessions reports unavailable without the seam', sessionsOut.kind === 'success' && sessionsOut.text.includes('不可用'), `kind=${sessionsOut.kind} text=${String(sessionsOut.text).slice(0, 60)}`)

// non-mutating tools must NOT snapshot (scoped store stays at 2 entries).
const countSnapshots = async () => {
  const text = await readFile(scopedSnapshots, 'utf8').catch(() => '')
  return text === '' ? 0 : text.trim().split('\n').length
}
await waterfall('tools/pre-execute', { name: 'read', arguments: { file_path: 'a.txt' }, agent: AGENT }, async () => ({ kind: 'allow' }))
check('read does not snapshot', (await countSnapshots()) === 2, `entries=${await countSnapshots()}`)
// prune with default retention keeps fresh snapshots (store holds the 2 above).
const pruned = await callUndo('prune')
check('/undo prune keeps fresh snapshots', pruned.kind === 'success' && pruned.text.includes('没有可清理'), pruned.text)

// 3) /undo list shows two entries.
const listed = await callUndo('list')
check('/undo list reports 2 entries', listed.kind === 'success' && listed.text.includes('[0]') && listed.text.includes('[1]'), listed.text?.split('\n')[0])

// 4) /undo restores the edit (WORLD! → WORLD).
const undone = await callUndo('')
check('/undo restored edit', undone.kind === 'success' && (await readFile(fileA, 'utf8')) === 'WORLD', undone.text)
check('undo write carried session policy', lastWritePolicy?.mode === 'workspace-write')

// 5) /undo <n> restores the write (WORLD → hello).
const undone0 = await callUndo('0')
check('/undo 0 restored write', undone0.kind === 'success' && (await readFile(fileA, 'utf8')) === 'hello', undone0.text)

// 6) creation undo DELETES the created file (hash-gated by the captured after)
await runTool({ name: 'write', arguments: { file_path: 'new.txt', content: 'fresh' }, agent: AGENT, callId: 'call-n1' }, async () => {
  await writeFile(join(workspace, 'new.txt'), 'fresh', 'utf8')
})
const createUndo = await callUndo('')
check('/undo of creation deletes the file', createUndo.kind === 'success' && createUndo.text.includes('Deleted'), createUndo.text)
let goneCheck = true
try { await readFile(join(workspace, 'new.txt'), 'utf8'); goneCheck = false } catch { goneCheck = true }
check('creation undo really removed the file', goneCheck)

// 7) prune after everything is undone: v0.3.0 keeps undone entries as
//    state='reverted' (history is preserved, not deleted), so the store still
//    holds 3 entries and the sweep reports nothing expired.
const prunedEmpty = await callUndo('prune')
check('/undo prune reports cleanly when nothing expired', prunedEmpty.kind === 'success' && prunedEmpty.text.includes('没有可清理'), prunedEmpty.text)

// 8) layer B: git archive mirrors snapshots 1:1 and can restore. The archive
//    is append-only (undo never deletes commits), so index 1 = the edit
//    snapshot whose before-state is 'WORLD'.
await archiveSettled()
const status = await callUndo('git-status')
let gitOk = false
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' })
  gitOk = true
} catch { /* no git in PATH */ }
if (gitOk) {
  check('/undo git-status sees archive commits', status.kind === 'success' && /\d+ commit/.test(status.text), status.text)
  const restored = await callUndo('git 1')
  check('/undo git 1 restored from archive', restored.kind === 'success' && (await readFile(fileA, 'utf8')) === 'WORLD', restored.text)
} else {
  check('/undo git-status degrades without git', status.kind === 'success' && status.text.includes('disabled'), status.text)
}

// 9) str_replace_editor family (docs/tool-catalog.md): str_replace/insert/
//    create mutate and MUST snapshot; view is read-only and must NOT.
const beforeSr = await countSnapshots()
await waterfall('tools/pre-execute', { name: 'str_replace_editor', arguments: { command: 'view', path: 'a.txt' }, agent: AGENT }, async () => ({ kind: 'allow' }))
check('str_replace_editor view does not snapshot', (await countSnapshots()) === beforeSr, `entries=${await countSnapshots()}`)

const contentBeforeSr = await readFile(fileA, 'utf8')
await runTool({ name: 'str_replace_editor', arguments: { command: 'str_replace', path: 'a.txt', old_string: 'hello', new_string: 'hi' }, agent: AGENT, callId: 'call-sr1' }, async () => {
  await writeFile(fileA, 'hi', 'utf8')
})
check('str_replace_editor str_replace snapshots', (await countSnapshots()) === beforeSr + 1, `entries=${await countSnapshots()}`)
const undoneSr = await callUndo('')
check('/undo restores str_replace_editor change', undoneSr.kind === 'success' && (await readFile(fileA, 'utf8')) === contentBeforeSr, `${undoneSr.text} (expect ${JSON.stringify(contentBeforeSr)})`)

await runTool({ name: 'str_replace_editor', arguments: { command: 'create', path: 'made.txt', file_text: 'x' }, agent: AGENT, callId: 'call-cr1' }, async () => {
  await writeFile(join(workspace, 'made.txt'), 'x', 'utf8')
})
const createSr = await callUndo('')
check('/undo of str_replace_editor create deletes the file', createSr.kind === 'success' && createSr.text.includes('Deleted'), createSr.text)
let madeGone = true
try { await readFile(join(workspace, 'made.txt'), 'utf8'); madeGone = false } catch { madeGone = true }
check('str_replace_editor create undo really removed the file', madeGone)

// Windows: a just-finished git process can still hold the archive dir for a
// moment — retry the rmdir instead of crashing after all checks passed.
await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
await rm(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
