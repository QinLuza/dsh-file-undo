/**
 * End-to-end verification for dsh-file-undo — runs OUTSIDE the live DSH
 * runtime (no deployment, no restart, no interference with the current GUI
 * session). Mocks only the cordis Context surface the plugin touches
 * (ctx.on / ctx.commands.register / ctx.fs), backed by REAL node:fs on a
 * temp directory, then drives the plugin's apply() through a real
 * pre-execute snapshot and /undo restore.
 */
import { apply } from './lib/index.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── mock Context ─────────────────────────────────────────────────────────
const preExecuteListeners = []
const commandHandlers = new Map()
let fsRoot = ''

const mockFs = {
  resolve: async (path) => ({ targetKey: `file:${path}`, displayPath: path }),
  readText: async (target) => readFile(target.displayPath, 'utf8'),
  writeText: async (target, content) => { await writeFile(target.displayPath, content, 'utf8') },
}

const mockCtx = {
  fs: mockFs,
  on: (name, listener) => { if (name === 'tools/pre-execute') preExecuteListeners.push(listener) },
  commands: {
    register: (def) => { commandHandlers.set(def.name, def.handler) },
  },
}

// ── helpers ──────────────────────────────────────────────────────────────
let failures = 0
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`) } else { failures++; console.log(`  ✗ ${label}`) }
}

async function triggerPreExecute(exec) {
  const listener = preExecuteListeners[0]
  if (!listener) throw new Error('no pre-execute listener registered')
  await listener(exec, async () => ({ kind: 'allow' }))
}

async function runUndo(rawInput) {
  const handler = commandHandlers.get('undo')
  if (!handler) throw new Error('/undo not registered')
  return handler({ rawInput })
}

// ── run ──────────────────────────────────────────────────────────────────
fsRoot = await mkdtemp(join(tmpdir(), 'dsh-file-undo-test-'))
const file = join(fsRoot, 'target.txt')
const fileB = join(fsRoot, 'new.txt')
await writeFile(file, 'ORIGINAL CONTENT\n', 'utf8')

console.log('apply() registers hooks...')
apply(mockCtx)
assert(preExecuteListeners.length === 1, 'tools/pre-execute listener registered')
assert(commandHandlers.has('undo'), '/undo command registered')

console.log('snapshot before a str_replace mutation...')
await triggerPreExecute({ name: 'str_replace_editor', arguments: { command: 'str_replace', path: file } })
const snapshots = (await readFile(join(process.env.HOME || process.env.USERPROFILE, '.dsh', 'file-undo', 'snapshots.jsonl'), 'utf8')).trim().split('\n')
assert(snapshots.length === 1, `one snapshot recorded (got ${snapshots.length})`)
const snap = JSON.parse(snapshots[0])
assert(snap.filePath === file, 'snapshot filePath matches')
assert(snap.command === 'str_replace', 'snapshot command is str_replace')
assert(snap.before === 'ORIGINAL CONTENT\n', 'snapshot before is the pre-op content')

console.log('mutate the file (simulate the tool body running)...')
await writeFile(file, 'CHANGED CONTENT\n', 'utf8')

console.log('/undo restores the file...')
const result = await runUndo('')
assert(result.kind === 'success', `/undo succeeded (kind=${result.kind})`)
const restored = await readFile(file, 'utf8')
assert(restored === 'ORIGINAL CONTENT\n', 'file content restored to before-state')

console.log('/undo list shows remaining history...')
// insert into an EXISTING file so before is non-null and undoable
await writeFile(fileB, 'EXISTING FILE\n', 'utf8')
await triggerPreExecute({ name: 'str_replace_editor', arguments: { command: 'insert', path: fileB } })
const listResult = await runUndo('list')
assert(listResult.kind === 'success' && listResult.text.includes('[0]'), '/undo list shows the remaining 1 entry')

console.log('/undo <n> picks a specific operation...')
const pickResult = await runUndo('0')
assert(pickResult.kind === 'success', `/undo <n> succeeded (kind=${pickResult.kind})`)
const restoredB = await readFile(fileB, 'utf8')
assert(restoredB === 'EXISTING FILE\n', 'file restored to before-state via /undo <n>')

console.log('/undo on a creation reports the official-fs limitation...')
await triggerPreExecute({ name: 'str_replace_editor', arguments: { command: 'create', path: join(fsRoot, 'ghost.txt') } })
const createResult = await runUndo('')
assert(createResult.kind === 'error' && createResult.text.includes('file deletion is not supported'), 'creation undo reports limitation (no node:fs side-step)')

// cleanup
await rm(fsRoot, { recursive: true, force: true })
await rm(join(process.env.HOME || process.env.USERPROFILE, '.dsh', 'file-undo'), { recursive: true, force: true })

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`)
process.exit(failures === 0 ? 0 : 1)
