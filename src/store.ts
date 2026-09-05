/**
 * Snapshot store v2.1 — scoped by workspace and chat (reference-style isolation).
 *
 * Modeled on the reference "workspace_file_before_change" checkpoint analysis:
 * - Full-text snapshots (never reverse patches): review renders a computed
 *   diff, undo writes the whole `before` content back. The two paths stay
 *   decoupled and both stay simple.
 * - `after` + `afterHash` are backfilled once the mutating tool settles
 *   (`tools/post-execute`), giving the external-modification check an
 *   expected hash to compare the live file against (optimistic concurrency).
 * - `state` closes the loop: recorded → reverted → reapplied. An undone
 *   entry can be re-applied (write the `after` content back), matching the
 *   reference `changed → reverted → reapplied` state machine.
 *
 * Storage is scoped per workspace and per chat (two directory levels):
 *   ~/.dsh/file-undo/<workspace-key>/<chat-key>/snapshots.jsonl
 * The workspace key is derived from the session's cwd; the chat key is the
 * session id. Persistence stays the append-only JSONL (one line per
 * snapshot; appends avoid read-modify-write races between concurrent tool
 * calls). Point updates (backfill / revert-mark / prune) rewrite the file
 * behind a single-flight write lock. Legacy lines without the v2 fields are
 * normalized on load.
 */
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { cachedStructuredDiff, diffStats } from './diff.js'

/** One recorded mutation. `before`/`after` are full file contents. */
export interface FileUndoSnapshot {
  /** Stable unique id (`<time>-<seq>`); minted on load for legacy entries. */
  id: string
  /** Target path as the model supplied it (display path). */
  filePath: string
  /** The mutating tool name: write | edit | str_replace_editor. */
  command: string
  /** Sub-command for multi-command tools (str_replace_editor): create | str_replace | insert. */
  op?: string
  /** The tool call's immutable identity — pairs the pre snapshot with its post backfill exactly. */
  callId?: string
  /** Why the call failed (post-execute isError); present only on aborted rows. */
  failReason?: string
  /** Full content before the op; null when the file did not exist (write of a new file). */
  before: string | null
  /** sha256(before) hex when before !== null. */
  beforeHash: string | null
  /** Full content after the op settled (backfilled by tools/post-execute); null until then (or legacy). */
  after: string | null
  /** sha256(after) hex — the expected hash of the live file for external-modification checks. */
  afterHash: string | null
  /** Unix epoch ms. */
  time: number
  /**
   * Lifecycle: recorded → reverted → reapplied. `reverted` entries carry the
   * "已撤销" badge and offer re-apply; `reapplied` means the after-state was
   * written back after an undo (entry is active again, badge cleared).
   * `aborted` marks a FAILED tool call (post-execute saw isError); `noop`
   * marks a call that SUCCEEDED but changed nothing (after === before).
   * Both carry no undo value — aborted rows show a 失败 badge with the
   * failure reason, noop rows a gray 无变化 badge.
   */
  state: 'recorded' | 'reverted' | 'reapplied' | 'aborted' | 'noop'
  /**
   * 轮次聚合键：一次模型请求的整个调用树共享同一值（定稿 1.3）。
   * pre-execute 钩子的 `ToolExecutionInput.rootCallId` 类型上可选，post-execute 的
   * `ToolExecution` 才必填，所以 append 时尽力存、backfill 时强制补写。
   * 缺失是合法的（legacy FIFO 退化、aborted 行永不 backfill）——UI 必须容忍。
   */
  rootCallId?: string
  /**
   * 撤销原因：区分「主动撤销」与「被级联回退连带报废」。
   * 不变式 I1（定稿 4.1）：进入 `reverted` 的条目必带此字段——
   * Reapply 拦截用白名单判据 `revertReason !== 'direct'`，缺失即拒绝（fail-closed）。
   */
  revertReason?: 'direct' | 'cascade'
  /**
   * 级联来源（v0.3.11）：本行是被哪一条 target 的回退连带报废的（存 target.id）。
   * 只由 rewindApply 在标记 cascade 时写入；reapply 该 target 时据此把整批
   * cascade 行一并复活，让「回退 → 重应用」这个 undo/redo 循环恢复幂等——
   * 此前 cascade 行会变成既不能回退、也不能重应用的砖头。
   * 缺失合法（旧数据、direct 行、从未被级联）——此时无连带复活。
   */
  cascadeOf?: string
}

/**
 * Where one store lives: a workspace directory + a chat directory.
 * `workspaceKey` is derived from the session cwd (sanitize + short hash
 * suffix against collisions and Windows path-length limits); `chatKey` is
 * the session id (already filesystem-safe).
 */
export interface StoreScope {
  workspaceKey: string
  chatKey: string
}

/** Default retention for snapshot pruning, in days. */
export const DEFAULT_PRUNE_DAYS = 7

function storeRoot(): string {
  return join(homedir(), '.dsh', 'file-undo')
}

/**
 * Canonical form of a working directory: ONE directory ⇒ exactly ONE string.
 *
 * `session.header.cwd` is whatever the launcher handed the platform, so the
 * same directory can arrive as `D:\proj`, `D:\proj\`, `d:\proj` or `D:/proj`
 * — four different hash inputs, four workspace keys, four store directories
 * for a single project. The panel then binds to one of them and the other
 * sessions' history looks like it never existed.
 *
 * Normalisation is purely LEXICAL (no I/O, no symlink resolution): separator
 * unification, run collapsing, `.`/`..` resolution, trailing-separator
 * stripping (filesystem roots keep theirs), and drive-letter folding on
 * Windows. Symlinks are deliberately NOT resolved: the session's logical cwd
 * is the sandbox root, and rewriting it to a realpath would silently widen or
 * move the boundary the platform enforces.
 */
export function canonicalCwd(cwd: string): string {
  const trimmed = cwd.trim()
  if (trimmed === '') return trimmed
  const win = process.platform === 'win32'
  const sep = win ? '\\' : '/'
  // 1. Unify separators (also collapses runs: 'a//b' → single separator).
  const unified = trimmed.replace(/[/\\]+/g, sep)
  // 2. Split off the rooted prefix so it survives the segment rebuild.
  let prefix = ''
  let body = unified
  if (win) {
    if (body.startsWith('\\\\')) { prefix = '\\\\'; body = body.slice(2) }
  } else if (body.startsWith(sep)) {
    prefix = sep
    body = body.slice(1)
  }
  // 3. Lexical resolution: drop '.' segments, pop on '..'.
  const stack: string[] = []
  for (const part of body.split(sep)) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') stack.pop()
      continue
    }
    stack.push(part)
  }
  let out = prefix + stack.join(sep)
  // 4. Roots keep their trailing separator ('D:\', '\\srv\share', '/').
  if (win) {
    if (/^[a-zA-Z]:$/.test(out)) out += sep
    if (/^[a-zA-Z]:/.test(out)) out = out[0].toUpperCase() + out.slice(1)
  } else if (out === '') {
    out = sep
  }
  // A single leading separator ('/' arriving on Windows, or a UNC server root)
  // is already a root; keep it rather than returning the empty string.
  if (out === '' && trimmed.startsWith(sep)) out = sep
  return out
}

/**
 * Whether a path designates a filesystem root — a boundary that must never
 * swallow unrelated projects into one "workspace".
 */
function isFilesystemRoot(dir: string): boolean {
  if (process.platform === 'win32') {
    // 'D:' / 'D:\', a bare '\', and UNC roots ('\\srv', '\\srv\share').
    return dir === '\\' || /^[a-zA-Z]:\\?$/.test(dir) || /^\\\\[^\\]+\\?$/.test(dir) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(dir)
  }
  return dir === '/' || dir === homedir()
}

/**
 * Whether two session working directories sit in the SAME project tree.
 *
 * Sessions legitimately start in different sub-directories of one project
 * (`D:\proj` and `D:\proj\sub`) — DSH gives each its own sandbox root, so
 * their cwds differ and `workspaceKeyOf` correctly yields two keys. Grouping
 * them is therefore a QUERY-TIME concern (session switcher, cross-session
 * views), never a storage concern: collapsing them at write time is a
 * one-way heuristic that would misfile history forever if it guessed wrong.
 *
 * Filesystem roots (drive roots, the home directory) are never ancestors of
 * anything meaningful — without that guard, every session under `D:\` would
 * collapse into a single workspace.
 */
export function sameWorkspaceTree(a: string, b: string): boolean {
  return isSameTree(canonicalCwd(a), canonicalCwd(b))
}

/** Containment on canonical paths, excluding filesystem roots. */
function isSameTree(ca: string, cb: string): boolean {
  if (ca === '' || cb === '') return false
  if (ca === cb) return true
  const [ancestor, descendant] = ca.length <= cb.length ? [ca, cb] : [cb, ca]
  if (isFilesystemRoot(ancestor)) return false
  const sep = process.platform === 'win32' ? '\\' : '/'
  const stem = ancestor.endsWith(sep) ? ancestor : ancestor + sep
  return descendant.startsWith(stem)
}

/**
 * Which of `candidates` belong to the SAME project tree as `anchorCwd`
 * (strategy A: pure path containment).
 *
 * Only the anchor↔candidate relation is ever evaluated — **never a transitive
 * closure**. With a closure, one intermediate directory (`D:\work`) would
 * chain its sibling projects (`D:\work\projA`, `D:\work\projB`) into a single
 * group; that is strategy A's main false-merge, and anchoring shrinks the
 * blast radius to "the current session's own ancestors and descendants".
 *
 * Async on purpose: strategy B (probe `.git`/`package.json` upwards for the
 * project root) needs I/O, and this signature keeps every call site untouched
 * when the internals switch. Strategy A itself does zero I/O.
 *
 * @returns the matching candidates, in input order, de-duplicated by their
 * canonical form (the caller usually needs the original strings back).
 */
export async function selectWorkspaceMembers(
  anchorCwd: string,
  candidates: readonly string[],
): Promise<string[]> {
  const anchor = canonicalCwd(anchorCwd)
  if (anchor === '') return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const candidate of candidates) {
    const canonical = canonicalCwd(candidate)
    if (canonical === '' || seen.has(canonical)) continue
    seen.add(canonical)
    if (isSameTree(anchor, canonical)) out.push(candidate)
  }
  return out
}

/**
 * Sanitize a cwd into a filesystem-safe directory name (collision-hardened).
 *
 * The IDENTITY is the hash suffix, computed over the CANONICAL directory —
 * the readable prefix is cosmetic and stays lossy on purpose (non-ASCII
 * directory names are still collapsed to '_', which is why two sibling
 * directories can share a prefix and differ only by suffix).
 */
export function workspaceKeyOf(cwd: string): string {
  const canonical = canonicalCwd(cwd)
  let key = canonical.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  if (key === '') key = 'default'
  // Code-point truncation: a UTF-16 slice can cut a surrogate pair in half
  // and mint a lone surrogate, which is not a legal filename component.
  const chars = [...key]
  if (chars.length > 64) key = chars.slice(0, 64).join('')
  // Short hash suffix: two different cwds sanitizing to the same 64 chars
  // (or truncated collisions) still get distinct directories.
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 8)
  return `${key}~${digest}`
}

export function scopeDir(scope: StoreScope): string {
  return join(storeRoot(), scope.workspaceKey, scope.chatKey)
}

export function snapshotPath(scope: StoreScope): string {
  return join(scopeDir(scope), 'snapshots.jsonl')
}

/**
 * Recover the most recently active scope from disk (restart recovery).
 *
 * `activeScope` is a module-level variable that resets to undefined on every
 * host restart, so the panel would show "no records" even though the scoped
 * stores persist on disk. This scans the store root for the scope whose
 * snapshots.jsonl was modified most recently (= the session that last did
 * file work) and returns it, so the panel re-binds after a restart without
 * requiring a new file operation.
 *
 * Returns undefined when no scope has a snapshots file yet.
 */
export async function recoverActiveScope(): Promise<StoreScope | undefined> {
  let workspaceKeys: string[]
  try {
    workspaceKeys = await readdir(storeRoot(), { withFileTypes: true })
      .then(entries => entries.filter(e => e.isDirectory()).map(e => e.name))
  } catch {
    return undefined // store root absent — nothing to recover
  }
  let best: { scope: StoreScope; mtimeMs: number } | undefined
  for (const workspaceKey of workspaceKeys) {
    let chatKeys: string[]
    try {
      chatKeys = await readdir(join(storeRoot(), workspaceKey), { withFileTypes: true })
        .then(entries => entries.filter(e => e.isDirectory()).map(e => e.name))
    } catch {
      continue
    }
    for (const chatKey of chatKeys) {
      const path = join(storeRoot(), workspaceKey, chatKey, 'snapshots.jsonl')
      try {
        const info = await stat(path)
        if (best === undefined || info.mtimeMs > best.mtimeMs) {
          best = { scope: { workspaceKey, chatKey }, mtimeMs: info.mtimeMs }
        }
      } catch {
        // no snapshots file in this scope — skip
      }
    }
  }
  return best?.scope
}

/** Temp path used by the locked rewrite (atomic rename keeps readers safe). */
function stagingPath(scope: StoreScope): string {
  return join(scopeDir(scope), 'snapshots.jsonl.tmp')
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Serializes every store mutation that is not a pure append. */
let writeChain: Promise<void> = Promise.resolve()

/**
 * Run `task` exclusively among locked mutations; failures never poison the chain.
 * Generic so a locked task can hand a value back to its caller (see
 * `markRevertedBatch`, which returns the number of rows it actually marked).
 */
function withLock<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task)
  writeChain = run.then(() => undefined, () => undefined)
  return run
}

async function ensureDir(scope: StoreScope): Promise<void> {
  await mkdir(scopeDir(scope), { recursive: true })
}

/** Mint a stable id for a snapshot that predates the v2 format. */
function legacyId(time: number, index: number): string {
  return `${time}-legacy${index}`
}

interface RawSnapshot {
  filePath?: unknown
  command?: unknown
  op?: unknown
  callId?: unknown
  failReason?: unknown
  before?: unknown
  after?: unknown
  afterHash?: unknown
  beforeHash?: unknown
  time?: unknown
  id?: unknown
  state?: unknown
  rootCallId?: unknown
  revertReason?: unknown
  cascadeOf?: unknown
}

/** Normalize one parsed JSONL line into a v2 snapshot. */
function normalize(raw: RawSnapshot, index: number): FileUndoSnapshot | undefined {
  if (typeof raw.filePath !== 'string' || typeof raw.command !== 'string') return undefined
  // time sentinel: -1 marks unknown-age legacy rows so prune keeps them
  // (a real epoch is always positive and modern).
  const time = typeof raw.time === 'number' && raw.time > 0 ? raw.time : -1
  const before = typeof raw.before === 'string' ? raw.before : null
  const after = typeof raw.after === 'string' ? raw.after : null
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : legacyId(time, index)
  const state =
    raw.state === 'reverted' ? 'reverted'
    : raw.state === 'reapplied' ? 'reapplied'
    : raw.state === 'aborted' ? 'aborted'
    : raw.state === 'noop' ? 'noop'
    : 'recorded'
  const op = typeof raw.op === 'string' && raw.op !== '' ? raw.op : undefined
  const callId = typeof raw.callId === 'string' && raw.callId !== '' ? raw.callId : undefined
  const failReason = typeof raw.failReason === 'string' && raw.failReason !== '' ? raw.failReason : undefined
  // 轮次聚合键：三层 fallback（定稿 1.2）。callId 自己也可能缺失（v0.3.4 前旧数据），
  // 所以落到 `id` 这一层——它恒存在，保证字段不会在下次重写时被丢掉。
  const rootCallId =
    typeof raw.rootCallId === 'string' && raw.rootCallId !== ''
      ? raw.rootCallId
      : callId !== undefined
        ? callId
        : id
  // 撤销原因：只认两个字面量，其余一律当缺失（旧数据还没有这个概念）。
  // 4.1 落地 3（v7.0）：旧数据迁移 —— v0.3.9 之前不存在 cascade，任何 `reverted`
  // 只可能由单条撤销产生，补 `'direct'` 是唯一正确解（不变式 I1：
  // `reverted` 必带 `revertReason`，否则 Reapply 白名单会把它拒为 unknown_revert）。
  const revertReason =
    raw.revertReason === 'direct' ? 'direct'
    : raw.revertReason === 'cascade' ? 'cascade'
    // 只迁移「字段缺失」的旧数据（4.1 落地 3）。字段存在但值未知（如被
    // 损坏/伪造的 'weird'）保持 undefined → Reapply 白名单判为 unknown_revert，
    // 这正是 fail-closed 要兜的诈尸入口；把未知值也吞成 direct 会让它失守。
    : raw.revertReason === undefined && state === 'reverted' ? 'direct'
    : undefined
  // 级联来源（v0.3.11）：只认非空字符串，其余一律当缺失（旧数据没有这个概念）。
  const cascadeOf = typeof raw.cascadeOf === 'string' && raw.cascadeOf !== '' ? raw.cascadeOf : undefined
  return {
    id,
    filePath: raw.filePath,
    command: raw.command,
    ...(op !== undefined ? { op } : {}),
    ...(callId !== undefined ? { callId } : {}),
    ...(failReason !== undefined ? { failReason } : {}),
    before,
    beforeHash: before === null ? null : (typeof raw.beforeHash === 'string' ? raw.beforeHash : sha256(before)),
    after,
    afterHash: after === null ? null : (typeof raw.afterHash === 'string' ? raw.afterHash : sha256(after)),
    time,
    state,
    // 按需展开，保持与既有字段一致的 exactOptionalPropertyTypes 风格
    ...(rootCallId !== undefined ? { rootCallId } : {}),
    ...(revertReason !== undefined ? { revertReason } : {}),
    ...(cascadeOf !== undefined ? { cascadeOf } : {}),
  }
}

/** Parse and normalize every line; malformed lines are skipped (not fatal). */
export async function loadSnapshots(scope: StoreScope): Promise<FileUndoSnapshot[]> {
  let text: string
  try {
    text = await readFile(snapshotPath(scope), 'utf8')
  } catch {
    return []
  }
  const out: FileUndoSnapshot[] = []
  let index = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line) as RawSnapshot
      const snap = normalize(parsed, index)
      if (snap !== undefined) out.push(snap)
    } catch {
      // corrupt line: keep going, history is best-effort durable
    }
    index += 1
  }
  return out
}

/** Rewrite the whole store behind the write lock (atomic tmp+rename). */
async function saveAllLocked(scope: StoreScope, all: FileUndoSnapshot[]): Promise<void> {
  await ensureDir(scope)
  await writeFile(stagingPath(scope), all.map(s => `${JSON.stringify(s)}\n`).join(''), 'utf8')
  await rename(stagingPath(scope), snapshotPath(scope))
}

/** Append one snapshot (append-only: safe under concurrent tool calls). */
export async function appendSnapshot(scope: StoreScope, snapshot: FileUndoSnapshot): Promise<void> {
  await ensureDir(scope)
  await appendFile(snapshotPath(scope), `${JSON.stringify(snapshot)}\n`, 'utf8')
}

/** Rewrite the store under the lock with the caller's full list. */
export function rewriteStore(scope: StoreScope, all: FileUndoSnapshot[]): Promise<void> {
  return withLock(() => saveAllLocked(scope, all))
}

/**
 * Backfill the `after` state of one pending mutation once its tool settled.
 * Matches the oldest pending record for the same filePath (FIFO), updates it
 * in place through the write lock. Never throws.
 */
/**
 * Backfill one snapshot's after-state. Pairing strategy:
 * - `callId` present → EXACT match on the call identity. A failed sibling
 *   call (pre captured, post never backfills it) can no longer steal the
 *   pairing — the FIFO heuristic below mis-aligned every entry after any
 *   failed call (TROUBLESHOOTING P13).
 * - `callId` absent → legacy FIFO (oldest un-backfilled row for the path),
 *   kept only for pre-v0.3.4 rows/paths without a call id.
 */
export async function backfillAfter(
  scope: StoreScope,
  filePath: string,
  after: string | null,
  callId?: string,
  rootCallId?: string,
): Promise<void> {
  try {
    await withLock(async () => {
      const all = await loadSnapshots(scope)
      let target: FileUndoSnapshot | undefined
      if (callId !== undefined && callId !== '') {
        target = all.find(s => s.callId === callId)
      } else {
        // Legacy heuristic: oldest not-yet-backfilled entry for this path.
        target = all.find(s => s.filePath === filePath && s.after === null && s.afterHash === null)
      }
      if (target === undefined) return
      // 1.3（v7.1）：rootCallId 的保底落盘点在 backfill —— post-execute 的
      // ToolExecution.rootCallId 必填。补写必须放在 noop 分支（提前 return）之前；
      // target 匹配不到（legacy FIFO 退化）时允许缺失，绝不阻断 backfill。
      if (rootCallId !== undefined && rootCallId !== '' && target.rootCallId !== rootCallId) {
        target.rootCallId = rootCallId
      }
      if (after !== null && target.before !== null && target.before === after) {
        // The call succeeded but changed nothing (old === new content).
        // Keep the row as a no-change log entry — visible, never undoable.
        target.after = after
        target.afterHash = sha256(after)
        target.state = 'noop'
        target.failReason = '此次调用未产生实际改动（改后内容与改前完全一致）'
        await saveAllLocked(scope, all)
        return
      }
      if (after !== null || target.after === null) {
        target.after = after
        target.afterHash = after === null ? null : sha256(after)
        await saveAllLocked(scope, all)
      }
    })
  } catch (error) {
    console.error('[file-undo] backfill failed:', error)
  }
}

/**
 * Mark the pre snapshot of a FAILED tool call as aborted (post-execute saw
 * isError): the call never wrote anything, so the row carries no undo value.
 * Aborted rows stay in the file (no data loss) but every listing hides them.
 */
export async function markAbortedByCall(scope: StoreScope, callId: string, failReason?: string): Promise<void> {
  try {
    await withLock(async () => {
      const all = await loadSnapshots(scope)
      const target = all.find(s => s.callId === callId)
      if (target === undefined || target.state !== 'recorded' || target.after !== null) return
      target.state = 'aborted'
      target.failReason = failReason
      await saveAllLocked(scope, all)
    })
  } catch (error) {
    console.error('[file-undo] abort-mark failed:', error)
  }
}

/** Failed calls (post-execute isError): visible as failure-log rows, never undoable. */
export function isAbortedSnapshot(s: FileUndoSnapshot): boolean {
  return s.state === 'aborted'
}

/** Successful calls that changed nothing: visible as 无变化 log rows, never undoable. */
export function isNoopSnapshot(s: FileUndoSnapshot): boolean {
  return s.state === 'noop'
}

/** Set the lifecycle state of one snapshot under the lock. */
async function markState(scope: StoreScope, id: string, state: FileUndoSnapshot['state']): Promise<void> {
  await withLock(async () => {
    const all = await loadSnapshots(scope)
    const target = all.find(s => s.id === id)
    if (target === undefined) return
    target.state = state
    await saveAllLocked(scope, all)
  })
}

/** One entry of a batch revert: which snapshot, and why it stopped being valid. */
export interface RevertMark {
  id: string
  reason: 'direct' | 'cascade'
  /**
   * 级联来源（v0.3.11）：cascade 行必填 —— 写明本行是被哪条 target 的回退
   * 连带报废的（存 target.id）。reapply 该 target 时据此整批复活。
   */
  cascadeOf?: string
}

/**
 * Mark several snapshots reverted in ONE locked transaction, each with its own
 * `revertReason` (`direct` = the row the user targeted, `cascade` = collateral
 * rows invalidated by rewinding past them).
 *
 * Why one transaction (定稿 2.4): doing `cascade` and `direct` as two separate
 * lock acquisitions leaves a crash window that manufactures yet another
 * stale_ledger — the exact state this plugin exists to eliminate.
 *
 * Rows whose current `state` is not in `allowStates` are SKIPPED (a concurrent
 * operation moved them), so **the return value may be smaller than
 * `entries.length`**. Callers MUST compare the two (定稿 2.3): a partially
 * applied batch leaves rows that are `reverted` yet carry no `revertReason`,
 * which defeats the Reapply guard.
 *
 * @returns the number of rows actually marked.
 */
export async function markRevertedBatch(
  scope: StoreScope,
  entries: RevertMark[],
  opts: { allowStates?: FileUndoSnapshot['state'][] } = {},
): Promise<number> {
  if (entries.length === 0) return 0
  return withLock(async () => {
    const all = await loadSnapshots(scope)
    const byId = new Map(entries.map(e => [e.id, e]))
    const allow = new Set(opts.allowStates ?? ['recorded', 'reapplied'])
    let changed = 0
    for (const s of all) {
      const mark = byId.get(s.id)
      if (mark !== undefined && allow.has(s.state)) {
        s.state = 'reverted'
        s.revertReason = mark.reason
        // v0.3.11：连同级联来源落盘（reapply 上游时据此整批复活）。
        // 与 state/revertReason 同一事务写入 —— 分两次落盘会留下
        // "reverted 但无 cascadeOf" 的半标记行，复活时静默漏行。
        if (mark.cascadeOf !== undefined) s.cascadeOf = mark.cascadeOf
        changed += 1
      }
    }
    if (changed > 0) await saveAllLocked(scope, all)   // 单次 I/O
    return changed
  })
}

/**
 * Mark one snapshot reverted (state badge) under the lock.
 * 4.1 落地 1（v7.0）：改走批量版 —— 任何进入 `reverted` 的条目必带 `revertReason`
 * （不变式 I1），否则 Reapply 的白名单判据会把缺 reason 的行一律拒为
 * `unknown_revert`（fail-closed，这正是 I1 想堵的诈尸入口）。
 */
export async function markReverted(scope: StoreScope, id: string): Promise<void> {
  await markRevertedBatch(scope, [{ id, reason: 'direct' }])
}

/** Mark one snapshot reapplied (after an undo, the after-state was written back). */
export async function markReapplied(scope: StoreScope, id: string): Promise<void> {
  await markState(scope, id, 'reapplied')
}

/**
 * Mark several snapshots reapplied in ONE locked transaction（v0.3.11）。
 *
 * 服务于「重应用上游 → 连带复活被它 cascade 的行」：整批要么都复活、要么都不，
 * 与 markRevertedBatch 同款的单事务理由（定稿 2.4）—— 分次落盘留下半复活状态，
 * 正是这个插件要消灭的账本不一致。
 *
 * 复活时**清除** `revertReason` / `cascadeOf`：二者描述的是"上一次回退"这一
 * 历史事件，条目回到生效语义后不应再携带；残留会让下次回退的 reason 串味，
 * 也让 reapply 白名单读到过期的级联关系。
 *
 * @returns the number of rows actually marked（可能小于 ids.length —— 并发行
 * 已被移出 allowStates 的行会被跳过，调用方必须比对）。
 */
export async function markReappliedBatch(
  scope: StoreScope,
  ids: readonly string[],
  opts: { allowStates?: FileUndoSnapshot['state'][] } = {},
): Promise<number> {
  if (ids.length === 0) return 0
  return withLock(async () => {
    const all = await loadSnapshots(scope)
    const wanted = new Set(ids)
    const allow = new Set(opts.allowStates ?? ['reverted'])
    let changed = 0
    for (const s of all) {
      if (wanted.has(s.id) && allow.has(s.state)) {
        s.state = 'reapplied'
        delete s.revertReason
        delete s.cascadeOf
        changed += 1
      }
    }
    if (changed > 0) await saveAllLocked(scope, all)   // 单次 I/O
    return changed
  })
}

/**
 * Drop snapshots older than `days` and rewrite the store with the survivors.
 * This only shrinks undo history (how far back /undo can reach); it never
 * touches current file contents. Unknown-age rows (time < 0, legacy data)
 * are kept — conservative: unknown-age data is never deleted.
 */
export async function pruneSnapshots(scope: StoreScope, days: number): Promise<string> {
  const all = await loadSnapshots(scope)
  if (all.length === 0) return '没有可清理的记录（存储为空）'
  const cutoff = Date.now() - days * 86_400_000
  const kept = all.filter(s => typeof s.time !== 'number' || s.time < 0 || s.time >= cutoff)
  const removed = all.length - kept.length
  if (removed === 0) return `没有可清理的记录：全部 ${all.length} 条都在 ${days} 天内`
  await rewriteStore(scope, kept)
  return `已清理 ${removed} 条超过 ${days} 天的记录，保留 ${kept.length} 条`
}

// ── Snapshot stats (undo-orientation +N restored / -N removed) ───────────────

/**
 * Cache key: scope prefix + snapshot id (ids are only unique within one
 * store; two chats can mint the same `<time>-<seq>` id).
 */
const statsCache = new Map<string, { afterHash: string | null; added: number; removed: number }>()

function statsCacheKey(scope: StoreScope, id: string): string {
  return `${scope.workspaceKey}/${scope.chatKey}/${id}`
}

/**
 * +N/-N stats of one snapshot for list rows. Cached per id but keyed on
 * `afterHash`: a post-execute backfill changes the hash, so a stale entry
 * (computed while `after` was still null) self-invalidates — no cross-module
 * invalidation call can be forgotten.
 */
export function snapshotStats(scope: StoreScope, snapshot: FileUndoSnapshot): { added: number; removed: number } {
  const key = statsCacheKey(scope, snapshot.id)
  const cached = statsCache.get(key)
  if (cached !== undefined && cached.afterHash === snapshot.afterHash) {
    return { added: cached.added, removed: cached.removed }
  }
  let stats = { added: 0, removed: 0 }
  if (snapshot.before === null && snapshot.after !== null) {
    // Creation: "from nothing" — every line of the after-state is an addition
    // (git new-file semantics), not a zero-diff.
    stats = { added: countContentLines(snapshot.after), removed: 0 }
  } else if (snapshot.before !== null && snapshot.after !== null && snapshot.before !== snapshot.after) {
    // 定稿 6.1：hunk 缓存真正接入 —— 列表行的 stats 与 detail 的 hunks 复用同一批结果
    stats = diffStats(cachedStructuredDiff(snapshot.after, snapshot.before))
  }
  statsCache.set(key, { afterHash: snapshot.afterHash, added: stats.added, removed: stats.removed })
  return stats
}

/** Count content lines the way diff would (trailing newline is not a line). */
function countContentLines(content: string): number {
  if (content === '') return 0
  return content.replace(/\n$/, '').split('\n').length
}
