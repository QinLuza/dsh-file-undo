/**
 * Client half — the visual entry point (hdc-bridge pattern, zero
 * third-panel dependency: the official `sidebar.footer.action` slot declared
 * by client-ui-sidebar hosts our icon button; the review surface is a
 * portal modal on document.body, token-styled and idempotently injected).
 *
 * The button keeps a slow 60s poll of the pending count so its badge stays
 * fresh even while the panel is closed; opening the panel takes over with
 * a 5s poll and pushes updates into the same tiny store.
 *
 * 会话跟随（v0.5.0，纯 client 半）：apply() 同时安装平台跟随（follow.ts）——
 * 订阅 betterSidebar / sessions.list 两个数据源，把「当前查看的会话」供面板
 * 所有请求引用（host 走 v0.4.0 既有的逐请求核验通道）；用户在切换器里钉住
 * 的会话优先级更高。host 半零改动，浏览器强刷即生效。
 */
import { createElement, useEffect, useReducer, useState } from 'react'
import type { ClientContext, FooterSlotProps } from './types'
import { injectStyles } from './styles'
import { UndoPanel } from './UndoPanel'
import { api, type HistoryItem } from './api'
import { startFollowing, getFollowedSessionId } from './follow'

export const inject = ['slots']

/** Tiny module-level store: pending (recorded) count shared by badge + panel. */
let pendingCount = 0
const listeners = new Set<() => void>()

function publishCount(count: number): void {
  pendingCount = count
  for (const listener of listeners) listener()
}

function usePendingCount(): number {
  const [, force] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    listeners.add(force)
    return () => {
      listeners.delete(force)
    }
  }, [])
  return pendingCount
}

async function pollOnce(): Promise<void> {
  try {
    // 会话跟随（v0.5.0）：徽章计数当前查看会话的可撤销操作（未跟随时维持
    // 旧行为——host 最近活跃会话）。
    const { items } = await api.history(getFollowedSessionId() ?? undefined)
    publishCount(items.filter((item: HistoryItem) => item.state === 'recorded').length)
  } catch {
    // host half not serving (headless / restarted) — keep the last value
  }
}

function UndoIcon(): React.ReactNode {
  return createElement(
    'svg',
    { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
    createElement('path', {
      d: 'M3 7h6.5a3.5 3.5 0 1 1 0 7H6',
      stroke: 'currentColor',
      'stroke-width': '1.6',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
    createElement('path', {
      d: 'M5.5 4.5 3 7l2.5 2.5',
      stroke: 'currentColor',
      'stroke-width': '1.6',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
  )
}

function EntryButton(props: FooterSlotProps): React.ReactNode {
  const [open, setOpen] = useState(false)
  const count = usePendingCount()

  // Slow poll keeps the badge alive while the panel is closed; the panel's
  // own fast poll (and every apply) publishes through the same store.
  useEffect(() => {
    void pollOnce()
    const timer = setInterval(() => void pollOnce(), 60_000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (open) void pollOnce()
  }, [open])

  return createElement(
    'div',
    { className: 'fu-root' },
    createElement(
      'button',
      {
        className: 'fu-entry',
        'data-open': open ? 'true' : 'false',
        'aria-label': '文件撤销历史',
        'aria-expanded': open,
        title: '文件撤销历史',
        onClick: () => setOpen(prev => !prev),
      },
      createElement(UndoIcon),
      count > 0 ? createElement('span', { className: 'fu-entry-badge' }, count > 99 ? '99+' : String(count)) : null,
      props.wide === true ? createElement('span', { className: 'fu-entry-label' }, '撤销') : null,
    ),
    open ? createElement(UndoPanel, { onClose: () => setOpen(false) }) : null,
  )
}

export function apply(ctx: ClientContext): void {
  // 崩溃纪律（2026-09-05 加固）：apply 的任何同步失败都会被 loader 记成
  // 「failed to apply loader entry」并触发桌面端插件 recovery 移除——而本插件
  // 的既有纪律是「降级绝不更差」，所以每一步独立设防，失败只损失对应能力。
  try {
    injectStyles()
  } catch (error) {
    console.warn('[file-undo] injectStyles failed (degraded, unstyled):', error)
  }
  // 会话跟随（第二阶段，v0.5.0，纯 client 半）：订阅 betterSidebar /
  // sessions.list 两个数据源（真机实测双源逐对一致），本地维护「当前查看
  // 的会话」；面板与徽章的所有请求携带它，host 走 v0.4.0 既有的逐请求核验
  // 通道——host 半零改动，无推送、无重启、失败只损失「跟随」。
  try {
    startFollowing(ctx)
  } catch (error) {
    console.warn('[file-undo] startFollowing failed (degraded, no follow):', error)
  }
  try {
    ctx.slots.inject('sidebar.footer.action', () =>
      ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'file-undo', order: 101, label: '文件撤销历史' },
        EntryButton,
      ),
    )
  } catch (error) {
    console.warn('[file-undo] sidebar.footer.action registration failed (degraded, no entry button):', error)
  }
}
