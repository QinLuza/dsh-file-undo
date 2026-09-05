/**
 * Minimal client-side contract declarations (self-contained, hdc-bridge
 * pattern): the client bundle must stay dependency-pure — no value imports
 * from any @deepseek-ai package. These local shapes restate just enough of
 * the cordis client context and the official `sidebar.footer.action` slot
 * (kind: list, scope: root, declared by client-ui-sidebar) for typed code.
 */
import type { ReactNode } from 'react'

/** Registration options accepted by the official footer-action slot. */
export interface FooterSlotOptions {
  name: 'sidebar.footer.action'
  /** Unique entry id inside the slot list; ours is 'file-undo'. */
  id: string
  order?: number
  label?: string
}

/** Props the platform passes to every footer action entry. */
export interface FooterSlotProps {
  /** Whether the sidebar rail is expanded (labels shown when wide). */
  wide?: boolean
}

/** The cordis client slots service (restated surface). */
export interface SlotsLike {
  inject(slot: string, register: () => unknown): unknown
  register(options: FooterSlotOptions, component: (props: FooterSlotProps) => ReactNode): unknown
}

/** The cordis client context (restated surface used by this plugin). */
export interface ClientContext {
  slots: SlotsLike
  /** Direct optional service read (betterSidebar / sessions / timer). */
  get?(name: string): unknown
  /**
   * Register a fiber-owned effect whose returned disposer runs on plugin
   * unload (HMR / disable) — used by follow.ts to detach source subscriptions.
   */
  effect?(callback: () => (() => void) | void, label?: string): unknown
}
