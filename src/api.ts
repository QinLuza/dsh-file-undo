/**
 * HTTP API for the visual undo history — the engine-side adjudicator.
 *
 * Modeled on the reference layering ("what to show" belongs to the renderer;
 * "whether and how files may move" is decided here):
 * - `detail` computes the review diff (after-ish current → before, so green
 *   lines are exactly what a restore brings back) AND runs the read-only
 *   safety precheck in one shot — the dialog auto-previews on open.
 * - `apply` is a two-phase commit with optimistic concurrency: the caller
 *   passes the `expectedCurrentHash` it saw during preview; a mismatch means
 *   the file moved underneath and the write is refused (`stale`).
 * - `reapply` closes the state machine: a reverted entry's `after` content
 *   is written back (reference's reverted → reapplied transition).
 * - Undo reasons are enumerated (never free text) so the UI can map each
 *   code to a precise line: file_creation, no_before, already_reverted,
 *   file_missing, file_read_failed, external_modified, unknown_state.
 *
 * Every method is scoped to the caller's active store (workspace × chat):
 * the host injects a `() => StoreScope | undefined` accessor, refreshed on
 * every mutating tool call and /undo invocation, so the browser panel reads
 * the store of the session that last did work.
 *
 * Routes live under POST /file-undo/api/<method> with the same Host-header
 * trust fence the platform's own plugin routes use (loopback or the
 * deployment's trusted authorities; cross-site fetch markers rejected).
 */
import type { Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
import { cachedStructuredDiff, diffStats, type DiffHunk } from './diff.js'
import {
  DEFAULT_PRUNE_DAYS,
  isAbortedSnapshot,
  loadSnapshots,
  markReappliedBatch,
  markReverted,
  markRevertedBatch,
  pruneSnapshots,
  selectWorkspaceMembers,
  sha256,
  snapshotPath,
  snapshotStats,
  workspaceKeyOf,
  type FileUndoSnapshot,
  type RevertMark,
  type StoreScope,
} from './store.js'

/** One enumerated undo-safety reason (UI maps each code to copy). */
export interface UndoReason {
  code:
    | 'file_creation'
    | 'no_before'
    | 'already_reverted'
    | 'file_missing'
    | 'file_read_failed'
    | 'external_modified'
    | 'superseded_by_later_ops'
    | 'unknown_state'
  message: string
}

/** Read-only precheck result (reference previewFileRewind shape, one file). */
export interface UndoPreview {
  canApply: boolean
  /**
   * Whether the reverted entry's after-state can be written back (re-apply).
   * True only for `reverted` entries whose `after` was captured.
   */
  canReapply: boolean
  /** When false, the file moved since the snapshot settled (hash mismatch). */
  externalModified: boolean
  /** sha256 of the live file right now; pass back as expectedCurrentHash. */
  currentHash: string | null
  currentExists: boolean
  reasons: UndoReason[]
  /**
   * 3.3（v7.0）：可修复的账本滞后。磁盘已处于撤销态但状态标记丢失，
   * 不是失效 —— 客户端可据此提示「补记」并调用 confirmStaleLedger。
   */
  status?: 'stale_ledger'
  /** Present when status is set；兜底文案。 */
  message?: string
}

/** List row (no heavy content). */
export interface HistoryItem {
  id: string
  time: number
  command: string
  /** Sub-command for multi-command tools (str_replace_editor), when present. */
  op?: string
  /** Why the call failed; present only on aborted (failed) rows. */
  failReason?: string
  filePath: string
  state: 'recorded' | 'reverted' | 'reapplied' | 'aborted' | 'noop'
  /** True when the op created the file (before === null). */
  created: boolean
  hasAfter: boolean
  added: number
  removed: number
  /**
   * 轮次聚合键（定稿 1.3）：一次模型请求的整个调用树共享同一值。
   * 缺失合法（legacy FIFO 退化、aborted 行永不 backfill）——UI 必须容忍。
   * 弃用说明（v0.3.10）：平台 rootCallId 是调用树根而非模型轮次，轮次展示
   * 改读下方 turn/step；字段仅为存量快照兼容保留，UI 不再使用。
   */
  rootCallId?: string
  /**
   * 模型轮次（v0.3.10）：来自平台 session log 的权威 `tool/call` 事件
   * （payload 携带 {turn, step, callId}），host 在 history 读取时按 callId
   * 映射，不落盘。缺失合法（sessionQuery 缝未挂载、旧快照无 callId、映射
   * 失败均退化为无徽章）——UI 必须容忍。
   */
  turn?: number
  /** 轮内步号：一次模型调用加上它请求的工具执行；与 turn 同源同生命周期。 */
  step?: number
  /** 该轮在 session log 中记录的工具调用总数（含非文件工具）。 */
  turnOps?: number
}

/** Full review payload for one snapshot. */
export interface DetailResult {
  item: HistoryItem
  /** Red/green hunks: old side = after ?? live file, new side = before. */
  hunks: DiffHunk[]
  added: number
  removed: number
  /**
   * Net size change in characters (after.length − before.length; vs empty
   * when one side is absent; null when neither side was captured). Lines
   * answer "how much content changed"; this answers "how much bigger/smaller
   * did the file get" — the number lines underreport on long-line files.
   */
  charDelta: number | null
  /**
   * 5.1（v7.0）：空行痕迹 —— 该操作把某一行由非空清空成空行（Agent 用不含换行的
   * old_string 替换所致），`line` 是 after 侧 1-based 行号。detail 阶段实时算，
   * 不落盘：对旧数据同样生效，且省掉 RawSnapshot→normalize 的数据兼容债。
   */
  blankLine?: { line: number }
  /**
   * v0.3.11：重应用本条将连带复活几条被它 cascade 掉的行（0 / 缺省 = 无连带）。
   * 仅当本条是 `reverted` 且 `revertReason === 'direct'` 时才为正 ——
   * 供确认文案告知用户"这次重应用不止恢复一条"，避免静默改写历史。
   */
  revivable?: number
  preview: UndoPreview
}

/** Context of the store the panel is currently serving. */
export interface ActiveScopeInfo {
  workspaceKey: string
  chatKey: string
}

/** One session offered by the switcher (会话跟随). */
export interface SessionOption {
  id: string
  cwd: string
  /** Best-available display name from the platform; absent when the title seam is unavailable or returns nothing. */
  title?: string
  /** True for the session the panel is currently bound to. */
  current: boolean
  /** Live in `ctx.sessions` (as opposed to persisted-only). */
  live: boolean
  /** Whether this session has recorded file operations in its own store. */
  hasRecords: boolean
}

/**
 * The switcher's payload. `available: false` means the `sessionQuery` seam is
 * absent (headless / no query backend): the panel then hides the switcher and
 * keeps serving whatever the host's last active scope is.
 */
export interface SessionsResult {
  available: boolean
  /** The bound session, or null when no session has produced work yet. */
  currentId: string | null
  items: SessionOption[]
}

/** ApiError carries an HTTP-ish code and a user-facing message. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

// ── Turn enrichment（v0.3.10）：轮次徽章的权威数据源 ─────────────────────────
//
// 平台 session log 的每个 `tool/call` 事件都携带 `{ turn, step, callId }`
// （docs/subsystems/session.md），callId 与工具钩子的 exec.callId 同源。
// host 在 history 读取时按 callId 把快照行映射回真实模型轮次——快照层零写盘、
// 零迁移；旧数据/无缝环境自然退化为无徽章（渐进增强）。
// P9 模式：结构化最小契约 + 防御式字段探测，不依赖平台具体类型。

/** Structural view of one raw session-log event (only the fields the mapping needs). */
interface SessionEventLike {
  seq?: unknown
  type?: unknown
  data?: { turn?: unknown; step?: unknown; callId?: unknown }
}

/** Minimal structural contract of the platform's `ctx.sessionQuery` seam (P9). */
export interface SessionQueryLike {
  /** Full replay-validated raw log (`readSession` → SessionLogSnapshot). */
  readSession?(sessionId: string): Promise<{ events?: readonly SessionEventLike[] } | undefined>
  /** Lightweight raw-log projection: `{ seq, type }` records in ascending order. */
  listEvents?(sessionId: string): Promise<readonly { seq?: unknown; type?: unknown }[] | undefined>
  /** One full event plus bounded context (`readEvent` → SessionEventWindow). */
  readEvent?(request: { sessionId: string; seq: number }): Promise<{ target?: SessionEventLike } | undefined>
  /**
   * Session directory for the switcher (会话跟随): which sessions exist and
   * where they live. Absent on hosts without a query backend — the switcher
   * then degrades to "current session only" (progressive enhancement, same
   * contract as the turn badges).
   */
  listSessions?(signal?: unknown): Promise<readonly SessionRecordLike[] | undefined>
  /**
   * Batch fetch of session titles (one round-trip for all members). Absent on
   * hosts without a title backend — the switcher then falls back to
   * `<cwd basename> · <short id>` for that id.
   */
  readTitleSnapshots?(sessionIds: readonly unknown[], signal?: unknown): Promise<readonly TitleObservationLike[] | undefined>
  /**
   * Single-shot title fetch (older backends / smaller surfaces). Called per-id
   * when `readTitleSnapshots` is unavailable. Absent = no titles at all.
   */
  readTitle?(sessionId: string, signal?: unknown): Promise<TitleSnapshotLike | undefined>
}

/**
 * Structural view of one `readTitleSnapshots` result (P9 contract).
 *
 * Shape verified against docs/subsystems/session-query.md (the generated
 * cordis surface): a batch read returns one ordered
 * `SessionTitleObservationResult` per requested id —
 * `{ sessionId, status: 'fulfilled', value: SessionTitleObservation }` or
 * `{ sessionId, status: 'rejected', reason }`, where
 * `SessionTitleObservation = { session: SessionHeader, title?: SessionTitleSnapshot }`
 * and the text itself is `SessionTitleSnapshot.title` (session-title.md).
 *
 * An earlier revision guessed `{ id, snapshot: { title } }` — that silently
 * dropped EVERY title, because the wrong shape yields undefined rather than an
 * error. Structural contracts must be checked against the docs, not assumed.
 */
interface TitleObservationLike {
  sessionId?: unknown
  status?: unknown
  value?: { title?: { title?: unknown } }
  reason?: unknown
}

/** Structural view of one `readTitle` result (`SessionTitleSnapshot`). */
interface TitleSnapshotLike {
  title?: unknown
}

/** Pull the title text out of one batch observation, or undefined. */
function titleFromObservation(result: TitleObservationLike | undefined): string | undefined {
  if (result === undefined) return undefined
  if (result.status !== 'fulfilled') return undefined   // 'rejected' carries `reason`, never a title
  const title = result.value?.title?.title
  return typeof title === 'string' && title !== '' ? title : undefined
}

/** Structural view of one `readTitleSnapshots` result (P9 contract). */
interface TitleObservationLike {
  id?: unknown
  snapshot?: { title?: unknown }
  error?: unknown
}

/** Structural view of one `SessionRecord` (only what the switcher needs). */
interface SessionRecordLike {
  header?: { id?: unknown; cwd?: unknown }
  live?: unknown
  persisted?: unknown
}

/** callId → turn/step mapping for one session, cached across history polls. */
interface TurnIndex {
  byCall: Map<string, { turn: number; step: number }>
  /** Turn number → total `tool/call` count in the log (badge tooltip). */
  perTurn: Map<number, number>
  /** Highest raw-log seq ingested; the incremental pass resumes above it. */
  throughSeq: number
}

/**
 * Cache keyed by session id. The raw log is append-only and `tool/call`
 * payloads never change, so an ingested mapping stays valid forever;
 * incremental polls cost one lightweight listEvents plus one small readEvent
 * per NEW call. Bounded in practice: one entry per session, one map entry
 * per tool call.
 */
const turnIndexes = new Map<string, TurnIndex>()

function ingestCallEvent(index: TurnIndex, event: SessionEventLike | undefined): void {
  const data = event?.data
  const turn = data?.turn
  const step = data?.step
  const callId = data?.callId
  if (typeof turn !== 'number' || typeof step !== 'number' || typeof callId !== 'string' || callId === '') return
  if (index.byCall.has(callId)) return
  index.byCall.set(callId, { turn, step })
  index.perTurn.set(turn, (index.perTurn.get(turn) ?? 0) + 1)
}

/**
 * Build or incrementally extend the callId→turn index for one session.
 * Returns undefined whenever the seam misbehaves — turn enrichment is
 * optional and must never fail history rendering.
 */
async function turnIndexFor(sq: SessionQueryLike, sessionId: string): Promise<TurnIndex | undefined> {
  try {
    let index = turnIndexes.get(sessionId)
    if (index === undefined) {
      const snapshot = await sq.readSession?.(sessionId)
      if (snapshot === undefined) return undefined
      index = { byCall: new Map(), perTurn: new Map(), throughSeq: 0 }
      for (const event of snapshot.events ?? []) {
        if (typeof event?.seq === 'number' && event.seq > index.throughSeq) index.throughSeq = event.seq
        if (event?.type === 'tool/call') ingestCallEvent(index, event)
      }
      turnIndexes.set(sessionId, index)
      return index
    }
    // Incremental: listEvents is the cheap projection; only NEW tool/call
    // seqs cost a full-event read.
    const records = await sq.listEvents?.(sessionId)
    if (records === undefined) return index
    const pending: number[] = []
    for (const record of records) {
      const seq = typeof record?.seq === 'number' ? record.seq : 0
      if (seq <= index.throughSeq) continue
      index.throughSeq = seq
      if (record?.type === 'tool/call') pending.push(seq)
    }
    for (const seq of pending) {
      const window = await sq.readEvent?.({ sessionId, seq })
      if (window?.target?.type === 'tool/call') ingestCallEvent(index, window.target)
    }
    return index
  } catch {
    return undefined
  }
}

/** Turn info resolved from the session log for one snapshot row. */
interface TurnInfo {
  turn: number
  step: number
  turnOps: number
}

function toHistoryItem(scope: StoreScope, snapshot: FileUndoSnapshot, turnInfo?: TurnInfo): HistoryItem {
  const stats = snapshotStats(scope, snapshot)
  return {
    id: snapshot.id,
    time: snapshot.time,
    command: snapshot.command,
    op: snapshot.op,
    filePath: snapshot.filePath,
    state: snapshot.state,
    failReason: snapshot.failReason,
    created: snapshot.before === null,
    hasAfter: snapshot.after !== null,
    added: stats.added,
    removed: stats.removed,
    ...(snapshot.rootCallId !== undefined ? { rootCallId: snapshot.rootCallId } : {}),
    ...(turnInfo !== undefined
      ? { turn: turnInfo.turn, step: turnInfo.step, turnOps: turnInfo.turnOps }
      : {}),
  }
}

/** Read the live file content through the official fs service. */
/**
 * Git-style new-file diff: every content line is an addition, single hunk
 * starting at line 1 of the (nonexistent) old side.
 */
function newFileHunks(after: string): DiffHunk[] {
  const lines = (after === '' ? [] : after.replace(/\n$/, '').split('\n')).map(line => `+${line}`)
  if (lines.length === 0) return []
  return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines }]
}

/**
 * 空行痕迹检测（定稿 5.1）：判据 = 行数不变、且某一行由非空变空。
 *
 * 覆盖的真实场景：Agent 用 `str_replace` 清空一段内容时，old_string 不含行尾换行
 * 符 → 匹配后剩下一个空行（内容行被"清空"而非"删除"）。撤销 diff 里它看起来只是
 * `-内容 / +空行`，行数没变 —— 人眼容易忽略，但反复清空会累积成认知失调。
 *
 * 行拆分与 diff.ts 的 splitLines 一致（尾部换行不产生幻影空行）——两处若不一致，
 * 行数判据会对带尾随换行的文件误报/漏报。返回 after 侧 1-based 行号。
 */
export function detectBlankLineArtifact(before: string | null, after: string | null): { line: number } | null {
  if (before === null || after === null) return null
  const b = contentLines(before)
  const a = contentLines(after)
  if (b.length !== a.length) return null
  for (let i = 0; i < a.length; i++) {
    if (b[i] !== '' && a[i] === '') return { line: i + 1 }
  }
  return null
}

/** 行拆分（与 diff.ts 同语义）：trailing newline 不算一行。 */
function contentLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Delete a file for a creation-undo. Prefers an fs-service delete when a
 * backend ever grows one; the official fs has none (resolve/stat/read/
 * write only), so this falls back to node fs in the host process — the same
 * explicit-escape rationale as the danger-full-access write (P3). ENOENT is
 * success (idempotent undo of an already-removed creation).
 */
async function removeFile(ctx: Context, target: { targetKey: string }): Promise<void> {
  const fsAny = ctx.fs as { unlink?: (t: unknown) => Promise<unknown> }
  if (typeof fsAny.unlink === 'function') {
    await fsAny.unlink(target)
    return
  }
  const { unlink } = await import('node:fs/promises')
  try {
    await unlink(String(target.targetKey))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function readCurrent(ctx: Context, filePath: string): Promise<string | null> {
  try {
    const target = await ctx.fs.resolve(filePath)
    return await ctx.fs.readText(target)
  } catch {
    return null
  }
}

// ── RewindTo：级联回退（定稿 第二章） ──────────────────────────────────────────

/** Read-only rewind plan. `stale_ledger` is a state to repair, not a failure. */
export interface RewindPreview {
  status: 'ok' | 'stale_ledger'
  /** Present on every non-ok status. */
  message?: string
  filePath: string
  id: string
  /** How many later operations this rewind would invalidate. */
  invalidatedCount: number
  /** `ok` only — the exact content the rewind would write back. */
  contentToWrite?: string
  /** `ok` only — target first, then the collateral rows in chain order. */
  idsToMark?: string[]
  /** `ok` only — optimistic-concurrency token to hand back to `rewindApply`. */
  expectedCurrentHash?: string
}

/** A chain member whose after-state is known (creation rows are filtered out). */
type ChainEntry = FileUndoSnapshot & { after: string }

interface RewindChain {
  /** 2.1-filtered members — these get marked `cascade`. */
  validChain: ChainEntry[]
  /** Every later row on the same file, INCLUDING the skipped ones (mesh check needs them). */
  entriesAfter: FileUndoSnapshot[]
}

/**
 * 2.1 blocking conditions — all six carry an error code, because the client's
 * `UndoReason` union is closed and has nothing to map an unnamed rejection to.
 *
 * Declared as a type assertion so callers get `before`/`after` narrowed to
 * `string` afterwards (both are `string | null` on the row type).
 */
function assertRewindTarget(target: FileUndoSnapshot): asserts target is FileUndoSnapshot & { before: string; after: string } {
  if (target.state === 'aborted') {
    throw new ApiError('aborted_op', '该操作失败且从未改动文件，无法回退。')
  }
  if (target.state === 'noop') {
    throw new ApiError('noop_op', '该操作未产生实际改动，无法回退。')
  }
  if (target.state === 'reverted') {
    throw new ApiError('already_reverted', '该操作已撤销过。')
  }
  if (target.before === null) {
    // 不能提示"请用单条撤销"——作为旧条目，单条撤销同样会被 external_modified 拦下。
    throw new ApiError(
      'creation_rewind_unsupported',
      '暂不支持级联撤销创建操作。请先逆序撤销其后的条目，再对本条使用单条撤销。',
    )
  }
  if (target.after === null) {
    // v7.0 必补：漏了这条，旧格式 target 会穿透到链末闸，报出撒谎的 external_modified。
    throw new ApiError('unsupported_checkpoint', '该快照未捕获改后状态，无法定位链条终点。')
  }
}

/**
 * 3.1（v7.1）：返回 `target` 之后、同一 filePath 的所有有效编辑条目。
 *
 * 按 append 顺序（数组索引）切片，而非 time 比较 —— `time` 是 Date.now()，
 * 同毫秒内多次操作 time 相等，`>` 会漏计（superseded 文案里的 N 就不准）。
 * JSONL append-only 保证数组顺序 = 真实写入顺序。
 *
 * 过滤掉 aborted（未落盘）/noop（未改动）/reverted（已被撤销、磁盘早已回退）
 * 三类无当前价值的条目——它们的"存在"不构成对撤销目标的阻碍。
 */
function findLaterOps(all: FileUndoSnapshot[], target: FileUndoSnapshot): FileUndoSnapshot[] {
  const idx = all.findIndex(s => s.id === target.id)
  if (idx === -1) return []
  return all
    .slice(idx + 1)
    .filter(s => s.filePath === target.filePath && !['aborted', 'noop', 'reverted'].includes(s.state))
}

/**
 * Build the chain after `target` (定稿 2.1).
 *
 * Returns BOTH shapes on purpose: the mesh check needs the unfiltered tail to
 * tell a legal discontinuity (our own undo moved the disk) from an illegal one
 * (someone edited the file between two snapshots).
 */
function buildRewindChain(all: FileUndoSnapshot[], target: FileUndoSnapshot): RewindChain {
  const idx = all.findIndex(s => s.id === target.id)
  if (idx === -1) throw new ApiError('snapshot_missing', `no snapshot with id "${target.id}"`, 404)
  const entriesAfter = all.slice(idx + 1).filter(s => s.filePath === target.filePath)
  const validChain: ChainEntry[] = []
  for (const s of entriesAfter) {
    if (s.state === 'aborted' || s.state === 'noop' || s.state === 'reverted') continue
    if (s.after === null) {
      throw new ApiError('unsupported_checkpoint', '链条中存在未捕获改后状态的旧条目。')
    }
    validChain.push({ ...s, after: s.after })
  }
  return { validChain, entriesAfter }
}

/**
 * 链条咬合校验（定稿 2.2.1）：相邻两段必须首尾相接（R_n.after === R_n+1.before）。
 *
 * 链末闸只断言链条终点，链条**中间**被外部修改过它完全看不见——回退于是静默吞掉
 * 那段外部改动，这是宪法 1 的最后一条绕过路径。
 *
 * 用 hash 比较而非全文比较：`beforeHash`/`afterHash` 都已落盘（缺失时 normalize 会补算），
 * 判据恒定可用且无需读文件，成本是 N 次定长字符串比较——便宜到 preview 与 apply 都跑得起。
 *
 * 三条实现纪律（写错就是大面积误报或漏报）：
 * 1. 豁免锚定「被跳过的条目」，不能写成「validChain 中相邻的前一条」——
 *    cascade 条目状态是 reverted、压根不在 validChain 里，后一种写法永不成立。
 * 2. 基准要"算"不要"跳"：重算后继续校验，才能覆盖「级联回退之后又遭外部修改」。
 * 3. 旧数据 `revertReason` 缺失走 `beforeHash` 分支（等同 direct）——v0.3.9 前没有 cascade。
 *
 * ⚠️ 对定稿伪码的修正：伪码写 `cascade → baseline = target.beforeHash`，其中 `target`
 * 是**当前**回退目标——但 tail 里的 cascade 行只能属于**更早的某次回退**（若属于当前回退，
 * 当前目标自己早已是 reverted、会被 2.1 拦下），所以 `target.beforeHash` 用错了对象。
 * 反例：R1→R2→R3→R4→R5，RewindTo(R3)（R3 direct，R4/R5 cascade，磁盘=v2），
 * 再追加 R6(before=v2)。此时 RewindTo(R2)：伪码会让 R6.before(v2) ≠ R2.before(v1) →
 * 误报 external_modified。正确基准是**本次回退的直接目标**（tail 里最近一个 direct
 * 的 beforeHash）：cascade 行从未上过磁盘，基准只在 direct 行处移动。
 */
function assertChainContinuity(target: FileUndoSnapshot, entriesAfter: FileUndoSnapshot[]): void {
  let baseline: string | null = target.afterHash
  // tail 里最近一个 direct 撤销行的 beforeHash —— cascade 行的正确基准。
  // 必然存在且先于其 cascade 行出现（cascade 行按时间序紧跟其 direct 目标）。
  let lastDirectBefore: string | null = null
  for (const s of entriesAfter) {
    // 没改过文件 → 基准不变，也不断链
    if (s.state === 'aborted' || s.state === 'noop') continue
    // 我们的撤销合法地移动了磁盘 → 合法断链 → 重算基准
    if (s.state === 'reverted') {
      if (s.revertReason === 'cascade') {
        // 被连带报废：磁盘从未经过它的 before/after，基准停在本次回退直接目标处
        if (lastDirectBefore !== null) baseline = lastDirectBefore
      } else {
        // direct（含旧数据 revertReason === undefined）—— 磁盘停在该行自己的 before
        baseline = s.beforeHash
        lastDirectBefore = s.beforeHash
      }
      continue
    }
    if (baseline !== null && s.beforeHash !== null && baseline !== s.beforeHash) {
      throw new ApiError('external_modified', '链条中间存在未被快照记录的外部改动，已阻断回退。', 409)
    }
    baseline = s.afterHash
  }
}

/**
 * Read-only precheck for a rewind to `target` (定稿 2.2). Never writes anything.
 * `all` is passed in so preview and apply share one load and one code path.
 */
async function previewRewindTo(
  ctx: Context,
  all: FileUndoSnapshot[],
  target: FileUndoSnapshot,
): Promise<RewindPreview> {
  assertRewindTarget(target)
  const { validChain, entriesAfter } = buildRewindChain(all, target)

  const currentFileContent = await readCurrent(ctx, target.filePath)
  const chainEnd =
    validChain.length > 0 ? validChain[validChain.length - 1].after : target.after

  if (currentFileContent !== chainEnd) {
    // 账本滞后：磁盘已是撤销态，只是标记丢了 —— 可修复的状态，不是"失效"
    if (currentFileContent === target.before && target.state === 'recorded') {
      return {
        status: 'stale_ledger',
        message: '检测到已撤销但未标记，是否补记？',
        filePath: target.filePath,
        id: target.id,
        invalidatedCount: validChain.length,
      }
    }
    throw new ApiError('external_modified', '链条外存在外部改动，快照已失效。', 409)
  }

  // 链末闸通过之后，再校验链条中间（定稿 2.2.1）
  assertChainContinuity(target, entriesAfter)

  return {
    status: 'ok',
    filePath: target.filePath,
    id: target.id,
    invalidatedCount: validChain.length,
    contentToWrite: target.before,
    idsToMark: [target.id, ...validChain.map(s => s.id)],
    expectedCurrentHash: sha256(currentFileContent),
  }
}

/** The read-only precheck over one snapshot (never writes anything). */
async function previewUndo(
  ctx: Context,
  all: FileUndoSnapshot[],
  snapshot: FileUndoSnapshot,
): Promise<UndoPreview> {
  const reasons: UndoReason[] = []
  if (snapshot.state === 'noop') {
    // A succeeded call that changed nothing: the panel shows the 无变化 tag
    // and the fixed copy; there is nothing to undo or re-apply.
    return { canApply: false, canReapply: false, externalModified: false, currentHash: null, currentExists: false, reasons }
  }
  if (snapshot.state === 'reverted') {
    reasons.push({ code: 'already_reverted', message: 'This operation was already undone.' })
    // The file after an undo equals the before-state, so it naturally
    // mismatches afterHash — that is the undo's own doing, not an external
    // edit. Reporting both reasons would be misleading; the re-apply path is
    // the only meaningful action, so stop the precheck here.
    return {
      canApply: false,
      canReapply: snapshot.after !== null,
      externalModified: false,
      currentHash: null,
      currentExists: false,
      reasons,
    }
  }
  if (snapshot.before === null) {
    // Two different meanings, deliberately split so the UI copy is precise:
    // - write / str_replace_editor create with a captured after-state → the
    //   op CREATED the file; undoing DELETES it (safe when the hash gate
    //   below shows the file is untouched since creation).
    // - creation with NO captured after-state, or legacy edit with no
    //   before-state → nothing to compare against; deleting content we never
    //   recorded could destroy unknown edits, so it stays refused.
    if (snapshot.command === 'write' || snapshot.op === 'create') {
      if (snapshot.after === null) {
        reasons.push({
          code: 'file_creation',
          message: 'Creation whose content was never captured — a delete cannot be verified as safe.',
        })
      }
    } else {
      reasons.push({
        code: 'no_before',
        message: 'Legacy snapshot without a recorded before-state; there is nothing to restore to.',
      })
    }
  }
  const current = await readCurrent(ctx, snapshot.filePath)
  if (current === null) {
    if (snapshot.before !== null) {
      reasons.push({ code: 'file_missing', message: 'The file no longer exists on disk.' })
    }
    // A creation whose file is already gone IS the undone state — idempotent
    // (the delete becomes a no-op record), no blocking reason.
    return { canApply: reasons.length === 0, canReapply: snapshot.before === null && snapshot.after !== null, externalModified: false, currentHash: null, currentExists: false, reasons }
  }
  const currentHash = sha256(current)
  // 3.3（v7.0）：hash 失配时先判「磁盘其实已是撤销态、只是标记丢了」——
  // 这是可修复的账本滞后（stale_ledger），不是失效。创建类已在上方幂等分支
  // 早退，这里用 beforeHash 判定即可顺带排除创建类（beforeHash === null）。
  if (
    snapshot.state === 'recorded' &&
    snapshot.beforeHash !== null &&
    currentHash === snapshot.beforeHash
  ) {
    return {
      canApply: false,
      canReapply: false,
      externalModified: false,
      currentHash,
      currentExists: true,
      reasons,
      status: 'stale_ledger',
      message: '检测到已撤销但未标记，是否补记？',
    }
  }
  let externalModified = false
  if (snapshot.afterHash !== null && snapshot.afterHash !== currentHash) {
    externalModified = true
    // 3.1（v7.1）语义拆分：hash 失配分两种——
    // 1) 文件之后还有「我们自己记录的编辑」（superseded）：提示继续会连带撤销 N 步。
    // 2) 无后续快照证据（真·外部修改）：快照失效。
    const laterOps = findLaterOps(all, snapshot)
    if (laterOps.length > 0) {
      reasons.push({
        code: 'superseded_by_later_ops',
        message: `此操作之后还有 ${laterOps.length} 次编辑，无法单独撤销本条。继续将连同这 ${laterOps.length} 步一起撤销。`,
      })
    } else {
      reasons.push({
        code: 'external_modified',
        message: 'The file changed after this operation (external edit or a later write). Undoing now would discard those changes.',
      })
    }
  } else if (snapshot.afterHash === null && snapshot.before !== null && snapshot.before !== current) {
    reasons.push({
      code: 'unknown_state',
      message: 'No after-state was captured for this snapshot; the file differs from the recorded before-state. Verify the diff before undoing.',
    })
  }
  return {
    canApply: reasons.length === 0,
    canReapply: false,
    externalModified,
    currentHash,
    currentExists: true,
    reasons,
  }
}

type Handler = (payload: Record<string, unknown>) => Promise<unknown>

/** Validate and return the `id` field of a request payload. */
function requireId(payload: Record<string, unknown>): string {
  const id = payload.id
  if (typeof id !== 'string' || id === '') throw new ApiError('bad-request', 'missing or invalid "id"')
  return id
}

/** Build the method table mounted under POST /file-undo/api/<method>. */
export function buildApi(
  ctx: Context,
  getScope: () => StoreScope | undefined,
  getSessionQuery?: () => SessionQueryLike | undefined,
): Record<string, Handler> {
  /** The active store scope, or an error the client can surface. */
  const requireScope = (): StoreScope => {
    const scope = getScope()
    if (scope === undefined) {
      throw new ApiError('no-active-scope', 'no session has produced file operations yet — run a write/edit first', 409)
    }
    return scope
  }

  // ── Session directory（会话跟随 v0.4.0）───────────────────────────────────
  //
  // The panel is a browser UI with no session of its own, so a request must
  // NAME the session it wants. `sessionId` is a CLIENT CLAIM: it is honoured
  // only when the sessionQuery seam can confirm the session exists, and the
  // cwd is read from the platform — never from the client — so a crafted
  // request cannot point at another session's snapshot store.
  //
  // State lives in this closure rather than at module level: tests build
  // several APIs against different mock seams and must not see each other.
  const MIN_DIRECTORY_AGE_MS = 2_000
  const dirById = new Map<string, { cwd: string; live: boolean; title?: string }>()
  let directoryAt = 0
  // One-time diagnostic: when the host exposes no title seam at all the
  // switcher silently renders `<cwd basename> · <short id>`, which looks like a
  // bug to users. Say it once in the host log so `/undo sessions` and the log
  // agree on WHY.
  let warnedNoTitleSeam = false

  const seamUsable = (): boolean => typeof getSessionQuery?.()?.listSessions === 'function'

  const refreshDirectory = async (): Promise<void> => {
    const list = await getSessionQuery?.()?.listSessions?.()
    if (list === undefined) return   // seam returned nothing: leave the previous state
    dirById.clear()
    for (const record of list) {
      const id = record?.header?.id
      const cwd = record?.header?.cwd
      if (typeof id === 'string' && id !== '' && typeof cwd === 'string' && cwd !== '') {
        dirById.set(id, { cwd, live: record?.live === true })
      }
    }
    // Batch-fetch titles in ONE round-trip so the panel renders by name
    // instead of `<cwd basename> · <short id>` — the latter is unusable when
    // many sessions share a cwd (the only thing distinguishing them becomes
    // an opaque uuid).
    //
    // Probe both surfaces: newer backends expose `readTitleSnapshots` (one
    // round-trip); older ones only `readTitle` (per-id). Either is enough —
    // we never assume one form, so a host upgrade or downgrade is invisible.
    const seam = getSessionQuery?.()
    const readTitlesBatch = typeof seam?.readTitleSnapshots === 'function'
      ? seam.readTitleSnapshots.bind(seam)
      : undefined
    const readTitleSingle = typeof seam?.readTitle === 'function'
      ? seam.readTitle.bind(seam)
      : undefined

    const ids = [...dirById.keys()]
    if (readTitlesBatch !== undefined) {
      try {
        const results = await readTitlesBatch(ids)
        if (results !== undefined) {
          for (const result of results) {
            const id = result?.sessionId
            const entry = typeof id === 'string' ? dirById.get(id) : undefined
            if (entry === undefined) continue
            const title = titleFromObservation(result)
            if (title !== undefined) entry.title = title
          }
        }
      } catch {
        // Title seam misbehaving: keep the directory, just skip the title enrichment.
      }
    } else if (readTitleSingle === undefined) {
      if (!warnedNoTitleSeam) {
        warnedNoTitleSeam = true
        console.warn('[file-undo] 会话切换器：当前 host 的 ctx.sessionQuery 未提供 readTitleSnapshots / readTitle，条目回退为「<目录名> · <短 id>」')
      }
    } else {
      // Older backend: one round-trip per id. Tolerable because the directory
      // is refreshed at most every 2s and the same set of titles is fetched
      // again — but a future change might cache them by mtime.
      await Promise.all(ids.map(async id => {
        try {
          const snapshot = await readTitleSingle(id)
          const title = snapshot?.title
          if (typeof title === 'string' && title !== '') {
            const entry = dirById.get(id)
            if (entry !== undefined) entry.title = title
          }
        } catch {
          // One id's title failed; the rest still proceed.
        }
      }))
    }
    directoryAt = Date.now()
  }

  /**
   * cwd of one session; refreshes the directory on a miss (rate-limited).
   * REJECTS when the seam itself is broken — the caller decides whether that
   * means "refuse the claim" or "degrade to the active scope".
   */
  const cwdOfSession = async (sessionId: string): Promise<string | undefined> => {
    const hit = dirById.get(sessionId)
    if (hit !== undefined) return hit.cwd
    if (Date.now() - directoryAt < MIN_DIRECTORY_AGE_MS) return undefined
    await refreshDirectory()
    return dirById.get(sessionId)?.cwd
  }

  /**
   * Scope for one request: an explicit, VERIFIED `sessionId` wins over the
   * host's active scope. When the seam cannot confirm the claim the request
   * falls back to the active scope — today's behaviour, never worse.
   */
  const scopeFor = async (payload: Record<string, unknown> | undefined): Promise<StoreScope> => {
    const requested = payload?.sessionId
    if (typeof requested === 'string' && requested !== '') {
      if (!seamUsable()) return requireScope()
      let cwd: string | undefined
      let seamFailed = false
      try {
        cwd = await cwdOfSession(requested)
      } catch {
        seamFailed = true
      }
      // A BROKEN seam (throws) can verify nothing: degrade to the active scope —
      // today's behaviour, never worse. A HEALTHY seam that does not know the
      // session is a different case: the claim is refused outright.
      if (seamFailed) return requireScope()
      if (cwd === undefined) {
        throw new ApiError('unknown-session', `session "${requested}" is not visible to this host`, 404)
      }
      return { workspaceKey: workspaceKeyOf(cwd), chatKey: requested }
    }
    return requireScope()
  }

  const findSnapshot = async (scope: StoreScope, payload: Record<string, unknown>): Promise<FileUndoSnapshot> => {
    const id = requireId(payload)
    const all = await loadSnapshots(scope)
    // Aborted rows ARE addressable (the panel shows their failure log); the
    // apply/reapply handlers refuse them.
    const snapshot = all.find(s => s.id === id)
    if (snapshot === undefined) throw new ApiError('snapshot_missing', `no snapshot with id "${id}"`, 404)
    return snapshot
  }

  /**
   * findSnapshot + the full list in one load: the 3.1 superseded split needs
   * `all` (later-ops evidence), so the handlers that run it must not load
   * the store twice.
   */
  const loadAndFind = async (scope: StoreScope, payload: Record<string, unknown>): Promise<{ all: FileUndoSnapshot[]; snapshot: FileUndoSnapshot }> => {
    const id = requireId(payload)
    const all = await loadSnapshots(scope)
    const snapshot = all.find(s => s.id === id)
    if (snapshot === undefined) throw new ApiError('snapshot_missing', `no snapshot with id "${id}"`, 404)
    return { all, snapshot }
  }

  /**
   * Session-log turn index for the active session. Undefined whenever the
   * seam is absent or misbehaves — enrichment only, never a failure.
   */
  const turnIndexOfScope = async (scope: StoreScope): Promise<TurnIndex | undefined> => {
    const sq = getSessionQuery?.()
    if (sq === undefined) return undefined
    return turnIndexFor(sq, scope.chatKey)
  }

  const turnInfoOf = (index: TurnIndex | undefined, snapshot: FileUndoSnapshot): TurnInfo | undefined => {
    if (index === undefined || snapshot.callId === undefined) return undefined
    const hit = index.byCall.get(snapshot.callId)
    if (hit === undefined) return undefined
    return { turn: hit.turn, step: hit.step, turnOps: index.perTurn.get(hit.turn) ?? 0 }
  }

  return {
    /** Which store the panel is bound to (workspace × chat). */
    context: async () => {
      const scope = getScope()
      return {
        active: scope !== undefined,
        scope: scope !== undefined ? { workspaceKey: scope.workspaceKey, chatKey: scope.chatKey } : null,
      }
    },

    /**
     * Switcher directory（会话跟随）：every session whose working directory
     * sits in the SAME project tree as the bound session — so work recorded
     * by a sibling/child session stops being invisible.
     *
     * Needs the sessionQuery seam; without it `available` is false and the UI
     * hides the switcher, leaving today's behaviour (serve the host's last
     * active scope) untouched.
     */
    sessions: async payload => {
      const current = getScope()
      if (!seamUsable()) {
        return { available: false, currentId: current?.chatKey ?? null, items: [] } satisfies SessionsResult
      }
      let scope: StoreScope
      try {
        scope = await scopeFor(payload)
      } catch {
        return { available: false, currentId: current?.chatKey ?? null, items: [] } satisfies SessionsResult
      }
      // The directory is fresh at this point (scopeFor resolved through it).
      const anchorCwd = await cwdOfSession(scope.chatKey).catch(() => undefined)
      if (anchorCwd === undefined) {
        return { available: false, currentId: scope.chatKey, items: [] } satisfies SessionsResult
      }
      // Grouping = strategy A (path containment, anchored on the bound
      // session). Strategy B (probe .git/package.json for the project root)
      // swaps in at `selectWorkspaceMembers` without touching this handler.
      const entries = [...dirById.entries()].map(([id, meta]) => ({ id, ...meta }))
      const members = new Set(await selectWorkspaceMembers(anchorCwd, entries.map(e => e.cwd)))
      const items: SessionOption[] = []
      for (const entry of entries) {
        if (!members.has(entry.cwd)) continue
        const option: SessionOption = {
          id: entry.id,
          cwd: entry.cwd,
          current: entry.id === scope.chatKey,
          live: entry.live,
          // A stat, not a parse: the switcher only needs to say "has history".
          hasRecords: existsSync(snapshotPath({ workspaceKey: workspaceKeyOf(entry.cwd), chatKey: entry.id })),
        }
        if (entry.title !== undefined) option.title = entry.title
        items.push(option)
      }
      return { available: true, currentId: scope.chatKey, items } satisfies SessionsResult
    },

    /** List the recorded history (newest first) with +/- stats. */
    history: async payload => {
      const scope = await scopeFor(payload)
      const all = await loadSnapshots(scope)
      // Turn badges come from the authoritative session log (callId →
      // {turn, step}); rows stay badge-less when the seam is unavailable.
      const index = await turnIndexOfScope(scope)
      // Aborted (failed) rows stay visible as failure-log entries: the panel
      // renders them with a 失败 badge and no undo action.
      return { items: all.map(s => toHistoryItem(scope, s, turnInfoOf(index, s))).reverse() }
    },

    /** Review payload for one snapshot: diff + auto-run precheck. */
    detail: async payload => {
      const scope = await scopeFor(payload)
      const { all, snapshot } = await loadAndFind(scope, payload)
      const preview = await previewUndo(ctx, all, snapshot)
      const current = preview.currentExists ? await readCurrent(ctx, snapshot.filePath) : null
      const oldSide = snapshot.after ?? current ?? ''
      const newSide = snapshot.before ?? ''
      // Creation (before === null, after captured): render the operation's
      // content as a git-style new-file diff — every line an addition — so
      // the panel shows WHAT was created instead of an empty "no changes".
      // after === null (legacy capture gap) stays hunks-empty with the
      // accurate reason line.
      const hunks =
        snapshot.before === null
          ? (snapshot.after !== null ? newFileHunks(snapshot.after) : [])
          : oldSide === newSide
            ? []
            : cachedStructuredDiff(oldSide, newSide)   // 6.1：detail 走 hunk 缓存
      const stats = diffStats(hunks)
      const charDelta =
        snapshot.before !== null && snapshot.after !== null
          ? snapshot.after.length - snapshot.before.length
          : snapshot.after !== null
            ? snapshot.after.length
            : snapshot.before !== null
              ? -snapshot.before.length
              : null
      // 5.1：空行痕迹在 detail 实时算（before 与 after/当前内容都可用时）。
      // 不落盘 —— 对旧数据同样生效，且不给 RawSnapshot/normalize 背数据兼容债。
      const blankLine =
        snapshot.before !== null && (snapshot.after ?? current) !== null
          ? detectBlankLineArtifact(snapshot.before, oldSide)
          : null
      // v0.3.11：本条重应用会连带复活几条（同文件、被本条 cascade 掉的行）。
      // 判据与 reapply 的复活集合逐字一致 —— 否则会"提示 N 条、实际复活 M 条"。
      const revivable =
        snapshot.state === 'reverted' && snapshot.revertReason === 'direct'
          ? all.filter(s => s.cascadeOf === snapshot.id && s.filePath === snapshot.filePath && s.after !== null).length
          : 0
      const result: DetailResult = {
        item: toHistoryItem(scope, snapshot, turnInfoOf(await turnIndexOfScope(scope), snapshot)),
        hunks,
        added: stats.added,
        removed: stats.removed,
        charDelta,
        ...(blankLine !== null ? { blankLine } : {}),
        ...(revivable > 0 ? { revivable } : {}),
        preview,
      }
      return result
    },

    /** Read-only precheck alone (used to re-validate right before apply). */
    preview: async payload => {
      const scope = await scopeFor(payload)
      const { all, snapshot } = await loadAndFind(scope, payload)
      return previewUndo(ctx, all, snapshot)
    },

    /**
     * Read-only rewind plan for one target (定稿 2.2): what the rewind would
     * write, how many later operations it would invalidate, and the
     * optimistic-concurrency token to hand back to `rewindApply`.
     *
     * `status: 'stale_ledger'` means the disk is ALREADY in the undone state
     * but the badge was lost — a state to repair (see `confirmStaleLedger`),
     * not a failure to report as `external_modified`.
     */
    rewindPreview: async payload => {
      const scope = await scopeFor(payload)
      const id = requireId(payload)
      const all = await loadSnapshots(scope)
      const target = all.find(s => s.id === id)
      if (target === undefined) throw new ApiError('snapshot_missing', `no snapshot with id "${id}"`, 404)
      return previewRewindTo(ctx, all, target)
    },

    /**
     * Rewind to a target in ONE atomic write, invalidating every later
     * operation on the file (定稿 2.3).
     *
     * Order matters: the optimistic lock runs BEFORE the chain is rebuilt, so
     * a file that moved since the preview reports `stale` (what the protocol
     * tests assert) instead of being re-classified by the chain-end gate.
     * The chain itself is re-derived server-side — never trusted from the
     * payload — so a tool that landed between preview and apply cannot slip
     * an entry past the mesh check.
     */
    rewindApply: async payload => {
      const scope = await scopeFor(payload)
      const id = requireId(payload)
      const all = await loadSnapshots(scope)
      const target = all.find(s => s.id === id)
      if (target === undefined) throw new ApiError('snapshot_missing', `no snapshot with id "${id}"`, 404)
      assertRewindTarget(target)

      // 1. 乐观锁 + Null 防御（宪法 2）—— 先跑，这样"预览后文件被改"报的是 stale
      const current = await readCurrent(ctx, target.filePath)
      if (current === null) {
        throw new ApiError('file_missing', '文件在预检后已被外部删除。', 404)   // 防 sha256(null)
      }
      const expected = payload.expectedCurrentHash
      if (typeof expected !== 'string') {
        throw new ApiError('bad-request', 'missing "expectedCurrentHash" — 回退必须先预览', 400)
      }
      if (sha256(current) !== expected) {
        throw new ApiError('stale', '文件在预检后已被修改，请重新预览。', 409)
      }

      // 2. 重建链条 + 咬合校验（preview→apply 之间链条成员可能已经变了）
      const { validChain, entriesAfter } = buildRewindChain(all, target)
      assertChainContinuity(target, entriesAfter)

      // 3. 单次原子写入（显式沙箱策略 —— 与现有 apply 同款，路由无会话上下文）
      const targetRef = await ctx.fs.resolve(target.filePath)
      const policy = ctx.sandboxPolicy.resolve({ mode: 'danger-full-access' })
      await ctx.fs.writeText(targetRef, target.before, undefined, undefined, policy)

      // 4. 批量状态更新 —— 单次事务写完 direct + cascade
      const marks: RevertMark[] = [
        { id: target.id, reason: 'direct' },
        // v0.3.11：连同级联来源落盘 —— reapply 本条时据此把整批 cascade 行
        // 一并复活，让「回退 → 重应用」恢复幂等（此前这些行会永久变砖头）。
        // 链成员在回退这一刻就已固定，reapply 时不再重推导（避免把回退后
        // 新增的行误纳入复活集合）。
        ...validChain.map(s => ({ id: s.id, reason: 'cascade' as const, cascadeOf: target.id })),
      ]
      let ledgerSynced = true
      try {
        const changed = await markRevertedBatch(scope, marks, { allowStates: ['recorded', 'reapplied'] })
        // 部分成功 = 静默半标记：漏标的那条既落了 reverted 又没有 revertReason，
        // Reapply 的白名单判据对它失效（诈尸）。必须让 UI 感知，绝不静默。
        if (changed !== marks.length) ledgerSynced = false
      } catch (error) {
        ledgerSynced = false
        console.warn('[DSH] 磁盘已回退但账本标记失败，进入 stale_ledger 态:', error)
      }

      return {
        restored: target.filePath,
        invalidated: validChain.length,
        ledgerSynced,
        warning: ledgerSynced ? undefined : '已回退，但历史标记同步失败。请重新打开本条目，系统会提示补记。',
      }
    },

    /**
     * Two-phase apply: optimistic-concurrency check (`expectedCurrentHash`
     * from the preview the user confirmed against) → transactional
     * full-text write-back → state badge update.
     */
    apply: async payload => {
      const scope = await scopeFor(payload)
      const { all, snapshot } = await loadAndFind(scope, payload)
      if (snapshot.state === 'aborted') {
        throw new ApiError('aborted_op', 'this operation failed and never changed the file — nothing to undo')
      }
      if (snapshot.state === 'noop') {
        throw new ApiError('noop_op', 'this operation did not change the file — nothing to undo')
      }
      if (snapshot.state === 'reverted') {
        throw new ApiError('already_reverted', 'this operation was already undone')
      }
      if (snapshot.before === null) {
        if (snapshot.after === null) {
          throw new ApiError('no_before', 'this creation snapshot has no captured content — deleting cannot be verified as safe')
        }
        // Undo a creation = delete the file it brought into existence. The
        // official fs seam has no delete, so this goes through node fs in the
        // host process — the same explicit-escape rationale as the
        // danger-full-access write below (P3): a two-phase, user-confirmed
        // action. The hash gate makes sure any post-creation edit refuses
        // the delete instead of being destroyed.
        const current = await readCurrent(ctx, snapshot.filePath)
        if (current !== null) {
          const currentHash = sha256(current)
          const expected = payload.expectedCurrentHash
          if (typeof expected === 'string' && expected !== currentHash) {
            throw new ApiError('stale', 'the file changed since the preview was loaded — reopen the entry and review the new diff', 409)
          }
          if (snapshot.afterHash !== null && snapshot.afterHash !== currentHash) {
            throw new ApiError('external_modified', 'the file changed after it was created — refusing to delete (the later edits would be lost)', 409)
          }
        }
        const target = await ctx.fs.resolve(snapshot.filePath)
        await removeFile(ctx, target)
        await markReverted(scope, snapshot.id)
        return { restored: snapshot.filePath, command: snapshot.command, deleted: true, alreadyGone: current === null }
      }
      const current = await readCurrent(ctx, snapshot.filePath)
      if (current === null) {
        throw new ApiError('file_missing', 'the file no longer exists on disk')
      }
      const currentHash = sha256(current)
      const expected = payload.expectedCurrentHash
      // Optimistic concurrency: when the client echoes the hash it saw in the
      // confirmed preview, any drift (external edit, later tool write) must
      // refuse the write instead of silently discarding those changes.
      if (typeof expected === 'string' && expected !== currentHash) {
        throw new ApiError(
          'stale',
          'the file changed since the preview was loaded — reopen the entry and review the new diff',
          409,
        )
      }
      // 3.1（v7.1）：与 previewUndo 同款的语义拆分 —— 后续存在我们记录的编辑
      // 是「被超越」（superseded），不是「外部修改」。preview 已在 UI 层阻断，
      // 此处是防御性兜底（客户端绕过 preview 直接 apply 时不误报）。
      if (snapshot.afterHash !== null && snapshot.afterHash !== currentHash) {
        const laterOps = findLaterOps(all, snapshot)
        if (laterOps.length > 0) {
          throw new ApiError(
            'superseded_by_later_ops',
            `此操作之后还有 ${laterOps.length} 次编辑，无法单独撤销本条。请使用「回退到此状态」连同后续步骤一起撤销。`,
            409,
          )
        }
        throw new ApiError(
          'external_modified',
          'the file changed after this operation (external edit or a later write); use /undo <index> in the chat if you really want to force it',
          409,
        )
      }
      const target = await ctx.fs.resolve(snapshot.filePath)
      // The API has no session context, so a bare resolve({}) falls back to the
      // host cwd (launch-root) as the workspace boundary and denies writes to
      // files outside it. Undo is a user two-phase-confirmed action, so bypass
      // confinement explicitly (danger-full-access) — matching the session
      // policy the original mutation ran under.
      const policy = ctx.sandboxPolicy.resolve({ mode: 'danger-full-access' })
      await ctx.fs.writeText(target, snapshot.before, undefined, undefined, policy)
      await markReverted(scope, snapshot.id)
      return { restored: snapshot.filePath, command: snapshot.command }
    },

    /**
     * Re-apply a reverted snapshot: write the `after` content back (the
     * inverse of apply). Only valid on reverted entries that captured an
     * after-state; the optimistic-concurrency token is the live file hash,
     * which after an undo equals the before-state's hash.
     */
    reapply: async payload => {
      const scope = await scopeFor(payload)
      const snapshot = await findSnapshot(scope, payload)
      if (snapshot.state === 'aborted') {
        throw new ApiError('aborted_op', 'this operation failed and never changed the file — nothing to re-apply')
      }
      if (snapshot.state === 'noop') {
        throw new ApiError('noop_op', 'this operation did not change the file — nothing to re-apply')
      }
      if (snapshot.state !== 'reverted') {
        throw new ApiError('not_reverted', 'only a reverted operation can be re-applied')
      }
      // 4.1 落地 2（v7.0）：Reapply 白名单判据（fail-closed）。revertReason 缺失 =
      // 撤销来源未知，拒绝 —— 4.1 落地 1/3 之后系统内不会再产生这种行，
      // 此分支是兜底（任何未经 markRevertedBatch 进入 reverted 的条目都被挡下）。
      if (snapshot.revertReason !== 'direct') {
        throw new ApiError(
          snapshot.revertReason === 'cascade' ? 'cascade_invalidated' : 'unknown_revert',
          snapshot.revertReason === 'cascade'
            ? '此条目因级联回退而失效，请改用「回退到此状态」恢复。'
            : '此条目的撤销来源未知，为保证状态一致，拒绝重新应用。',
          409,
        )
      }
      if (snapshot.after === null) {
        throw new ApiError('no_after', 'this snapshot has no recorded after-state to re-apply')
      }
      const current = await readCurrent(ctx, snapshot.filePath)
      // A deleted creation has NO file on disk — that is the expected
      // post-undo state, and re-applying re-creates the file from `after`.
      if (current === null && snapshot.before !== null) {
        throw new ApiError('file_missing', 'the file no longer exists on disk')
      }
      if (current !== null) {
        const currentHash = sha256(current)
        const expected = payload.expectedCurrentHash
        if (typeof expected === 'string' && expected !== currentHash) {
          throw new ApiError('stale', 'the file changed since the preview was loaded — reopen the entry and review the new diff', 409)
        }
        if (snapshot.before === null && snapshot.afterHash !== null && snapshot.afterHash !== currentHash) {
          throw new ApiError('external_modified', 'the file was re-created with different content after the undo — refusing to overwrite', 409)
        }
      }
      // v0.3.11：连带复活 —— 找出被本条回退 cascade 掉的行。
      // filePath 一致性是防御性过滤：rewindApply 的链条本就限定同一文件，
      // 万一账本被外部改动串了路径，也绝不把别的文件行纳入复活集合。
      const all = await loadSnapshots(scope)
      const cascadeRows = all
        .filter(s => s.cascadeOf === snapshot.id && s.filePath === snapshot.filePath && s.after !== null)
        .sort((a, b) => a.time - b.time)
      // 同一文件上彼此咬合的连续编辑 ⇒ 最终状态 = 最后一条 cascade 行的 after。
      // （咬合本身由 rewindApply 的 assertChainContinuity 在回退时已校验。）
      const tail = cascadeRows.length > 0 ? cascadeRows[cascadeRows.length - 1] : undefined
      const contentToWrite = tail !== undefined && tail.after !== null ? tail.after : snapshot.after
      const target = await ctx.fs.resolve(snapshot.filePath)
      const policy = ctx.sandboxPolicy.resolve({ mode: 'danger-full-access' })
      await ctx.fs.writeText(target, contentToWrite, undefined, undefined, policy)
      // 整批标记（单事务）：半复活会留下既非 reverted 又非 reapplied 的行，
      // 正是 I1 要堵的账本不一致 —— 必须让 UI 感知（定稿 2.3）。
      const ids = [snapshot.id, ...cascadeRows.map(s => s.id)]
      const changed = await markReappliedBatch(scope, ids)
      return {
        reapplied: snapshot.filePath,
        command: snapshot.command,
        recreated: snapshot.before === null && current === null,
        revived: cascadeRows.length,
        ledgerSynced: changed === ids.length,
      }
    },

    /**
     * 账本滞后补记（定稿 4.2）：磁盘已处于撤销态但状态标记丢失。
     * 只补标记，不写一个字节 —— 内容本就一致，写盘反而引入并发风险。
     * 只服务编辑类：创建类的幂等撤销路径（删除已删文件）已在 previewUndo
     * 处理，不会产生 stale_ledger；此处对创建类显式拒绝。
     */
    confirmStaleLedger: async payload => {
      const scope = await scopeFor(payload)
      const snapshot = await findSnapshot(scope, payload)
      if (snapshot.before === null) {
        throw new ApiError(
          'unsupported_operation',
          'creation snapshots are repaired through the idempotent single-undo path',
          409,
        )
      }
      const current = await readCurrent(ctx, snapshot.filePath)
      const undone =
        current !== null && snapshot.beforeHash !== null && sha256(current) === snapshot.beforeHash
      if (!undone) {
        throw new ApiError('not_undone', 'disk state does not match the undone state', 409)
      }
      // 2.3 同款条数校验：这里期望恰好 1 条（目标为 recorded/reapplied 才补记）。
      const changed = await markRevertedBatch(scope, [{ id: snapshot.id, reason: 'direct' }], {
        allowStates: ['recorded', 'reapplied'],
      })
      if (changed !== 1) {
        throw new ApiError('already_marked', 'snapshot already has a terminal state', 409)
      }
      return { repaired: snapshot.filePath }
    },

    /** Drop snapshots older than `days` (default 7). */
    prune: async payload => {
      const scope = await scopeFor(payload)
      let days = DEFAULT_PRUNE_DAYS
      if (payload.days !== undefined) {
        const parsed = Number(payload.days)
        if (!Number.isFinite(parsed) || parsed <= 0) throw new ApiError('bad-request', 'invalid "days"')
        days = parsed
      }
      return { message: await pruneSnapshots(scope, days) }
    },
  }
}

// ── HTTP plumbing (fence + body + envelope), platform-convention shaped ──────

/** Body size bound of one JSON request (defense against unbounded reads). */
const MAX_BODY_BYTES = 1 << 20

function header(headers: Record<string, unknown>, name: string): string | undefined {
  const value = headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') return value[0]
  return undefined
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

/**
 * Host-header trust fence (platform convention): the request must target a
 * loopback authority or one the deployment declared trusted, must not be
 * marked cross-site by fetch metadata, and its Origin (when present) must
 * match the Host hostname.
 */
export function isTrustedApiRequest(
  request: { headers: Record<string, unknown> },
  trustedAuthorities: readonly string[],
): boolean {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  const trusted = trustedAuthorities.some(entry => {
    try {
      const entryUrl = new URL(`http://${entry}`)
      return entryUrl.hostname === hostUrl.hostname && entryUrl.port === hostUrl.port
    } catch {
      return false
    }
  })
  if (!isLoopbackHostname(hostUrl.hostname) && !trusted) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/** Read and parse a bounded JSON request body ({ } when empty). */
export async function readJsonBody(req: AsyncIterable<unknown>): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Uint8Array)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new ApiError('bad-request', 'request body too large', 413)
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new ApiError('bad-request', 'request body is not valid JSON')
  }
}
