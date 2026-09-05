/**
 * Idempotent style injection (platform convention: one <style
 * data-plugin-css="..."> element). Every color rides the platform theme
 * tokens — surfaces, labels, borders, and the diff red/green pair mix the
 * state-success/state-error tokens with the base surface via color-mix, so
 * any skin that overrides the alias layer re-skins this panel for free
 * (no per-skin branches, per the better-sidebar skin contract).
 */

const CSS = `
.fu-root { font-family: inherit; color: var(--dsw-alias-label-primary); }

/* ── footer entry button ─────────────────────────────────────────────── */
.fu-entry {
  position: relative;
  display: inline-flex; align-items: center; gap: 6px;
  height: 32px; padding: 0 8px; border: none; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  cursor: pointer; font-size: 12px; line-height: 1;
  transition: background .12s ease, color .12s ease;
}
.fu-entry:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.fu-entry[data-open='true'] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.fu-entry svg { width: 16px; height: 16px; display: block; }
.fu-entry-label { white-space: nowrap; }
.fu-entry-badge {
  min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 600;
  background: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-label-primary-inverted);
}

/* ── modal overlay + panel ───────────────────────────────────────────── */
.fu-overlay {
  position: fixed; inset: 0; z-index: 90;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, #000 42%, transparent);
  padding: 24px;
}
.fu-panel {
  width: min(940px, 94vw); height: min(660px, 88vh);
  display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  box-shadow: 0 12px 40px color-mix(in srgb, #000 30%, transparent);
  overflow: hidden;
}
.fu-head {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 16px; border-bottom: 1px solid var(--dsw-alias-separator-primary);
  flex: none;
}
.fu-title { font-size: 14px; font-weight: 600; }
.fu-count {
  font-size: 11px; padding: 2px 8px; border-radius: 999px;
  background: var(--dsw-alias-fill-tsp-secondary); color: var(--dsw-alias-label-secondary);
}
.fu-spacer { flex: 1; }
.fu-iconbtn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border: none; border-radius: 7px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  cursor: pointer; font-size: 14px;
}
.fu-iconbtn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.fu-iconbtn svg { width: 15px; height: 15px; display: block; }

/* ── 会话跟随 v0.4.0：切换器 ─────────────────────────────────────────── */
.fu-sessions {
  display: flex; align-items: center; gap: 8px; flex: none;
  padding: 7px 16px; border-bottom: 1px solid var(--dsw-alias-separator-primary);
  background: var(--dsw-alias-fill-tsp-secondary);
}
.fu-sessions-label { font-size: 11px; color: var(--dsw-alias-label-tertiary); flex: none; }
.fu-select {
  flex: 1; min-width: 0; font-size: 11px; padding: 4px 6px;
  border-radius: 6px; cursor: pointer;
  border: 1px solid var(--dsw-alias-separator-primary);
  background: var(--dsw-alias-background-secondary, transparent);
  color: var(--dsw-alias-label-primary);
}
.fu-select:hover { border-color: var(--dsw-alias-interactive-bg-hover); }
.fu-linkbtn {
  flex: none; border: none; background: transparent; cursor: pointer;
  font-size: 11px; padding: 4px 6px; border-radius: 6px;
  color: var(--dsw-alias-label-secondary); text-decoration: underline;
}
.fu-linkbtn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }

/* ── body: list + review ─────────────────────────────────────────────── */
.fu-body { display: flex; flex: 1; min-height: 0; }
.fu-list {
  width: 304px; flex: none; overflow-y: auto;
  border-right: 1px solid var(--dsw-alias-separator-primary);
  padding: 6px;
}
.fu-row {
  padding: 8px 10px; border-radius: 8px; cursor: pointer;
  display: flex; flex-direction: column; gap: 3px;
}
.fu-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.fu-row[data-selected='true'] { background: var(--dsw-alias-fill-tsp-secondary); }
.fu-row[data-state='reverted'] { opacity: .62; }
.fu-row-top { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.fu-row-cmd {
  font-size: 10px; padding: 1px 6px; border-radius: 4px;
  background: var(--dsw-alias-fill-tsp-secondary); color: var(--dsw-alias-label-secondary);
  font-family: ui-monospace, Consolas, monospace;
}
/* 方案 C 轮次徽章（定稿 1.5）：同一 rootCallId 的操作共享一枚徽章；hover 显示整轮信息。 */
.fu-round {
  font-size: 10px; padding: 0 5px; border-radius: 4px;
  background: var(--dsw-alias-color-warning-weak, rgba(230, 162, 60, .16));
  color: var(--dsw-alias-color-warning, #b9801f);
  font-family: ui-monospace, Consolas, monospace;
  cursor: default;
}
.fu-row-undone { font-size: 10px; color: var(--dsw-alias-state-success-primary); }
.fu-row-file {
  font-size: 12px; font-family: ui-monospace, Consolas, monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  color: var(--dsw-alias-label-primary);
}
.fu-row-stats { font-size: 11px; display: flex; gap: 8px; }
.fu-stat-add { color: var(--dsw-alias-state-success-primary); }
.fu-stat-del { color: var(--dsw-alias-state-error-primary); }
.fu-empty { padding: 32px 16px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-tertiary); }

/* ── list: file-grouped view ─────────────────────────────────────────── */
.fu-group { margin-bottom: 2px; }
.fu-group-head {
  display: flex; align-items: center; gap: 6px;
  padding: 7px 8px; border-radius: 8px; cursor: pointer;
}
.fu-group-head:hover { background: var(--dsw-alias-interactive-bg-hover); }
.fu-group-head[data-open='true'] { padding-bottom: 3px; }
.fu-group-caret { width: 11px; flex: none; font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.fu-group-name {
  font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, Consolas, monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.fu-group-count { flex: none; font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.fu-group-dir {
  font-size: 10px; color: var(--dsw-alias-label-tertiary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: 40%;
}
.fu-group-spacer { flex: 1; }
.fu-group-stats { display: flex; gap: 8px; font-size: 11px; flex: none; }
.fu-group-items { padding-left: 16px; border-left: 1px solid var(--dsw-alias-separator-primary); margin: 0 4px 4px 12px; }

.fu-review { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.fu-review-head {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 14px; flex: none;
}
.fu-path {
  flex: 1; min-width: 0;
  font-size: 12px; font-family: ui-monospace, Consolas, monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  color: var(--dsw-alias-label-secondary);
}
.fu-undo-btn {
  height: 28px; padding: 0 14px; border: none; border-radius: 7px;
  font-size: 12px; font-weight: 600; cursor: pointer;
  background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary-inverted);
}
.fu-undo-btn:hover { filter: brightness(1.08); }
.fu-undo-btn:disabled {
  background: var(--dsw-alias-fill-tsp-secondary);
  color: var(--dsw-alias-label-tertiary);
  cursor: not-allowed;
  opacity: 1;
}
.fu-undo-btn[data-confirm='true'] { background: var(--dsw-alias-state-warn-primary); }
.fu-reapply-btn {
  height: 28px; padding: 0 14px; border: none; border-radius: 7px;
  font-size: 12px; font-weight: 600; cursor: pointer;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent);
  color: var(--dsw-alias-brand-primary);
}
.fu-reapply-btn:hover { filter: brightness(1.08); }
.fu-reapply-btn:disabled {
  background: var(--dsw-alias-fill-tsp-secondary);
  color: var(--dsw-alias-label-tertiary);
  cursor: not-allowed;
  opacity: 1;
}
.fu-reapply-btn[data-confirm='true'] { background: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-label-primary-inverted); }
.fu-scope { font-size: 10px; color: var(--dsw-alias-brand-primary); }
.fu-row-reapplied {
  font-size: 10px; padding: 1px 6px; border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);
  color: var(--dsw-alias-brand-primary);
}
.fu-row-failed { font-size: 10px; color: var(--dsw-alias-state-error-primary); }
.fu-row-noop { font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.fu-row[data-state='aborted'] { opacity: .5; }
.fu-row[data-state='noop'] { opacity: .5; }
.fu-cancel-btn {
  height: 28px; padding: 0 12px; border: none; border-radius: 7px;
  font-size: 12px; cursor: pointer;
  background: var(--dsw-alias-fill-tsp-secondary); color: var(--dsw-alias-label-secondary);
}
.fu-reverted-tag {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11px; padding: 3px 10px; border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent);
  color: var(--dsw-alias-state-success-primary);
}

/* ── precheck reasons ────────────────────────────────────────────────── */
.fu-reasons { flex: none; display: flex; flex-direction: column; gap: 6px; padding: 0 14px 8px; }
.fu-reason {
  display: flex; align-items: baseline; gap: 8px;
  font-size: 12px; padding: 7px 10px; border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
  color: var(--dsw-alias-label-primary);
}
.fu-reason[data-severity='error'] {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
}
.fu-reason-code { font-family: ui-monospace, Consolas, monospace; font-size: 10px; color: var(--dsw-alias-label-tertiary); flex: none; }
/* ── 5.1 空行痕迹黄牌 + 复制修复指令 ───────────────────────────────────── */
.fu-blankline {
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 18%, transparent);
}
.fu-copyfix-btn {
  flex: none; height: 24px; padding: 0 10px; margin-left: auto;
  border: none; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer;
  background: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-label-primary-inverted);
}
.fu-copyfix-btn:hover { filter: brightness(1.08); }
/* ── 5.2 RewindTo：入口按钮 + 确认框 + 账本补记 ────────────────────────── */
.fu-rewind-btn {
  height: 28px; padding: 0 12px; border: none; border-radius: 7px;
  font-size: 12px; font-weight: 600; cursor: pointer;
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent);
  color: var(--dsw-alias-state-warn-primary);
}
.fu-rewind-btn:hover { filter: brightness(1.08); }
.fu-rewind-btn:disabled {
  background: var(--dsw-alias-fill-tsp-secondary);
  color: var(--dsw-alias-label-tertiary);
  cursor: not-allowed; opacity: 1;
}
.fu-rewind-confirm {
  flex: none; margin: 0 14px 8px; padding: 9px 12px; border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent);
  font-size: 12px; color: var(--dsw-alias-label-primary);
}
.fu-repair-btn {
  flex: none; height: 24px; padding: 0 10px; margin-left: auto;
  border: none; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer;
  background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-label-primary-inverted);
}
.fu-repair-btn:hover { filter: brightness(1.08); }

/* ── diff view (reference-style line typing, all CSS coloring) ────────────── */
.fu-diff-wrap { flex: 1; min-height: 0; overflow: auto; background: var(--dsw-alias-bg-base); }
.fu-diff {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px; line-height: 1.55;
  padding-bottom: 24px;
}
.fu-hunk-head {
  padding: 3px 12px; user-select: none;
  color: var(--dsw-alias-label-tertiary);
  background: var(--dsw-alias-fill-tsp-secondary);
  font-size: 11px;
  position: sticky; top: 0;
}
.fu-diff-row { display: grid; grid-template-columns: 3.2em 3.2em 1fr; min-width: 0; }
.fu-diff-no {
  text-align: right; padding: 0 7px; user-select: none;
  color: var(--dsw-alias-label-quaternary); font-size: 11px; line-height: 1.9;
}
.fu-diff-content {
  padding: 0 10px; white-space: pre-wrap; word-break: break-all;
  min-width: 0;
}
.fu-diff-row[data-line-type='addition'] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, var(--dsw-alias-bg-base)); }
.fu-diff-row[data-line-type='addition'] > .fu-diff-no { color: var(--dsw-alias-state-success-primary); }
.fu-diff-row[data-line-type='deletion'] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, var(--dsw-alias-bg-base)); }
.fu-diff-row[data-line-type='deletion'] > .fu-diff-no { color: var(--dsw-alias-state-error-primary); }
.fu-diff-row[data-line-type='metadata'] { color: var(--dsw-alias-label-tertiary); font-style: italic; }
.fu-diff-more { padding: 10px; text-align: center; }
.fu-diff-more-btn {
  height: 26px; padding: 0 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px;
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-secondary);
  font-size: 12px; cursor: pointer;
}
.fu-diff-identical { padding: 40px 16px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-tertiary); }

/* ── footer ──────────────────────────────────────────────────────────── */
.fu-foot {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 16px; border-top: 1px solid var(--dsw-alias-separator-primary);
  flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary);
}
.fu-days {
  width: 52px; height: 24px; padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font-size: 11px;
}
.fu-prune-btn {
  height: 24px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font-size: 11px; cursor: pointer;
}
.fu-prune-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.fu-foot-msg { margin-left: 6px; font-size: 12px; font-weight: 500; }
.fu-foot-msg[data-kind='ok'] { color: var(--dsw-alias-state-success-primary); }
.fu-foot-msg[data-kind='error'] { color: var(--dsw-alias-state-error-primary); }
.fu-foot-hint { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.fu-row-created { font-size: 10px; color: var(--dsw-alias-label-tertiary); }
`

const TAG = 'dsh-file-undo'

/** Insert the plugin stylesheet once (idempotent by data-plugin-css tag). */
export function injectStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${TAG}"]`) !== null) return
  const tag = document.createElement('style')
  tag.setAttribute('data-plugin-css', TAG)
  tag.textContent = CSS
  document.head.appendChild(tag)
}
