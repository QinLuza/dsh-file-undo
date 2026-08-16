/**
 * Isolated verification for the snapshot retention (prune) feature.
 *
 * Overrides HOME/USERPROFILE to a temp directory BEFORE importing lib so the
 * plugin's snapshotPath() lands inside the temp dir — the real user store at
 * ~/.dsh/file-undo/snapshots.jsonl is never touched.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempHome = await mkdtemp(join(tmpdir(), 'dsh-file-undo-prune-test-'))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome

const { apply } = await import('./lib/index.js')

let failures = 0
function assert(cond, label) {
  if (cond) console.log(`  ✓ ${label}`)
  else { failures++; console.log(`  ✗ ${label}`) }
}

const storePath = join(tempHome, '.dsh', 'file-undo', 'snapshots.jsonl')
const now = Date.now()
const D = 86_400_000

// Seed: 2 old (10d, 8d), 1 young (1d), 1 unknown-age (no time field)
const seeds = [
  { filePath: 'old1.txt', command: 'write', before: 'a', time: now - 10 * D },
  { filePath: 'old2.txt', command: 'edit', before: 'b', time: now - 8 * D },
  { filePath: 'young.txt', command: 'edit', before: 'c', time: now - 1 * D },
  { filePath: 'unknown.txt', command: 'write', before: 'd' },
]
await import('node:fs/promises').then(m => m.mkdir(join(tempHome, '.dsh', 'file-undo'), { recursive: true }))
await writeFile(storePath, seeds.map(s => JSON.stringify(s)).join('\n') + '\n', 'utf8')

// Mock context: minimal surface (no fs needed; prune never touches files).
// ctx.effect runs the generator eagerly so register() executes synchronously.
const commandHandlers = new Map()
apply({
  on: () => {},
  effect: function (gen) { const it = gen(); let r = it.next(); while (!r.done) r = it.next() },
  commands: { register: (def) => commandHandlers.set(def.name, def.handler) },
  fs: undefined,
  sandboxPolicy: undefined,
})
// Give the lazy startup prune a tick to settle (it targets the same store).
await new Promise(r => setTimeout(r, 50))

const run = async (raw) => commandHandlers.get('undo')({ rawInput: raw })

console.log('/undo prune with invalid retention is rejected...')
const bad = await run('prune abc')
assert(bad.kind === 'error' && bad.text.includes('Invalid prune retention'), 'invalid days -> error')
const badNeg = await run('prune -3')
assert(badNeg.kind === 'error', 'negative days -> error')

console.log('/undo prune 5 keeps young + unknown-age, drops 10d and 8d...')
const r5 = await run('prune 5')
assert(r5.kind === 'success', `prune 5 succeeded (kind=${r5.kind})`)
const after5 = (await readFile(storePath, 'utf8')).trim().split('\n').map(JSON.parse)
assert(after5.length === 2, `2 kept after prune 5 (got ${after5.length})`)
assert(after5.every(s => s.filePath !== 'old1.txt' && s.filePath !== 'old2.txt'), 'both old entries removed')
assert(after5.some(s => s.filePath === 'young.txt'), 'young entry kept')
assert(after5.some(s => s.filePath === 'unknown.txt'), 'unknown-age entry kept (conservative)')

console.log('/undo prune on empty history reports cleanly...')
await writeFile(storePath, '', 'utf8')
const empty = await run('prune')
assert(empty.kind === 'success' && empty.text.includes('No snapshots to prune'), 'empty store handled')

console.log('/undo prune defaults to 7 days...')
await writeFile(storePath, JSON.stringify({ filePath: 'x.txt', command: 'edit', before: 'z', time: now - 6 * D }) + '\n', 'utf8')
const def = await run('prune')
assert(def.kind === 'success' && def.text.includes('Nothing pruned'), '6d-old entry survives default 7d prune')

console.log('list/undo still work after prune wiring...')
const list = await run('list')
assert(list.kind === 'success' && list.text.includes('x.txt'), '/undo list unaffected')

await rm(tempHome, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PRUNE CHECKS PASSED' : `\n${failures} CHECKS FAILED`)
process.exit(failures === 0 ? 0 : 1)
