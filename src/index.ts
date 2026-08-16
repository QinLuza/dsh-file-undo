/**
 * dsh-file-undo — undo file write/edit operations in DSH.
 *
 * Snapshot the before-state of every `write` / `edit` tool mutation
 * through the `tools/pre-execute` waterfall, store it append-only, and
 * restore with `/undo`.
 *
 * Design (evidence-backed):
 * - The write/edit tools discard the fs outcome's `before` (return only a
 *   success string), so the before-state MUST be captured by reading the
 *   target in `tools/pre-execute`, before the tool body runs.
 * - Official fs has NO delete/unlink method, and file deletion is out of
 *   scope (awaiting official support): creation undo (before=null) reports
 *   the limitation instead of side-stepping it.
 * - Snapshots are append-only JSONL (one line per snapshot) to avoid
 *   read-modify-write races between concurrent tool calls.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'    // ctx.tools + tools/pre-execute Events 类型合并
import type {} from '@deepseek-ai/dsh-fs'       // ctx.fs 类型合并
import type {} from '@deepseek-ai/dsh-commands' // ctx.commands 类型合并
import type {} from '@deepseek-ai/dsh-sandbox-policy' // ctx.sandboxPolicy 类型合并
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { PreToolDecision, ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'

export const name = 'file-undo'
export const inject = ['commands', 'tools', 'fs', 'sandboxPolicy']

/** One recorded mutation. `before` is the full file content prior to the op. */
interface FileUndoSnapshot {
  /** Target path as the model supplied it (display path). */
  filePath: string
  /** The mutating tool name: write | edit. */
  command: string
  /** Full content before the op; null when the file did not exist (write of a new file). */
  before: string | null
  /** Unix epoch ms. */
  time: number
}

/** Default retention for snapshot pruning, in days. */
const DEFAULT_PRUNE_DAYS = 7

/** Append-only JSONL snapshot store under ~/.dsh/file-undo/snapshots.jsonl. */
function snapshotPath(): string {
  return join(homedir(), '.dsh', 'file-undo', 'snapshots.jsonl')
}

async function ensureDir(): Promise<void> {
  await mkdir(join(homedir(), '.dsh', 'file-undo'), { recursive: true })
}

async function appendSnapshot(snapshot: FileUndoSnapshot): Promise<void> {
  await ensureDir()
  await appendFile(snapshotPath(), `${JSON.stringify(snapshot)}\n`, 'utf8')
}

async function loadSnapshots(): Promise<FileUndoSnapshot[]> {
  try {
    const text = await readFile(snapshotPath(), 'utf8')
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as FileUndoSnapshot)
  } catch {
    return []
  }
}

/** Remove the last snapshot and return it. */
async function popSnapshot(): Promise<FileUndoSnapshot | undefined> {
  const all = await loadSnapshots()
  if (all.length === 0) return undefined
  const last = all[all.length - 1]
  await writeFile(snapshotPath(), all.slice(0, -1).map(s => `${JSON.stringify(s)}\n`).join(''), 'utf8')
  return last
}

/**
 * Drop snapshots older than `days` and rewrite the store with the survivors.
 * This only shrinks undo history (how far back /undo can reach); it never
 * touches current file contents. Entries whose `time` is not a number are
 * kept (conservative: unknown-age data is never deleted).
 */
async function pruneSnapshots(days: number): Promise<string> {
  const all = await loadSnapshots()
  if (all.length === 0) return 'No snapshots to prune.'
  const cutoff = Date.now() - days * 86_400_000
  const kept = all.filter(s => typeof s.time !== 'number' || s.time >= cutoff)
  const removed = all.length - kept.length
  if (removed === 0) return `Nothing pruned: all ${all.length} snapshot(s) are within ${days} day(s).`
  await writeFile(snapshotPath(), kept.map(s => `${JSON.stringify(s)}\n`).join(''), 'utf8')
  return `Pruned ${removed} snapshot(s) older than ${days} day(s); ${kept.length} kept.`
}

/** Remove one snapshot at an index (used by /undo <n>). */
async function removeSnapshotAt(index: number): Promise<FileUndoSnapshot | undefined> {
  const all = await loadSnapshots()
  const target = all[index]
  if (target === undefined) return undefined
  const rest = all.filter((_, i) => i !== index)
  await writeFile(snapshotPath(), rest.map(s => `${JSON.stringify(s)}\n`).join(''), 'utf8')
  return target
}

/** Snapshot one mutation before it executes; never throws (must not block tools). */
async function snapshotIfMutation(exec: ToolExecutionInput, fs: FileSystem): Promise<void> {
  if (exec.name !== 'write' && exec.name !== 'edit') return
  const args = exec.arguments as { file_path?: string } | undefined
  if (args === undefined || typeof args !== 'object' || typeof args.file_path !== 'string') return
  try {
    const target = await fs.resolve(args.file_path)
    let before: string | null = null
    try {
      before = await fs.readText(target)
    } catch {
      // write of a new file: target absent; before stays null.
    }
    await appendSnapshot({ filePath: args.file_path, command: exec.name, before, time: Date.now() })
  } catch (error) {
    console.error('[file-undo] snapshot failed:', error)
  }
}

export function apply(ctx: Context): void {
  // ── Intercept: capture before-state of every file mutation ──────────────
  ctx.on('tools/pre-execute', async (exec: ToolExecutionInput, next: () => Promise<PreToolDecision>) => {
    const fs = ctx.fs
    if (fs !== undefined) await snapshotIfMutation(exec, fs)
    return next()
  })

  // ── Undo entry point ─────────────────────────────────────────────────────
  ctx.effect(function* () {
    // Lazy retention sweep on plugin load: keep the store bounded without
    // waiting for the user to remember the command. Failure here must never
    // block command registration.
    pruneSnapshots(DEFAULT_PRUNE_DAYS).catch(error => {
      console.error('[file-undo] lazy prune failed:', error)
    })

    yield ctx.commands.register({
      name: 'undo',
      description: 'Undo file write/edit operations. Usage: /undo (last), /undo list, /undo <n>, /undo prune [days]',
      input: { hint: '[list | <n> | prune [days]]' },
      handler: async (invocation) => {
        const raw = invocation.rawInput.trim()
        // ── /undo prune [days]: drop snapshots older than N days (default 7) ─
        if (raw === 'prune' || raw.startsWith('prune ')) {
          const arg = raw.split(/\s+/)[1]
          let days = DEFAULT_PRUNE_DAYS
          if (arg !== undefined) {
            const parsed = Number(arg)
            if (!Number.isFinite(parsed) || parsed <= 0) {
              return { kind: 'error', text: `Invalid prune retention "${arg}". Usage: /undo prune [days] (days > 0, default ${DEFAULT_PRUNE_DAYS}).` }
            }
            days = parsed
          }
          return { kind: 'success', text: await pruneSnapshots(days) }
        }
        // ── /undo list: show the recorded operation history ──────────────────
        if (raw === 'list') {
          const all = await loadSnapshots()
          if (all.length === 0) return { kind: 'error', text: 'No file operations recorded yet.' }
          const lines = all.map((s, i) =>
            `[${i}] ${s.time !== undefined ? new Date(s.time).toLocaleTimeString() : '?'} ${s.command} ${s.filePath}`)
          return { kind: 'success', text: `Undo history (${all.length}):\n${lines.join('\n')}` }
        }
        // ── /undo <n>: pick a specific operation point ───────────────────────
        if (/^\d+$/.test(raw)) {
          const index = Number(raw)
          const all = await loadSnapshots()
          const snapshot = all[index]
          if (snapshot === undefined) return { kind: 'error', text: `No operation at index ${index} (0..${all.length - 1}).` }
          await removeSnapshotAt(index)
          return restoreSnapshot(ctx, snapshot, invocation.agent.session)
        }
        // ── /undo: the most recent operation ─────────────────────────────────
        const snapshot = await popSnapshot()
        if (snapshot === undefined) return { kind: 'error', text: 'Nothing to undo.' }
        return restoreSnapshot(ctx, snapshot, invocation.agent.session)
      },
    })
  }, 'file-undo lifecycle')
}

/** Restore one snapshot's before-state via the official fs service. */
async function restoreSnapshot(ctx: Context, snapshot: FileUndoSnapshot, session: Session): Promise<CommandResult> {
  if (snapshot.before === null) {
    // File creation undo requires deletion; official fs has no delete and
    // file deletion is deliberately out of scope (waiting for official
    // support) — report the limitation instead of side-stepping it.
    return {
      kind: 'error',
      text: `Cannot undo a file creation (${snapshot.filePath}) — file deletion is not supported by official fs yet.`,
    }
  }
  try {
    const target = await ctx.fs.resolve(snapshot.filePath)
    // Carry the caller session's sandbox policy so the restore writes under
    // the same workspace boundary the original mutation ran under.
    const policy = ctx.sandboxPolicy.resolve({ session })
    await ctx.fs.writeText(target, snapshot.before, undefined, undefined, policy)
    return { kind: 'success', text: `Restored ${snapshot.filePath} (undo of ${snapshot.command}).` }
  } catch (error) {
    return { kind: 'error', text: `Undo failed: ${String(error)}` }
  }
}
