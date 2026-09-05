/**
 * The undo review panel — review / two-phase rewind / diff in one surface,
 * directly modeled on the reference interaction analysis:
 * - opening an entry auto-runs the read-only precheck (`detail` returns the
 *   diff AND the safety classification);
 * - the undo button is two-phase: first click arms a "confirm?" state, the
 *   second click commits `apply` with the preview's `currentHash` as the
 *   optimistic-concurrency token — a drift since preview refuses the write;
 * - reason codes map to precise copy lines (never free text);
 * - undone entries stay in history with a badge (recorded → reverted).
 */
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent as ReactChangeEvent, MouseEvent as ReactMouseEvent } from 'react'
import { api, ApiFailure, type ContextResult, type DetailResult, type HistoryItem, type RewindPreview, type SessionOption, type SessionsResult, type UndoReason } from './api'
import { DiffView } from './DiffView'
import { getFollowedSessionId, subscribeFollowed } from './follow'

const REASON_COPY: Record<UndoReason['code'], string> = {
  file_creation: '这是文件创建操作 — 撤销将删除该文件（内容未捕获时不允许安全删除）',
  no_before: '旧版快照未记录改前内容 — 没有可恢复的目标，无法撤销',
  already_reverted: '此操作已经撤销过了',
  file_missing: '文件已不存在于磁盘',
  file_read_failed: '当前文件读取失败',
  external_modified: '快照之后文件又被修改（外部编辑或后续写入），撤销会丢失这些改动 — 如确需强制，请在聊天中使用 /undo',
  superseded_by_later_ops: '此操作之后还有后续编辑，无法单独撤销本条 — 请使用「回退到此状态」连同后续步骤一起撤销',
  unknown_state: '该快照未捕获改后状态，且当前文件与改前内容不同；请仔细核对差异后再决定',
  // ── v0.3.9 RewindTo（定稿 2.1）—— 服务端抛出的 ApiFailure 命中这些码时，
  //    优先用服务端 message；这里是兜底文案。
  unsupported_checkpoint: '该快照未捕获改后状态，无法定位链条终点',
  creation_rewind_unsupported: '暂不支持级联撤销创建操作。请先逆序撤销其后的条目，再对本条使用单条撤销。',
  stale_ledger: '检测到已撤销但未标记，是否补记？',
  unsupported_operation: '仅编辑类快照支持账本补记，创建类请走单条撤销的幂等路径',
  unknown_revert: '此条目的撤销来源未知，为保证状态一致，拒绝重新应用。',
}

/** Accurate empty-state copy for the diff area, per precheck classification. */
function emptyDiffText(detail: DetailResult): string | undefined {
  if (detail.preview.currentExists === false) {
    return '当前文件不可读（可能已被移动或删除），无法计算差异'
  }
  const codes = detail.preview.reasons.map(r => r.code)
  if (codes.includes('no_before')) return '旧版快照未记录改前内容，无法显示恢复差异'
  if (codes.includes('file_creation')) return '创建类操作的改后内容未捕获 — 无内容可显示'
  return undefined
}

function basename(path: string): string {
  const norm = path.replace(/\\/g, '/')
  const at = norm.lastIndexOf('/')
  return at === -1 ? norm : norm.slice(at + 1)
}

function formatTime(time: number): string {
  if (time <= 0) return '?'
  const date = new Date(time)
  const now = new Date()
  const hhmmss = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
  const sameDay = date.toDateString() === now.toDateString()
  return sameDay ? hhmmss : `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${hhmmss}`
}

/** One file's operation history (entries newest-first), with churn totals. */
interface FileGroup {
  filePath: string
  entries: HistoryItem[]
  added: number
  removed: number
}

/**
 * Group the flat history by file. `items` arrives newest-first, so Map
 * insertion order = files ordered by their most recent activity, and each
 * group's entries keep newest-first too. Totals are per-entry churn summed
 * (an activity indicator, not a net diff — net would need first-before vs
 * last-after across undo/reapply round-trips, which would lie).
 */
function groupByFile(items: HistoryItem[]): FileGroup[] {
  const map = new Map<string, FileGroup>()
  for (const item of items) {
    let group = map.get(item.filePath)
    if (group === undefined) {
      group = { filePath: item.filePath, entries: [], added: 0, removed: 0 }
      map.set(item.filePath, group)
    }
    group.entries.push(item)
    group.added += item.added
    group.removed += item.removed
  }
  return [...map.values()]
}

/**
 * Same-basename files (D:\a\文档.txt vs D:\文档.txt) render identical group
 * names — storage/revert never collide (everything keys on the full resolved
 * path), but the LIST would. For every basename shared by 2+ groups, compute
 * the minimal trailing directory segments that disambiguates each path
 * (VS Code tab-style: `文档.txt · DSH-plug-in` vs `文档.txt · D:`), extending
 * upward until unique. Windows path compares are case-insensitive.
 */
function dirDisambiguators(groups: FileGroup[]): Map<string, string> {
  const byBase = new Map<string, string[]>()
  for (const g of groups) {
    const base = basename(g.filePath).toLowerCase()
    const list = byBase.get(base)
    if (list === undefined) byBase.set(base, [g.filePath])
    else list.push(g.filePath)
  }
  const out = new Map<string, string>()
  for (const paths of byBase.values()) {
    if (paths.length < 2) continue
    const dirsOf = (p: string): string[] =>
      p.replace(/\//g, '\\').split('\\').filter(s => s !== '').slice(0, -1)
    for (const p of paths) {
      const dirs = dirsOf(p)
      let depth = 1
      let suffix = ''
      while (depth <= dirs.length) {
        suffix = dirs.slice(-depth).join('\\')
        const mine = suffix.toLowerCase()
        const unique = paths.every(q => {
          if (q === p) return true
          const qs = dirsOf(q)
          return qs.slice(-depth).join('\\').toLowerCase() !== mine
        })
        if (unique) break
        depth++
      }
      out.set(p, suffix)
    }
  }
  return out
}

type ConfirmState = 'idle' | 'armed' | 'applying'

/**
 * Human label for one switcher entry: prefer the platform's title (what the
 * user actually recognises); fall back to `<cwd basename> · <short id>` when
 * the title seam is absent. The basename fallback is only useful when the cwd
 * is genuinely distinguishing — same-cwd siblings need the id to tell apart.
 */
function sessionLabel(option: SessionOption): string {
  const flags = [
    option.current ? '当前' : null,
    option.live ? '活跃' : '仅存档',
    option.hasRecords ? '有记录' : '无记录',
  ].filter((flag): flag is string => flag !== null)
  const title = typeof option.title === 'string' ? option.title.trim() : ''
  if (title !== '') return `${title}（${flags.join(' · ')}）`
  const segments = option.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(s => s !== '')
  const dir = segments.length > 0 ? segments[segments.length - 1] : option.cwd
  const short = option.id.replace(/^session-/, '').slice(0, 8)
  return `${dir} · ${short}（${flags.join(' · ')}）`
}

export function UndoPanel(props: { onClose: () => void }): React.ReactNode {
  const [items, setItems] = useState<HistoryItem[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [scopeInfo, setScopeInfo] = useState<ContextResult | null>(null)
  /**
   * 会话跟随（v0.4.0）：面板绑定的会话。`null` = 跟随 host 的最近活跃会话；
   * 非空 = 用户从切换器钉住的会话，此后**所有**请求都带上它，host 据此直接
   * 定位该会话的快照库，不再靠"最近做过文件操作"猜。
   */
  const [pinned, setPinned] = useState<string | null>(null)
  /**
   * 会话跟随（第二阶段，v0.5.0）：平台侧「当前查看的会话」（betterSidebar
   * 主源 / sessions.list 兜底，见 follow.ts）。钉住（pinned）优先级更高；
   * 两者都空时回到旧行为（host 最近活跃会话）。
   */
  const [followed, setFollowedState] = useState<string | null>(() => getFollowedSessionId())
  useEffect(() =>
    subscribeFollowed(() => {
      setFollowedState(getFollowedSessionId())
    }),
  [],
  )
  /** 每个请求实际携带的会话标识：钉住 > 平台跟随 > host 最近活跃。 */
  const sessionAt = pinned ?? followed ?? undefined
  /** 切换器目录；`available: false` 时 UI 隐藏切换器（缝缺席）。 */
  const [sessions, setSessions] = useState<SessionsResult | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<DetailResult | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [confirmState, setConfirmState] = useState<ConfirmState>('idle')
  const [applyMsg, setApplyMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  /** 5.2：RewindTo 的两阶段 —— 点击「回退到此状态」先 rewindPreview，确认后 rewindApply。 */
  const [rewindPlan, setRewindPlan] = useState<RewindPreview | null>(null)
  const [rewindBusy, setRewindBusy] = useState(false)
  /** 复制修复指令的瞬态反馈（复制成功 → 按钮短暂变「已复制」）。 */
  const [copiedLine, setCopiedLine] = useState<number | null>(null)
  const [pruneDays, setPruneDays] = useState('7')
  const [footMsg, setFootMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Mirror selectedId in a ref so refreshHistory can read the current selection
  // WITHOUT depending on it. Depending on selectedId made refreshHistory's
  // identity change on every click, which re-ran the initial-load effect and
  // reset the selection back to the first row (the "stuck on first entry" bug).
  const selectedIdRef = useRef<string | null>(null)
  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])
  // Monotonic ticket for in-flight detail requests (see loadDetail).
  const loadDetailSeq = useRef(0)

  // Collapsed-by-default file groups; the group holding the current selection
  // is always expanded so the selected op row stays visible.
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(new Set())
  const selectedFilePath = items?.find(i => i.id === selectedId)?.filePath ?? null
  useEffect(() => {
    if (selectedFilePath === null) return
    setExpandedFiles(prev => {
      if (prev.has(selectedFilePath)) return prev
      const next = new Set(prev)
      next.add(selectedFilePath)
      return next
    })
  }, [selectedFilePath])

  const refreshHistory = useCallback(async (keepSelection: boolean) => {
    const at = sessionAt
    try {
      const [fresh, context, directory] = await Promise.all([
        api.history(at),
        api.context(),
        // The switcher is enrichment: a failure here must never blank history.
        api.sessions(at).catch(() => null),
      ])
      const list = fresh.items
      setItems(list)
      setScopeInfo(context)
      setSessions(directory)
      setLoadError(null)
      if (!keepSelection) {
        const first = list.find(i => i.state === 'recorded') ?? list[0]
        setSelectedId(first !== undefined ? first.id : null)
      } else {
        const current = selectedIdRef.current
        if (current !== null && !list.some(i => i.id === current)) {
          setSelectedId(list[0]?.id ?? null)
        }
      }
    } catch (error) {
      setLoadError(error instanceof ApiFailure ? error.message : String(error))
    }
  }, [sessionAt])

  const loadDetail = useCallback(async (id: string) => {
    // Response guard: fast A→B clicks must never let a SLOW earlier response
    // overwrite the detail of the newer selection (stale-response race).
    const seq = ++loadDetailSeq.current
    setDetail(null)
    setDetailError(null)
    setConfirmState('idle')
    setApplyMsg(null)
    setRewindPlan(null)
    try {
      const result = await api.detail(id, sessionAt)
      if (seq !== loadDetailSeq.current) return
      setDetail(result)
    } catch (error) {
      if (seq !== loadDetailSeq.current) return
      setDetailError(error instanceof ApiFailure ? error.message : String(error))
    }
  }, [sessionAt])

  // Initial load + selection follow-up + 5s poll while the panel is open.
  useEffect(() => {
    void refreshHistory(false)
  }, [refreshHistory])
  useEffect(() => {
    if (selectedId === null) {
      setDetail(null)
      return
    }
    void loadDetail(selectedId)
  }, [selectedId, loadDetail])
  useEffect(() => {
    const timer = setInterval(() => void refreshHistory(true), 5_000)
    return () => clearInterval(timer)
  }, [refreshHistory])

  // Esc closes; auto-disarm the confirm state after 3s.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])
  useEffect(() => {
    if (confirmState !== 'armed') return
    confirmTimer.current = setTimeout(() => setConfirmState('idle'), 3_000)
    return () => {
      if (confirmTimer.current !== null) clearTimeout(confirmTimer.current)
    }
  }, [confirmState])

  const onUndoClick = useCallback(async () => {
    if (detail === null || selectedId === null) return
    if (confirmState === 'idle') {
      setConfirmState('armed')
      return
    }
    if (confirmState !== 'armed') return
    setConfirmState('applying')
    try {
      const result = await api.apply(selectedId, detail.preview.currentHash, sessionAt)
      setApplyMsg({
        kind: 'ok',
        text: result.deleted
          ? result.alreadyGone
            ? `文件已不存在，视为已撤销：${result.restored}（创建记录保留为日志）`
            : `已删除 ${result.restored}（撤销创建）——文件已从磁盘移除`
          : `已恢复 ${result.restored}（撤销 ${result.command}）——已写入磁盘；编辑器若未刷新请重新打开该文件`,
      })
      await loadDetail(selectedId)
      await refreshHistory(true)
    } catch (error) {
      const failure = error instanceof ApiFailure ? error : null
      setApplyMsg({
        kind: 'error',
        text: failure !== null && (failure.code === 'stale' || failure.code === 'external_modified' || failure.code === 'superseded_by_later_ops')
          ? '文件在预览后发生了变化，已为你刷新差异 — 请重新核对后再撤销'
          : `撤销失败：${failure !== null ? failure.message : String(error)}`,
      })
      if (failure !== null && (failure.code === 'stale' || failure.code === 'external_modified' || failure.code === 'superseded_by_later_ops')) {
        await loadDetail(selectedId)
        await refreshHistory(true)
      }
      setConfirmState('idle')
    }
    setConfirmState(prev => (prev === 'applying' ? 'idle' : prev))
  }, [detail, selectedId, confirmState, loadDetail, refreshHistory, sessionAt])

  /** Re-apply a reverted entry: write the after-state back (inverse of undo). */
  const onReapplyClick = useCallback(async () => {
    if (detail === null || selectedId === null) return
    if (confirmState === 'idle') {
      setConfirmState('armed')
      return
    }
    if (confirmState !== 'armed') return
    setConfirmState('applying')
    try {
      const result = await api.reapply(selectedId, detail.preview.currentHash, sessionAt)
      // v0.3.11：连带复活必须明说 —— 静默改写历史会让用户以为只动了一条。
      const revived = result.revived ?? 0
      const revivedText = revived > 0 ? `，并连带恢复被这次回退作废的 ${revived} 条后续操作` : ''
      setApplyMsg({
        kind: 'ok',
        text: result.ledgerSynced === false
          ? `已重新应用 ${result.reapplied}${revivedText}，但历史标记同步失败。请重新打开本条目，系统会提示补记。`
          : result.recreated
            ? `已重建 ${result.reapplied}（重新应用创建的内容）${revivedText}——文件已写回磁盘`
            : `已重新应用 ${result.reapplied}（恢复 ${result.command} 的结果）${revivedText}——已写入磁盘；编辑器若未刷新请重新打开该文件`,
      })
      await loadDetail(selectedId)
      await refreshHistory(true)
    } catch (error) {
      const failure = error instanceof ApiFailure ? error : null
      setApplyMsg({
        kind: 'error',
        text: failure !== null && failure.code === 'stale'
          ? '文件在预览后发生了变化，已为你刷新 — 请重新核对后再应用'
          : `重新应用失败：${failure !== null ? failure.message : String(error)}`,
      })
      if (failure !== null && failure.code === 'stale') {
        await loadDetail(selectedId)
        await refreshHistory(true)
      }
      setConfirmState('idle')
    }
    setConfirmState(prev => (prev === 'applying' ? 'idle' : prev))
  }, [detail, selectedId, confirmState, loadDetail, refreshHistory, sessionAt])

  /** 5.2 RewindTo 阶段 1：预检 —— 计算回退目标与连锁作废步数，弹出确认。 */
  const onRewindClick = useCallback(async () => {
    if (detail === null || selectedId === null || rewindBusy) return
    setRewindBusy(true)
    try {
      const plan = await api.rewindPreview(selectedId, sessionAt)
      setRewindPlan(plan)
      setApplyMsg(null)
    } catch (error) {
      const failure = error instanceof ApiFailure ? error : null
      setApplyMsg({ kind: 'error', text: `回退预检失败：${failure !== null ? failure.message : String(error)}` })
    } finally {
      setRewindBusy(false)
    }
  }, [detail, selectedId, rewindBusy, sessionAt])

  /** 5.2 阶段 2：确认后执行回退（单次原子写入 + 批量状态标记）。 */
  const onRewindConfirm = useCallback(async () => {
    if (detail === null || selectedId === null || rewindPlan === null || rewindPlan.status !== 'ok' || rewindBusy) return
    setRewindBusy(true)
    try {
      const result = await api.rewindApply(selectedId, rewindPlan.expectedCurrentHash!, sessionAt)
      setRewindPlan(null)
      setApplyMsg({
        kind: 'ok',
        text: result.ledgerSynced
          ? `已回退到 ${result.restored}（丢弃其后的 ${result.invalidated} 步）——已写入磁盘；编辑器若未刷新请重新打开该文件`
          : `已回退到 ${result.restored}，但历史标记同步失败。请重新打开本条目，系统会提示补记。`,
      })
      await loadDetail(selectedId)
      await refreshHistory(true)
    } catch (error) {
      const failure = error instanceof ApiFailure ? error : null
      if (failure !== null && failure.code === 'stale') {
        await loadDetail(selectedId)
        await refreshHistory(true)
      }
      setRewindPlan(null)
      setApplyMsg({ kind: 'error', text: `回退失败：${failure !== null ? failure.message : String(error)}` })
    } finally {
      setRewindBusy(false)
    }
  }, [detail, selectedId, rewindPlan, rewindBusy, loadDetail, refreshHistory, sessionAt])

  /** 账本滞后修复：确认是"已撤销但未标记"，只补记状态不写盘。 */
  const onStaleLedgerRepair = useCallback(async () => {
    if (selectedId === null || rewindBusy) return
    setRewindBusy(true)
    try {
      const { repaired } = await api.confirmStaleLedger(selectedId, sessionAt)
      setRewindPlan(null)
      setApplyMsg({ kind: 'ok', text: `已补记 ${repaired}（只改状态，未写盘）` })
      await loadDetail(selectedId)
      await refreshHistory(true)
    } catch (error) {
      const failure = error instanceof ApiFailure ? error : null
      setApplyMsg({ kind: 'error', text: `补记失败：${failure !== null ? failure.message : String(error)}` })
    } finally {
      setRewindBusy(false)
    }
  }, [selectedId, rewindBusy, loadDetail, refreshHistory, sessionAt])

  /** 5.1 复制修复指令：一条剪贴板文本，插件零写盘。 */
  const copyFixInstruction = useCallback(async (line: number) => {
    const text = `第 ${line} 行是被清空的内容行而非删除。请用 old_string 包含行尾换行符重新删除该行。`
    try {
      await navigator.clipboard.writeText(text)
      setCopiedLine(line)
      setTimeout(() => setCopiedLine(prev => (prev === line ? null : prev)), 2_000)
    } catch {
      setApplyMsg({ kind: 'error', text: `复制失败：${text}` })
    }
  }, [])

  const onPrune = useCallback(async () => {
    const days = Number(pruneDays)
    if (!Number.isFinite(days) || days <= 0) {
      setFootMsg({ kind: 'error', text: '天数需为正数' })
      return
    }
    try {
      const { message } = await api.prune(days, sessionAt)
      setFootMsg({ kind: 'ok', text: message })
      await refreshHistory(false)
    } catch (error) {
      setFootMsg({ kind: 'error', text: error instanceof ApiFailure ? error.message : String(error) })
    }
  }, [pruneDays, refreshHistory, sessionAt])

  const pendingCount = items?.filter(i => i.state === 'recorded').length ?? 0
  // 会话跟随：缝缺席（available=false）时切换器整行不渲染，行为与旧版一致。
  const sessionItems = sessions?.available === true ? sessions.items : []
  // A pinned session that dropped out of the directory stays selectable here so
  // the <select> never shows a value that is not among its options.
  const options =
    pinned !== null && !sessionItems.some(s => s.id === pinned)
      ? [...sessionItems, { id: pinned, cwd: '', current: false, live: false, hasRecords: false }]
      : sessionItems
  const selectValue = pinned ?? followed ?? sessions?.currentId ?? ''
  // 头部「当前会话」标识：面板实际正在服务的会话。切换器结果里的 currentId
  // 是 host 按请求声明核验后的权威值（v0.4.0 通道）；缝缺席时回落 host 的
  // 活跃 scope（此时也没有声明通道，两者一致）。
  const boundId =
    sessions?.available === true && sessions.currentId !== null
      ? sessions.currentId
      : scopeInfo?.scope?.chatKey ?? null
  // 5.1 空行痕迹黄牌：提为局部常量以便回调内窄化（TS 无法跨闭包收窄 detail 字段）
  const blankLine = detail?.blankLine

  return createElement(
    'div',
    {
      className: 'fu-overlay',
      onClick: (event: ReactMouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) props.onClose()
      },
    },
    createElement(
      'div',
      { className: 'fu-panel fu-root' },
      // ── header ──
      createElement(
        'div',
        { className: 'fu-head' },
        createElement('span', { className: 'fu-title' }, '文件撤销历史'),
        createElement(
          'span',
          { className: 'fu-count' },
          `${items?.length ?? 0} 条记录 · ${pendingCount} 条可撤销`,
          boundId !== null
            ? createElement(
                'span',
                { className: 'fu-scope', title: boundId },
                ` · 当前会话${pinned === null && followed !== null ? '（跟随）' : ''}`,
              )
            : null,
        ),
        createElement('span', { className: 'fu-spacer' }),
        createElement('button', {
          className: 'fu-iconbtn',
          title: '刷新',
          'aria-label': '刷新',
          onClick: () => void refreshHistory(true),
        }, '⟳'),
        createElement('button', {
          className: 'fu-iconbtn',
          title: '关闭 (Esc)',
          'aria-label': '关闭',
          onClick: props.onClose,
        }, '✕'),
      ),
      // ── 会话跟随（v0.4.0 显式切换 / v0.5.0 平台跟随）：同项目树下的会话切换器 ──
      // 未钉住时，面板自动跟随「用户当前正在查看的会话」（平台 client sessions
      // 服务推送）；钉住后所有请求固定作用于所选会话。
      sessions?.available === true
        ? createElement(
            'div',
            { className: 'fu-sessions' },
            createElement('label', { className: 'fu-sessions-label', htmlFor: 'fu-session-select' }, '会话'),
            createElement(
              'select',
              {
                id: 'fu-session-select',
                className: 'fu-select',
                value: selectValue,
                title: '同一项目树（当前目录及其父子目录）下的会话；未钉住时自动跟随当前查看的会话（平台推送），钉住后固定作用于所选会话',
                onChange: (event: ReactChangeEvent<HTMLSelectElement>) => {
                  const next = event.target.value
                  setPinned(next === '' ? null : next)
                  setSelectedId(null)
                  setDetail(null)
                  setApplyMsg(null)
                  setRewindPlan(null)
                },
              },
              options.map(option =>
                createElement('option', { key: option.id, value: option.id }, sessionLabel(option)),
              ),
            ),
            pinned !== null
              ? createElement(
                  'button',
                  {
                    className: 'fu-linkbtn',
                    title: '取消钉住，回到跟随当前查看的会话（平台推送）',
                    onClick: () => {
                      setPinned(null)
                      setSelectedId(null)
                    },
                  },
                  '跟随当前会话',
                )
              : null,
          )
        : null,
      // ── body ──
      createElement(
        'div',
        { className: 'fu-body' },
        createElement(
          'div',
          { className: 'fu-list' },
          items === null && createElement('div', { className: 'fu-empty' }, loadError ?? '加载中…'),
          items !== null && items.length === 0 && createElement('div', { className: 'fu-empty' }, '暂无文件操作记录\nwrite / edit 执行后会出现在这里'),
          items !== null && items.length > 0
            ? (() => {
                const groups = groupByFile(items)
                const dirSuffix = dirDisambiguators(groups)
                return groups.map(group => {
                const isOpen = expandedFiles.has(group.filePath)
                const latest = group.entries[0]
                const dirTag = dirSuffix.get(group.filePath)
                return createElement(
                  'div',
                  { key: group.filePath, className: 'fu-group' },
                  // ── file row: caret + name + op count + churn totals ──
                  createElement(
                    'div',
                    {
                      className: 'fu-group-head',
                      'data-open': isOpen ? 'true' : 'false',
                      title: group.filePath,
                      onClick: () => {
                        setExpandedFiles(prev => {
                          const next = new Set(prev)
                          if (next.has(group.filePath)) next.delete(group.filePath)
                          else next.add(group.filePath)
                          return next
                        })
                        setSelectedId(latest.id)
                      },
                    },
                    createElement('span', { className: 'fu-group-caret' }, isOpen ? '▾' : '▸'),
                    createElement('span', { className: 'fu-group-name' }, basename(group.filePath)),
                    dirTag !== undefined && dirTag !== ''
                      ? createElement('span', { className: 'fu-group-dir', title: group.filePath }, ` · ${dirTag}`)
                      : null,
                    createElement('span', { className: 'fu-group-count' }, `${group.entries.length} 次`),
                    createElement('span', { className: 'fu-group-spacer' }),
                    createElement(
                      'span',
                      { className: 'fu-group-stats' },
                      createElement('span', { className: 'fu-stat-add' }, `+${group.added}`),
                      createElement('span', { className: 'fu-stat-del' }, `-${group.removed}`),
                    ),
                  ),
                  // ── per-op rows under this file ──
                  isOpen
                    ? createElement(
                        'div',
                        { className: 'fu-group-items' },
                        group.entries.map(item =>
                          createElement(
                            'div',
                            {
                              key: item.id,
                              className: 'fu-row',
                              'data-selected': selectedId === item.id ? 'true' : 'false',
                              'data-state': item.state,
                              title: item.filePath,
                              onClick: () => setSelectedId(item.id),
                            },
                              createElement(
                                'div',
                                { className: 'fu-row-top' },
                                createElement('span', null, formatTime(item.time)),
                                createElement('span', { className: 'fu-row-cmd' }, item.op ?? item.command),
                                (() => {
                                  // 轮次徽章（v0.3.10）：直接显示 host 映射的权威
                                  // Turn 号；tooltip = 第几轮 / 第几步 / 本轮工具
                                  // 调用总数。turn 缺失（无缝/旧数据）→ 无徽章。
                                  if (item.turn === undefined) return null
                                  const ops = item.turnOps ?? '?'
                                  return createElement(
                                    'span',
                                    {
                                      className: 'fu-round',
                                      title: `第 ${item.turn} 轮 · 第 ${item.step ?? '?'} 步 · 本轮共 ${ops} 次工具调用`,
                                    },
                                    `轮${item.turn}`,
                                  )
                                })(),
                                item.state === 'reverted' ? createElement('span', { className: 'fu-row-undone' }, '已撤销') : null,
                                item.state === 'reapplied' ? createElement('span', { className: 'fu-row-reapplied' }, '已重应用') : null,
                                item.state === 'aborted' ? createElement('span', { className: 'fu-row-failed' }, '失败') : null,
                                item.state === 'noop' ? createElement('span', { className: 'fu-row-noop' }, '无变化') : null,
                              ),
                            item.created
                              ? createElement('div', { className: 'fu-row-stats' }, createElement('span', { className: 'fu-row-created' }, '新文件'))
                              : item.hasAfter
                                ? createElement(
                                    'div',
                                    { className: 'fu-row-stats' },
                                    createElement('span', { className: 'fu-stat-add' }, `+${item.added}`),
                                    createElement('span', { className: 'fu-stat-del' }, `-${item.removed}`),
                                  )
                                : createElement('div', { className: 'fu-row-stats' }, createElement('span', null, '（改后状态未捕获）')),
                          ),
                        ),
                      )
                    : null,
                )
                })
              })()
            : null,
        ),
        createElement(
          'div',
          { className: 'fu-review' },
          detailError !== null && createElement('div', { className: 'fu-empty' }, detailError),
          detailError === null && detail === null && createElement('div', { className: 'fu-empty' }, selectedId === null ? '选择左侧一条记录查看差异' : '加载差异…'),
          detail !== null &&
            createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } },
              // review header: path + actions
              createElement(
                'div',
                { className: 'fu-review-head' },
                createElement('span', { className: 'fu-path', title: detail.item.filePath }, detail.item.filePath),
                detail.item.state === 'aborted'
                  ? createElement('span', { className: 'fu-reverted-tag' }, '✕ 失败 · 未改动文件')
                  : detail.item.state === 'noop'
                  ? createElement('span', { className: 'fu-reverted-tag' }, '○ 无变化 · 未改动文件')
                  : detail.item.state === 'reverted'
                  ? detail.preview.canReapply
                    ? confirmState === 'armed'
                      ? createElement(
                          'div',
                          { style: { display: 'flex', gap: '6px' } },
                          createElement(
                          'button',
                          {
                            className: 'fu-reapply-btn',
                            'data-confirm': 'true',
                            onClick: () => void onReapplyClick(),
                            title: (detail.revivable ?? 0) > 0
                              ? `将连带恢复被这次回退作废的 ${detail.revivable} 条后续操作`
                              : '把这次操作的结果重新写回文件',
                          },
                          (detail.revivable ?? 0) > 0
                            ? `确认重新应用（连带恢复 ${detail.revivable} 条）？`
                            : '确认重新应用？',
                        ),
                          createElement('button', { className: 'fu-cancel-btn', onClick: () => setConfirmState('idle') }, '取消'),
                        )
                      : createElement(
                          'button',
                          {
                            className: 'fu-reapply-btn',
                            disabled: confirmState === 'applying',
                            title: '把这次操作的结果重新写回文件（撤销的逆操作）',
                            onClick: () => void onReapplyClick(),
                          },
                          confirmState === 'applying' ? '应用中…' : '重新应用',
                        )
                    : createElement('span', { className: 'fu-reverted-tag' }, '✓ 已撤销')
                  : confirmState === 'armed'
                      ? createElement(
                          'div',
                          { style: { display: 'flex', gap: '6px' } },
                          createElement('button', { className: 'fu-undo-btn', 'data-confirm': 'true', onClick: () => void onUndoClick() }, detail.item.created ? '确认删除？' : '确认撤销？'),
                          createElement('button', { className: 'fu-cancel-btn', onClick: () => setConfirmState('idle') }, '取消'),
                        )
                      : createElement(
                          'div',
                          { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
                          // v0.3.11 修复：重应用行此前在 canApply=false（如上方还有已复活的
                          // 后继编辑 → superseded 拦截单条撤销）时被本标签吞掉整个操作区，
                          // 「回退到此状态」随之消失 —— 而提示文案恰恰指向它，形成死循环。
                          // 引擎侧 reapplied 本就是合法回退目标（allowStates 含 reapplied），
                          // 标签降级为纯标识，按钮永远可达。
                          detail.item.state === 'reapplied'
                            ? createElement('span', { className: 'fu-reverted-tag' }, '↻ 已重新应用')
                            : null,
                          createElement(
                            'button',
                            {
                              className: 'fu-undo-btn',
                              disabled: !detail.preview.canApply || confirmState === 'applying',
                              title: detail.item.created
                                ? detail.preview.canApply ? '撤销创建 = 删除该文件（创建后未被修改才允许）' : '存在不能安全删除的原因（见下方提示）'
                                : detail.item.state === 'reapplied'
                                  ? detail.preview.canApply ? '撤销这次重新应用 — 把文件恢复到该次操作前的内容（可与重新应用来回切换）' : '存在不能安全撤销的原因（见下方提示）'
                                  : detail.preview.canApply ? '把文件恢复到这次操作之前的内容' : '存在不能安全撤销的原因（见下方提示）',
                              onClick: () => void onUndoClick(),
                            },
                            confirmState === 'applying' ? (detail.item.created ? '删除中…' : '撤销中…') : detail.item.created ? '删除该文件' : '撤销此操作',
                          ),
                          // 5.2 RewindTo 入口：编辑类条目可把文件整体回退到该次操作之前（丢弃后续编辑）
                          !detail.item.created
                            ? createElement(
                                'button',
                                {
                                  className: 'fu-rewind-btn',
                                  disabled: rewindBusy,
                                  title: '把文件恢复到这次操作之前的内容，并丢弃其后的所有编辑（后续记录保留为日志）',
                                  onClick: () => void onRewindClick(),
                                },
                                '回退到此状态',
                              )
                            : null,
                        ),
              ),
              // failed-call log line (aborted rows: the failure IS the content)
              detail.item.state === 'aborted'
                ? createElement(
                    'div',
                    { className: 'fu-reason', 'data-severity': 'error' },
                    createElement('span', { className: 'fu-reason-code' }, 'failed'),
                    createElement('span', null, `此操作失败，未改动任何文件${detail.item.failReason ? '：' + detail.item.failReason : ''}`),
                  )
                : null,
              // no-change log line (noop rows: succeeded but identical content)
              detail.item.state === 'noop'
                ? createElement(
                    'div',
                    { className: 'fu-reason' },
                    createElement('span', { className: 'fu-reason-code' }, 'no_change'),
                    createElement('span', null, '此调用成功执行但未产生实际改动（改后内容与改前完全一致），无需撤销'),
                  )
                : null,
              // two-phase / apply feedback
              applyMsg !== null
                ? createElement(
                    'div',
                    { className: 'fu-reason', 'data-severity': applyMsg.kind === 'error' ? 'error' : undefined },
                    applyMsg.text,
                  )
                : null,
              // precheck reasons (auto-run with detail)
              detail.preview.reasons.map((reason, i) =>
                createElement(
                  'div',
                  { key: `reason-${i}`, className: 'fu-reason', 'data-severity': reason.code === 'file_creation' || reason.code === 'already_reverted' ? 'error' : undefined },
                  createElement('span', { className: 'fu-reason-code' }, reason.code),
                  createElement('span', null, REASON_COPY[reason.code] ?? reason.message),
                ),
              ),
              // diff stats line — creations show "新增" (they have no restore side);
              // Δ chars = net size change, the honest number for long-line files
              createElement(
                'div',
                { style: { display: 'flex', gap: '10px', padding: '0 14px 6px', fontSize: '11px', flex: 'none' } },
                createElement('span', { className: 'fu-stat-add' }, detail.item.created ? `+${detail.added} 新增` : `+${detail.added} 恢复`),
                detail.item.created ? null : createElement('span', { className: 'fu-stat-del' }, `-${detail.removed} 移除`),
                detail.charDelta !== null
                  ? createElement(
                      'span',
                      {
                        style: { color: 'var(--dsw-alias-label-tertiary)' },
                        title: '行数 = 变更行；Δ字符 = 改后长度 − 改前长度（净体积变化，压缩 JSON 等长行文件看这个）',
                      },
                      `Δ${detail.charDelta >= 0 ? '+' : ''}${detail.charDelta} 字符`,
                    )
                  : null,
                detail.preview.externalModified ? createElement('span', { style: { color: 'var(--dsw-alias-state-warn-primary)' } }, '⚠ 文件已被外部修改') : null,
              ),
              // 5.2 RewindTo 两阶段：预检后在这里出确认框 / 账本滞后时出补记
              rewindPlan !== null && rewindPlan.status === 'stale_ledger'
                ? createElement(
                    'div',
                    { className: 'fu-reason', 'data-severity': 'error' },
                    createElement('span', { className: 'fu-reason-code' }, 'stale_ledger'),
                    createElement('span', null, rewindPlan.message),
                    createElement('button', { className: 'fu-repair-btn', onClick: () => void onStaleLedgerRepair(), disabled: rewindBusy }, '补记状态'),
                  )
                : rewindPlan !== null && rewindPlan.status === 'ok'
                  ? createElement(
                      'div',
                      { className: 'fu-rewind-confirm' },
                      createElement('span', null, `回退到此状态（之后的 ${rewindPlan.invalidatedCount} 步将作废，仅保留为日志，无法单独恢复）`),
                      createElement(
                        'div',
                        { style: { display: 'flex', gap: '6px', marginTop: '6px' } },
                        createElement('button', { className: 'fu-undo-btn', 'data-confirm': 'true', onClick: () => void onRewindConfirm(), disabled: rewindBusy }, '确认回退'),
                        createElement('button', { className: 'fu-cancel-btn', onClick: () => setRewindPlan(null) }, '取消'),
                      ),
                    )
                  : null,
              // 5.1 空行痕迹黄牌 + 复制修复指令（detail 实时算，不落盘）
              blankLine !== undefined
                ? createElement(
                    'div',
                    { className: 'fu-reason fu-blankline' },
                    createElement('span', { className: 'fu-reason-code' }, 'blank_line'),
                    createElement('span', null, `疑似留下空行：第 ${blankLine.line} 行由内容被清空（应删除整行而非清空内容）`),
                    createElement(
                      'button',
                      { className: 'fu-copyfix-btn', onClick: () => void copyFixInstruction(blankLine.line) },
                      copiedLine === blankLine.line ? '✓ 已复制' : '复制修复指令',
                    ),
                  )
                : null,
              // the diff itself
              createElement(DiffView, { hunks: detail.hunks, emptyText: emptyDiffText(detail) }),
            ),
        ),
      ),
      // ── footer ──
      createElement(
        'div',
        { className: 'fu-foot' },
        '清理',
        createElement('input', {
          className: 'fu-days',
          type: 'number',
          min: '1',
          value: pruneDays,
          onChange: event => setPruneDays(event.target.value),
        }),
        '天前的记录',
        createElement('button', { className: 'fu-prune-btn', onClick: () => void onPrune() }, '清理'),
        // Prune result sits right next to the button (visible feedback); the
        // permanent hint stays pinned to the far right.
        footMsg !== null
          ? createElement(
              'span',
              { className: 'fu-foot-msg', 'data-kind': footMsg.kind },
              `${footMsg.kind === 'ok' ? '✓ ' : '✗ '}${footMsg.text}`,
            )
          : null,
        createElement(
          'span',
          { className: 'fu-foot-hint' },
          '撤销 = 将文件恢复到该次操作之前；记录跨会话保存在 ~/.dsh/file-undo/',
        ),
      ),
    ),
  )
}
