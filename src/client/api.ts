/**
 * Typed fetch client for the host half's JSON API (POST /file-undo/api/<method>).
 * Mirrors the wire shapes exported by src/api.ts on the host side; every call
 * either resolves to `value` or throws an ApiFailure with the enumerated code
 * the UI maps to copy.
 */

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
  created: boolean
  hasAfter: boolean
  added: number
  removed: number
  /** 轮次聚合键（定稿 1.3）：一次模型请求的整个调用树共享；缺失合法。 */
  rootCallId?: string
  /**
   * 模型轮次（v0.3.10）：平台 session log `tool/call` 事件的权威 turn，
   * host 按 callId 映射；缺失合法（缝未挂载/旧数据）——UI 容忍为无徽章。
   */
  turn?: number
  /** 轮内步号（一次模型调用及其工具执行）；与 turn 同源同生命周期。 */
  step?: number
  /** 该轮在 session log 中记录的工具调用总数（含非文件工具）。 */
  turnOps?: number
}

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
    // ── v0.3.9 RewindTo（定稿 2.1）—— 以抛出的 ApiFailure 形式出现，
    //    与上面的 reasons[] 共用同一张文案表，便于 UI 统一渲染。
    | 'unsupported_checkpoint'
    | 'creation_rewind_unsupported'
    | 'stale_ledger'
    | 'unsupported_operation'
    | 'unknown_revert'
  message: string
}

export interface UndoPreview {
  canApply: boolean
  canReapply: boolean
  externalModified: boolean
  currentHash: string | null
  currentExists: boolean
  reasons: UndoReason[]
  /** 3.3（v7.0）：可修复的账本滞后（磁盘已是撤销态、标记丢失）。 */
  status?: 'stale_ledger'
  /** Present when status is set；兜底文案。 */
  message?: string
}

export interface ActiveScopeInfo {
  workspaceKey: string
  chatKey: string
}

export interface ContextResult {
  active: boolean
  scope: ActiveScopeInfo | null
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export interface DetailResult {
  item: HistoryItem
  hunks: DiffHunk[]
  added: number
  removed: number
  /** Net size change in characters (after − before; vs empty if one side absent; null if neither). */
  charDelta: number | null
  /** 5.1：空行痕迹（行数不变 + 某行由非空变空），after 侧 1-based 行号。detail 实时算，不落盘。 */
  blankLine?: { line: number }
  /** v0.3.11：重应用本条将连带复活几条被它 cascade 掉的行（缺省或 0 = 无连带）。 */
  revivable?: number
  preview: UndoPreview
}

/** Read-only rewind plan (host `RewindPreview` 的客户端副本). */
export interface RewindPreview {
  status: 'ok' | 'stale_ledger'
  message?: string
  filePath: string
  id: string
  invalidatedCount: number
  contentToWrite?: string
  idsToMark?: string[]
  expectedCurrentHash?: string
}

/** Rewind outcome. `ledgerSynced === false` 时 UI 必须显示 `warning`。 */
export interface RewindResult {
  restored: string
  invalidated: number
  ledgerSynced: boolean
  warning?: string
}

/** One session offered by the switcher (mirror of the host's SessionOption). */
export interface SessionOption {
  id: string
  cwd: string
  /** Best-available display name from the platform; absent when the title seam is unavailable. */
  title?: string
  current: boolean
  live: boolean
  hasRecords: boolean
}

export interface SessionsResult {
  available: boolean
  currentId: string | null
  items: SessionOption[]
}

/** Apply / reapply outcome. `deleted`/`recreated` flag creation undos. */
export interface ApplyResult {
  restored?: string
  reapplied?: string
  command: string
  deleted?: boolean
  alreadyGone?: boolean
  recreated?: boolean
  /**
   * v0.3.11：本次重应用连带复活了几条被它 cascade 掉的行（仅 reapply）。
   * 缺省或 0 = 无连带（旧 host、或那次回退本就没有级联行）。
   */
  revived?: number
  /**
   * v0.3.11：账本标记是否整批同步成功（仅 reapply，语义同 RewindResult）。
   * false = 磁盘已写入但部分行状态标记失败 —— UI 必须提示，绝不静默
   * （定稿 2.3：半标记会让行停在既非 reverted 又非 reapplied 的中间态）。
   */
  ledgerSynced?: boolean
}

export class ApiFailure extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

async function call<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`/file-undo/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let envelope: { ok?: boolean; value?: T; error?: { code?: string; message?: string } }
  try {
    envelope = await response.json() as typeof envelope
  } catch {
    throw new ApiFailure('bad-response', `HTTP ${response.status}: 无法解析响应`)
  }
  if (envelope.ok === true && envelope.value !== undefined) return envelope.value
  const error = envelope.error
  throw new ApiFailure(error?.code ?? 'unknown', error?.message ?? `HTTP ${response.status}`)
}

/**
 * The pinned session id, when there is one. Every method carries it so the
 * host can serve THAT session's store instead of guessing from its own last
 * active scope (会话跟随 v0.4.0).
 */
const at = (sessionId?: string): Record<string, unknown> =>
  sessionId === undefined || sessionId === '' ? {} : { sessionId }

export const api = {
  context: () => call<ContextResult>('context'),
  history: (sessionId?: string) => call<{ items: HistoryItem[] }>('history', at(sessionId)),
  detail: (id: string, sessionId?: string) => call<DetailResult>('detail', { id, ...at(sessionId) }),
  apply: (id: string, expectedCurrentHash: string | null, sessionId?: string) =>
    call<ApplyResult>('apply', {
      id,
      ...(expectedCurrentHash !== null ? { expectedCurrentHash } : {}),
      ...at(sessionId),
    }),
  reapply: (id: string, expectedCurrentHash: string | null, sessionId?: string) =>
    call<ApplyResult>('reapply', {
      id,
      ...(expectedCurrentHash !== null ? { expectedCurrentHash } : {}),
      ...at(sessionId),
    }),
  /** 级联回退预检（定稿 2.2）：只读，不写盘。`stale_ledger` 是待修复状态而非失败。 */
  rewindPreview: (id: string, sessionId?: string) =>
    call<RewindPreview>('rewindPreview', { id, ...at(sessionId) }),
  /** 级联回退落盘（定稿 2.3）：单次原子写入 + 批量状态更新。hash 必须来自 preview。 */
  rewindApply: (id: string, expectedCurrentHash: string, sessionId?: string) =>
    call<RewindResult>('rewindApply', { id, expectedCurrentHash, ...at(sessionId) }),
  /** 账本滞后补记（定稿 4.2）：只补标记、零写盘；返回被补记的文件路径。 */
  confirmStaleLedger: (id: string, sessionId?: string) =>
    call<{ repaired: string }>('confirmStaleLedger', { id, ...at(sessionId) }),
  prune: (days: number, sessionId?: string) => call<{ message: string }>('prune', { days, ...at(sessionId) }),
  /** 会话切换器目录（会话跟随）：同项目树下的会话清单；缝缺席时 available=false。 */
  sessions: (sessionId?: string) => call<SessionsResult>('sessions', at(sessionId)),
}
