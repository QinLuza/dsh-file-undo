/**
 * 会话跟随（第二阶段，v0.5.0）：client 半本地跟随「用户当前查看的会话」，
 * 面板所有请求把该会话 id 交给 host 走 v0.4.0 既有的核验定位通道——host 半
 * 零改动、不需要重启 DSH，浏览器强刷即生效。
 *
 * 数据源（2026-09-04 动态插件 follow-1 在真机页面实测：5 次切换、两源逐对
 * 一致、client→host RPC 全通）：
 * - 主源 `betterSidebar`（v0.12.0+ 文档化契约）：`getSnapshot().sessionId` +
 *   `subscribeState` —— 本机 v0.17.1 已装、互斥门未开、实测可用；
 * - 兜底 `ctx.sessions.list`（dsh-client-runtime 第一方标准 feed）：
 *   `list.current` 即 shell 当前选择的直接投影，`list.subscribe` 即切换
 *   事件 —— 运行时随 web profile 永远在。
 *
 * 合并规则：betterSidebar 的非空值优先（文档化契约为准）；它缺席 / 形态
 * 不符 / 返回空时回落 sessions.current；两源全缺席 → 不跟随（面板回到
 * 「最近活跃会话」旧行为，绝不更差）。
 *
 * 设计纪律（承 readTitleSnapshots 猜错结构的事故 + CodeBuddy 评审）：
 * - P9 结构化最小契约：只声明用到的成员，防御式探测；形态不符 → 该源静默
 *   缺席，绝不抛错、绝不让面板崩；
 * - 零依赖：不 import 任何模块（连 ./api 都不引），可作为独立构建产物
 *   （lib/follow.js）被 verify-follow.mjs 直接测试；
 * - 服务未就绪时经 timer 服务有限次重探（探测插件真机验证过的同款策略），
 *   重探耗尽仍缺席则静默不跟随；
 * - 读取抛错与「明确无会话」是两种语义：抛错保持最后已知值，绝不误清跟随态。
 */

/** `betterSidebar` 的结构化最小契约（P9：只声明用到的成员）。 */
export interface BetterSidebarServiceLike {
  getSnapshot?(): { sessionId?: unknown }
  subscribeState?(listener: () => void): () => void
}

/** `ctx.sessions.list` 的结构化最小契约。 */
export interface SessionsListStoreLike {
  getSnapshot?(): { current?: unknown }
  subscribe?(listener: () => void): () => void
}

/** client cordis 上下文的结构化最小契约（零依赖，测试可直接构造）。 */
export interface FollowContextLike {
  get?(name: string): unknown
  effect?(callback: () => (() => void) | void, label?: string): unknown
}

/** 当前跟随的会话 id（null = 无会话被查看 / 两源全缺席）。 */
let followedId: string | null = null
const listeners = new Set<() => void>()

/** 读取当前跟随的会话 id；面板所有请求把它作为缺省会话标识。 */
export function getFollowedSessionId(): string | null {
  return followedId
}

/** 订阅跟随会话变化；返回取消函数。 */
export function subscribeFollowed(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 测试钩子：重置模块级状态（验证脚本用，运行时不可达）。 */
export function resetFollowedForTest(): void {
  followedId = null
  bsState.available = false
  bsState.id = null
  seState.available = false
  seState.id = null
  for (const listener of Array.from(listeners)) {
    try {
      listener()
    } catch {
      // 监听器抛错不阻断重置。
    }
  }
  listeners.clear()
}

function setFollowed(id: string | null): void {
  if (id === followedId) return
  followedId = id
  for (const listener of Array.from(listeners)) {
    try {
      listener()
    } catch {
      // 一个监听器抛错不能阻断其余监听器。
    }
  }
}

interface SourceState {
  available: boolean
  /** 最近一次读取的会话 id；空串/未定义归一为 null。 */
  id: string | null
}

const bsState: SourceState = { available: false, id: null }
const seState: SourceState = { available: false, id: null }

function normalizeId(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** 合并两源：betterSidebar 非空值优先，空值回落 sessions，全缺席 → null。 */
function recompute(): void {
  let next: string | null = null
  if (bsState.available) {
    next = bsState.id !== null ? bsState.id : seState.id
  } else if (seState.available) {
    next = seState.id
  }
  setFollowed(next)
}

/**
 * 探测并订阅 betterSidebar 主源。就绪返回 true；缺席/形态不符/读快照抛错
 * 返回 false（保持「缺席」态，绝不半订阅）。
 */
function probeBetterSidebar(ctx: FollowContextLike, disposers: Array<() => void>): boolean {
  if (bsState.available) return true
  let svc: BetterSidebarServiceLike | undefined
  try {
    svc = ctx.get?.('betterSidebar') as BetterSidebarServiceLike | undefined
  } catch {
    return false
  }
  if (svc === undefined || svc === null) return false
  const getSnapshot = svc.getSnapshot
  const subscribeState = svc.subscribeState
  if (typeof getSnapshot !== 'function' || typeof subscribeState !== 'function') return false
  let initial: string | null = null
  try {
    const snap = getSnapshot()
    initial = snap !== null && typeof snap === 'object' ? normalizeId(snap.sessionId) : null
  } catch {
    return false
  }
  bsState.available = true
  bsState.id = initial
  let dispose: unknown
  try {
    dispose = subscribeState(() => {
      let next: string | null = null
      try {
        const snap = getSnapshot()
        next = snap !== null && typeof snap === 'object' ? normalizeId(snap.sessionId) : null
      } catch {
        return // 读取失败：保持最后已知值
      }
      bsState.id = next
      recompute()
    })
  } catch {
    // 订阅注册本身失败（区别于读取失败）：回滚到「缺席」态，绝不半订阅。
    bsState.available = false
    bsState.id = null
    return false
  }
  if (typeof dispose === 'function') disposers.push(dispose as () => void)
  return true
}

/** 探测并订阅 sessions.list 兜底源（同款防御纪律）。 */
function probeSessions(ctx: FollowContextLike, disposers: Array<() => void>): boolean {
  if (seState.available) return true
  let svc: { list?: SessionsListStoreLike } | undefined
  try {
    svc = ctx.get?.('sessions') as { list?: SessionsListStoreLike } | undefined
  } catch {
    return false
  }
  const list = svc === undefined || svc === null ? undefined : svc.list
  if (list === undefined || list === null) return false
  const getSnapshot = list.getSnapshot
  const subscribe = list.subscribe
  if (typeof getSnapshot !== 'function' || typeof subscribe !== 'function') return false
  let initial: string | null = null
  try {
    const snap = getSnapshot()
    initial = snap !== null && typeof snap === 'object' ? normalizeId(snap.current) : null
  } catch {
    return false
  }
  seState.available = true
  seState.id = initial
  let dispose: unknown
  try {
    dispose = subscribe(() => {
      let next: string | null = null
      try {
        const snap = getSnapshot()
        next = snap !== null && typeof snap === 'object' ? normalizeId(snap.current) : null
      } catch {
        return // 读取失败：保持最后已知值
      }
      seState.id = next
      recompute()
    })
  } catch {
    // 订阅注册本身失败（区别于读取失败）：回滚到「缺席」态，绝不半订阅。
    seState.available = false
    seState.id = null
    return false
  }
  if (typeof dispose === 'function') disposers.push(dispose as () => void)
  return true
}

/** 未就绪源的重探上限（1.5s × 8 ≈ 12s；动态插件真机实测的同款预算）。 */
const MAX_REPROBE_TRIES = 8
const REPROBE_INTERVAL_MS = 1_500

/**
 * 安装跟随：即探即订，未就绪的源经 timer 服务有限次重探。全部缺席 → 静默
 * 不跟随；插件卸载（HMR / 停用）时经 ctx.effect 统一退订。
 */
export function startFollowing(ctx: FollowContextLike): void {
  const disposers: Array<() => void> = []
  const bsOk = probeBetterSidebar(ctx, disposers)
  const seOk = probeSessions(ctx, disposers)
  recompute()

  if (!(bsOk && seOk) && typeof ctx.effect === 'function') {
    const timer = (() => {
      try {
        return ctx.get?.('timer') as { interval?: (cb: () => void, ms: number) => (() => void) | void } | undefined
      } catch {
        return undefined
      }
    })()
    if (timer !== undefined && timer !== null && typeof timer.interval === 'function') {
      const interval = timer.interval
      let tries = 0
      let stop: (() => void) | undefined
      const tick = (): void => {
        tries += 1
        const bsNow = bsOk || probeBetterSidebar(ctx, disposers)
        const seNow = seOk || probeSessions(ctx, disposers)
        recompute()
        if ((bsNow && seNow) || tries >= MAX_REPROBE_TRIES) {
          try {
            stop?.()
          } catch {
            // 停止失败无副作用。
          }
        }
      }
      const maybeStop = interval(tick, REPROBE_INTERVAL_MS)
      stop = typeof maybeStop === 'function' ? maybeStop : undefined
      if (stop !== undefined) disposers.push(stop)
    }
  }

  if (disposers.length > 0 && typeof ctx.effect === 'function') {
    ctx.effect(
      () => () => {
        const list = disposers.splice(0, disposers.length)
        for (const dispose of list) {
          try {
            dispose()
          } catch {
            // 退订失败无副作用。
          }
        }
      },
      'follow: source subscriptions',
    )
  }
}
