window.__ModuleLoader__.load({
  id: 'dsh-file-undo',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
//#region src/client/styles.ts
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
`;
const TAG = "dsh-file-undo";
/** Insert the plugin stylesheet once (idempotent by data-plugin-css tag). */
function injectStyles() {
	if (typeof document === "undefined") return;
	if (document.querySelector(`style[data-plugin-css="${TAG}"]`) !== null) return;
	const tag = document.createElement("style");
	tag.setAttribute("data-plugin-css", TAG);
	tag.textContent = CSS;
	document.head.appendChild(tag);
}
//#endregion
//#region src/client/api.ts
var ApiFailure = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
	}
};
async function call(method, body = {}) {
	const response = await fetch(`/file-undo/api/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body)
	});
	let envelope;
	try {
		envelope = await response.json();
	} catch {
		throw new ApiFailure("bad-response", `HTTP ${response.status}: 无法解析响应`);
	}
	if (envelope.ok === true && envelope.value !== void 0) return envelope.value;
	const error = envelope.error;
	throw new ApiFailure(error?.code ?? "unknown", error?.message ?? `HTTP ${response.status}`);
}
/**
* The pinned session id, when there is one. Every method carries it so the
* host can serve THAT session's store instead of guessing from its own last
* active scope (会话跟随 v0.4.0).
*/
const at = (sessionId) => sessionId === void 0 || sessionId === "" ? {} : { sessionId };
const api = {
	context: () => call("context"),
	history: (sessionId) => call("history", at(sessionId)),
	detail: (id, sessionId) => call("detail", {
		id,
		...at(sessionId)
	}),
	apply: (id, expectedCurrentHash, sessionId) => call("apply", {
		id,
		...expectedCurrentHash !== null ? { expectedCurrentHash } : {},
		...at(sessionId)
	}),
	reapply: (id, expectedCurrentHash, sessionId) => call("reapply", {
		id,
		...expectedCurrentHash !== null ? { expectedCurrentHash } : {},
		...at(sessionId)
	}),
	/** 级联回退预检（定稿 2.2）：只读，不写盘。`stale_ledger` 是待修复状态而非失败。 */
	rewindPreview: (id, sessionId) => call("rewindPreview", {
		id,
		...at(sessionId)
	}),
	/** 级联回退落盘（定稿 2.3）：单次原子写入 + 批量状态更新。hash 必须来自 preview。 */
	rewindApply: (id, expectedCurrentHash, sessionId) => call("rewindApply", {
		id,
		expectedCurrentHash,
		...at(sessionId)
	}),
	/** 账本滞后补记（定稿 4.2）：只补标记、零写盘；返回被补记的文件路径。 */
	confirmStaleLedger: (id, sessionId) => call("confirmStaleLedger", {
		id,
		...at(sessionId)
	}),
	prune: (days, sessionId) => call("prune", {
		days,
		...at(sessionId)
	}),
	/** 会话切换器目录（会话跟随）：同项目树下的会话清单；缝缺席时 available=false。 */
	sessions: (sessionId) => call("sessions", at(sessionId))
};
//#endregion
//#region src/client/DiffView.tsx
/**
* Red/green diff renderer — the display half of the compute/render split.
*
* The host computes unified hunks once (src/diff.ts); this component only
* classifies each line by its first character (the ~10-line parseLineType
* trick from the reference analysis) into a data-line-type attribute. All
* coloring lives in CSS (token-driven color-mix over the base surface), so
* skins re-theme the diff without touching JS, and React's text rendering
* keeps content XSS-safe without any escaping dance.
*/
/** Classify one unified-diff line by its marker character. */
function parseLineType(line) {
	const first = line.charAt(0);
	if (first === " ") return "context";
	if (first === "\\") return "metadata";
	if (first === "+") return "addition";
	return "deletion";
}
/** Default render cap before the "show everything" button appears. */
const MAX_RENDER_LINES = 800;
function DiffView(props) {
	const [expanded, setExpanded] = (0, react.useState)(false);
	if (props.hunks.length === 0) return (0, react.createElement)("div", { className: "fu-diff-identical" }, props.emptyText ?? "内容一致 — 撤销前后没有可显示的差异");
	const rows = [];
	for (const hunk of props.hunks) {
		let oldNo = hunk.oldStart;
		let newNo = hunk.newStart;
		for (const line of hunk.lines) {
			const type = parseLineType(line);
			const oldNum = type === "addition" || type === "metadata" ? null : oldNo;
			const newNum = type === "deletion" || type === "metadata" ? null : newNo;
			if (type !== "addition" && type !== "metadata") oldNo++;
			if (type !== "deletion" && type !== "metadata") newNo++;
			rows.push({
				type,
				oldNo: oldNum,
				newNo: newNum,
				text: line.slice(1)
			});
		}
	}
	const capped = !expanded && rows.length > MAX_RENDER_LINES;
	const visible = capped ? rows.slice(0, MAX_RENDER_LINES) : rows;
	return (0, react.createElement)("div", { className: "fu-diff-wrap" }, (0, react.createElement)("div", { className: "fu-diff" }, props.hunks.map((hunk, hunkIndex) => {
		let before = 0;
		for (let h = 0; h < hunkIndex; h++) before += props.hunks[h].lines.length;
		const hunkRows = visible.slice(before, before + hunk.lines.length);
		const fullyRendered = hunkRows.length === hunk.lines.length;
		return (0, react.createElement)("div", { key: `hunk-${hunkIndex}` }, (0, react.createElement)("div", { className: "fu-hunk-head" }, `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`), ...fullyRendered ? hunkRows.map((row, i) => diffRow(row, `${hunkIndex}-${i}`)) : []);
	}), capped ? (0, react.createElement)("div", { className: "fu-diff-more" }, `已省略 ${rows.length - MAX_RENDER_LINES} 行… `, (0, react.createElement)("button", {
		className: "fu-diff-more-btn",
		onClick: () => setExpanded(true)
	}, "显示全部差异")) : null));
}
function diffRow(row, key) {
	return (0, react.createElement)("div", {
		key,
		className: "fu-diff-row",
		"data-line-type": row.type
	}, (0, react.createElement)("span", { className: "fu-diff-no" }, row.oldNo === null ? "" : String(row.oldNo)), (0, react.createElement)("span", { className: "fu-diff-no" }, row.newNo === null ? "" : String(row.newNo)), (0, react.createElement)("span", { className: "fu-diff-content" }, row.text));
}
//#endregion
//#region src/client/follow.ts
/** 当前跟随的会话 id（null = 无会话被查看 / 两源全缺席）。 */
let followedId = null;
const listeners$1 = /* @__PURE__ */ new Set();
/** 读取当前跟随的会话 id；面板所有请求把它作为缺省会话标识。 */
function getFollowedSessionId() {
	return followedId;
}
/** 订阅跟随会话变化；返回取消函数。 */
function subscribeFollowed(listener) {
	listeners$1.add(listener);
	return () => {
		listeners$1.delete(listener);
	};
}
function setFollowed(id) {
	if (id === followedId) return;
	followedId = id;
	for (const listener of Array.from(listeners$1)) try {
		listener();
	} catch {}
}
const bsState = {
	available: false,
	id: null
};
const seState = {
	available: false,
	id: null
};
function normalizeId(value) {
	return typeof value === "string" && value !== "" ? value : null;
}
/** 合并两源：betterSidebar 非空值优先，空值回落 sessions，全缺席 → null。 */
function recompute() {
	let next = null;
	if (bsState.available) next = bsState.id !== null ? bsState.id : seState.id;
	else if (seState.available) next = seState.id;
	setFollowed(next);
}
/**
* 探测并订阅 betterSidebar 主源。就绪返回 true；缺席/形态不符/读快照抛错
* 返回 false（保持「缺席」态，绝不半订阅）。
*/
function probeBetterSidebar(ctx, disposers) {
	if (bsState.available) return true;
	let svc;
	try {
		svc = ctx.get?.("betterSidebar");
	} catch {
		return false;
	}
	if (svc === void 0 || svc === null) return false;
	const getSnapshot = svc.getSnapshot;
	const subscribeState = svc.subscribeState;
	if (typeof getSnapshot !== "function" || typeof subscribeState !== "function") return false;
	let initial = null;
	try {
		const snap = getSnapshot();
		initial = snap !== null && typeof snap === "object" ? normalizeId(snap.sessionId) : null;
	} catch {
		return false;
	}
	bsState.available = true;
	bsState.id = initial;
	let dispose;
	try {
		dispose = subscribeState(() => {
			let next = null;
			try {
				const snap = getSnapshot();
				next = snap !== null && typeof snap === "object" ? normalizeId(snap.sessionId) : null;
			} catch {
				return;
			}
			bsState.id = next;
			recompute();
		});
	} catch {
		bsState.available = false;
		bsState.id = null;
		return false;
	}
	if (typeof dispose === "function") disposers.push(dispose);
	return true;
}
/** 探测并订阅 sessions.list 兜底源（同款防御纪律）。 */
function probeSessions(ctx, disposers) {
	if (seState.available) return true;
	let svc;
	try {
		svc = ctx.get?.("sessions");
	} catch {
		return false;
	}
	const list = svc === void 0 || svc === null ? void 0 : svc.list;
	if (list === void 0 || list === null) return false;
	const getSnapshot = list.getSnapshot;
	const subscribe = list.subscribe;
	if (typeof getSnapshot !== "function" || typeof subscribe !== "function") return false;
	let initial = null;
	try {
		const snap = getSnapshot();
		initial = snap !== null && typeof snap === "object" ? normalizeId(snap.current) : null;
	} catch {
		return false;
	}
	seState.available = true;
	seState.id = initial;
	let dispose;
	try {
		dispose = subscribe(() => {
			let next = null;
			try {
				const snap = getSnapshot();
				next = snap !== null && typeof snap === "object" ? normalizeId(snap.current) : null;
			} catch {
				return;
			}
			seState.id = next;
			recompute();
		});
	} catch {
		seState.available = false;
		seState.id = null;
		return false;
	}
	if (typeof dispose === "function") disposers.push(dispose);
	return true;
}
/** 未就绪源的重探上限（1.5s × 8 ≈ 12s；动态插件真机实测的同款预算）。 */
const MAX_REPROBE_TRIES = 8;
const REPROBE_INTERVAL_MS = 1500;
/**
* 安装跟随：即探即订，未就绪的源经 timer 服务有限次重探。全部缺席 → 静默
* 不跟随；插件卸载（HMR / 停用）时经 ctx.effect 统一退订。
*/
function startFollowing(ctx) {
	const disposers = [];
	const bsOk = probeBetterSidebar(ctx, disposers);
	const seOk = probeSessions(ctx, disposers);
	recompute();
	if (!(bsOk && seOk) && typeof ctx.effect === "function") {
		const timer = (() => {
			try {
				return ctx.get?.("timer");
			} catch {
				return;
			}
		})();
		if (timer !== void 0 && timer !== null && typeof timer.interval === "function") {
			const interval = timer.interval;
			let tries = 0;
			let stop;
			const tick = () => {
				tries += 1;
				const bsNow = bsOk || probeBetterSidebar(ctx, disposers);
				const seNow = seOk || probeSessions(ctx, disposers);
				recompute();
				if (bsNow && seNow || tries >= MAX_REPROBE_TRIES) try {
					stop?.();
				} catch {}
			};
			const maybeStop = interval(tick, REPROBE_INTERVAL_MS);
			stop = typeof maybeStop === "function" ? maybeStop : void 0;
			if (stop !== void 0) disposers.push(stop);
		}
	}
	if (disposers.length > 0 && typeof ctx.effect === "function") ctx.effect(() => () => {
		const list = disposers.splice(0, disposers.length);
		for (const dispose of list) try {
			dispose();
		} catch {}
	}, "follow: source subscriptions");
}
//#endregion
//#region src/client/UndoPanel.tsx
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
const REASON_COPY = {
	file_creation: "这是文件创建操作 — 撤销将删除该文件（内容未捕获时不允许安全删除）",
	no_before: "旧版快照未记录改前内容 — 没有可恢复的目标，无法撤销",
	already_reverted: "此操作已经撤销过了",
	file_missing: "文件已不存在于磁盘",
	file_read_failed: "当前文件读取失败",
	external_modified: "快照之后文件又被修改（外部编辑或后续写入），撤销会丢失这些改动 — 如确需强制，请在聊天中使用 /undo",
	superseded_by_later_ops: "此操作之后还有后续编辑，无法单独撤销本条 — 请使用「回退到此状态」连同后续步骤一起撤销",
	unknown_state: "该快照未捕获改后状态，且当前文件与改前内容不同；请仔细核对差异后再决定",
	unsupported_checkpoint: "该快照未捕获改后状态，无法定位链条终点",
	creation_rewind_unsupported: "暂不支持级联撤销创建操作。请先逆序撤销其后的条目，再对本条使用单条撤销。",
	stale_ledger: "检测到已撤销但未标记，是否补记？",
	unsupported_operation: "仅编辑类快照支持账本补记，创建类请走单条撤销的幂等路径",
	unknown_revert: "此条目的撤销来源未知，为保证状态一致，拒绝重新应用。"
};
/** Accurate empty-state copy for the diff area, per precheck classification. */
function emptyDiffText(detail) {
	if (detail.preview.currentExists === false) return "当前文件不可读（可能已被移动或删除），无法计算差异";
	const codes = detail.preview.reasons.map((r) => r.code);
	if (codes.includes("no_before")) return "旧版快照未记录改前内容，无法显示恢复差异";
	if (codes.includes("file_creation")) return "创建类操作的改后内容未捕获 — 无内容可显示";
}
function basename(path) {
	const norm = path.replace(/\\/g, "/");
	const at = norm.lastIndexOf("/");
	return at === -1 ? norm : norm.slice(at + 1);
}
function formatTime(time) {
	if (time <= 0) return "?";
	const date = new Date(time);
	const now = /* @__PURE__ */ new Date();
	const hhmmss = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
	return date.toDateString() === now.toDateString() ? hhmmss : `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${hhmmss}`;
}
/**
* Group the flat history by file. `items` arrives newest-first, so Map
* insertion order = files ordered by their most recent activity, and each
* group's entries keep newest-first too. Totals are per-entry churn summed
* (an activity indicator, not a net diff — net would need first-before vs
* last-after across undo/reapply round-trips, which would lie).
*/
function groupByFile(items) {
	const map = /* @__PURE__ */ new Map();
	for (const item of items) {
		let group = map.get(item.filePath);
		if (group === void 0) {
			group = {
				filePath: item.filePath,
				entries: [],
				added: 0,
				removed: 0
			};
			map.set(item.filePath, group);
		}
		group.entries.push(item);
		group.added += item.added;
		group.removed += item.removed;
	}
	return [...map.values()];
}
/**
* Same-basename files (D:\a\文档.txt vs D:\文档.txt) render identical group
* names — storage/revert never collide (everything keys on the full resolved
* path), but the LIST would. For every basename shared by 2+ groups, compute
* the minimal trailing directory segments that disambiguates each path
* (VS Code tab-style: `文档.txt · DSH-plug-in` vs `文档.txt · D:`), extending
* upward until unique. Windows path compares are case-insensitive.
*/
function dirDisambiguators(groups) {
	const byBase = /* @__PURE__ */ new Map();
	for (const g of groups) {
		const base = basename(g.filePath).toLowerCase();
		const list = byBase.get(base);
		if (list === void 0) byBase.set(base, [g.filePath]);
		else list.push(g.filePath);
	}
	const out = /* @__PURE__ */ new Map();
	for (const paths of byBase.values()) {
		if (paths.length < 2) continue;
		const dirsOf = (p) => p.replace(/\//g, "\\").split("\\").filter((s) => s !== "").slice(0, -1);
		for (const p of paths) {
			const dirs = dirsOf(p);
			let depth = 1;
			let suffix = "";
			while (depth <= dirs.length) {
				suffix = dirs.slice(-depth).join("\\");
				const mine = suffix.toLowerCase();
				if (paths.every((q) => {
					if (q === p) return true;
					return dirsOf(q).slice(-depth).join("\\").toLowerCase() !== mine;
				})) break;
				depth++;
			}
			out.set(p, suffix);
		}
	}
	return out;
}
/**
* Human label for one switcher entry: prefer the platform's title (what the
* user actually recognises); fall back to `<cwd basename> · <short id>` when
* the title seam is absent. The basename fallback is only useful when the cwd
* is genuinely distinguishing — same-cwd siblings need the id to tell apart.
*/
function sessionLabel(option) {
	const flags = [
		option.current ? "当前" : null,
		option.live ? "活跃" : "仅存档",
		option.hasRecords ? "有记录" : "无记录"
	].filter((flag) => flag !== null);
	const title = typeof option.title === "string" ? option.title.trim() : "";
	if (title !== "") return `${title}（${flags.join(" · ")}）`;
	const segments = option.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).filter((s) => s !== "");
	return `${segments.length > 0 ? segments[segments.length - 1] : option.cwd} · ${option.id.replace(/^session-/, "").slice(0, 8)}（${flags.join(" · ")}）`;
}
function UndoPanel(props) {
	const [items, setItems] = (0, react.useState)(null);
	const [loadError, setLoadError] = (0, react.useState)(null);
	const [scopeInfo, setScopeInfo] = (0, react.useState)(null);
	/**
	* 会话跟随（v0.4.0）：面板绑定的会话。`null` = 跟随 host 的最近活跃会话；
	* 非空 = 用户从切换器钉住的会话，此后**所有**请求都带上它，host 据此直接
	* 定位该会话的快照库，不再靠"最近做过文件操作"猜。
	*/
	const [pinned, setPinned] = (0, react.useState)(null);
	/**
	* 会话跟随（第二阶段，v0.5.0）：平台侧「当前查看的会话」（betterSidebar
	* 主源 / sessions.list 兜底，见 follow.ts）。钉住（pinned）优先级更高；
	* 两者都空时回到旧行为（host 最近活跃会话）。
	*/
	const [followed, setFollowedState] = (0, react.useState)(() => getFollowedSessionId());
	(0, react.useEffect)(() => subscribeFollowed(() => {
		setFollowedState(getFollowedSessionId());
	}), []);
	/** 每个请求实际携带的会话标识：钉住 > 平台跟随 > host 最近活跃。 */
	const sessionAt = pinned ?? followed ?? void 0;
	/** 切换器目录；`available: false` 时 UI 隐藏切换器（缝缺席）。 */
	const [sessions, setSessions] = (0, react.useState)(null);
	const [selectedId, setSelectedId] = (0, react.useState)(null);
	const [detail, setDetail] = (0, react.useState)(null);
	const [detailError, setDetailError] = (0, react.useState)(null);
	const [confirmState, setConfirmState] = (0, react.useState)("idle");
	const [applyMsg, setApplyMsg] = (0, react.useState)(null);
	/** 5.2：RewindTo 的两阶段 —— 点击「回退到此状态」先 rewindPreview，确认后 rewindApply。 */
	const [rewindPlan, setRewindPlan] = (0, react.useState)(null);
	const [rewindBusy, setRewindBusy] = (0, react.useState)(false);
	/** 复制修复指令的瞬态反馈（复制成功 → 按钮短暂变「已复制」）。 */
	const [copiedLine, setCopiedLine] = (0, react.useState)(null);
	const [pruneDays, setPruneDays] = (0, react.useState)("7");
	const [footMsg, setFootMsg] = (0, react.useState)(null);
	const confirmTimer = (0, react.useRef)(null);
	const selectedIdRef = (0, react.useRef)(null);
	(0, react.useEffect)(() => {
		selectedIdRef.current = selectedId;
	}, [selectedId]);
	const loadDetailSeq = (0, react.useRef)(0);
	const [expandedFiles, setExpandedFiles] = (0, react.useState)(/* @__PURE__ */ new Set());
	const selectedFilePath = items?.find((i) => i.id === selectedId)?.filePath ?? null;
	(0, react.useEffect)(() => {
		if (selectedFilePath === null) return;
		setExpandedFiles((prev) => {
			if (prev.has(selectedFilePath)) return prev;
			const next = new Set(prev);
			next.add(selectedFilePath);
			return next;
		});
	}, [selectedFilePath]);
	const refreshHistory = (0, react.useCallback)(async (keepSelection) => {
		const at = sessionAt;
		try {
			const [fresh, context, directory] = await Promise.all([
				api.history(at),
				api.context(),
				api.sessions(at).catch(() => null)
			]);
			const list = fresh.items;
			setItems(list);
			setScopeInfo(context);
			setSessions(directory);
			setLoadError(null);
			if (!keepSelection) {
				const first = list.find((i) => i.state === "recorded") ?? list[0];
				setSelectedId(first !== void 0 ? first.id : null);
			} else {
				const current = selectedIdRef.current;
				if (current !== null && !list.some((i) => i.id === current)) setSelectedId(list[0]?.id ?? null);
			}
		} catch (error) {
			setLoadError(error instanceof ApiFailure ? error.message : String(error));
		}
	}, [sessionAt]);
	const loadDetail = (0, react.useCallback)(async (id) => {
		const seq = ++loadDetailSeq.current;
		setDetail(null);
		setDetailError(null);
		setConfirmState("idle");
		setApplyMsg(null);
		setRewindPlan(null);
		try {
			const result = await api.detail(id, sessionAt);
			if (seq !== loadDetailSeq.current) return;
			setDetail(result);
		} catch (error) {
			if (seq !== loadDetailSeq.current) return;
			setDetailError(error instanceof ApiFailure ? error.message : String(error));
		}
	}, [sessionAt]);
	(0, react.useEffect)(() => {
		refreshHistory(false);
	}, [refreshHistory]);
	(0, react.useEffect)(() => {
		if (selectedId === null) {
			setDetail(null);
			return;
		}
		loadDetail(selectedId);
	}, [selectedId, loadDetail]);
	(0, react.useEffect)(() => {
		const timer = setInterval(() => void refreshHistory(true), 5e3);
		return () => clearInterval(timer);
	}, [refreshHistory]);
	(0, react.useEffect)(() => {
		const onKey = (event) => {
			if (event.key === "Escape") props.onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [props]);
	(0, react.useEffect)(() => {
		if (confirmState !== "armed") return;
		confirmTimer.current = setTimeout(() => setConfirmState("idle"), 3e3);
		return () => {
			if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
		};
	}, [confirmState]);
	const onUndoClick = (0, react.useCallback)(async () => {
		if (detail === null || selectedId === null) return;
		if (confirmState === "idle") {
			setConfirmState("armed");
			return;
		}
		if (confirmState !== "armed") return;
		setConfirmState("applying");
		try {
			const result = await api.apply(selectedId, detail.preview.currentHash, sessionAt);
			setApplyMsg({
				kind: "ok",
				text: result.deleted ? result.alreadyGone ? `文件已不存在，视为已撤销：${result.restored}（创建记录保留为日志）` : `已删除 ${result.restored}（撤销创建）——文件已从磁盘移除` : `已恢复 ${result.restored}（撤销 ${result.command}）——已写入磁盘；编辑器若未刷新请重新打开该文件`
			});
			await loadDetail(selectedId);
			await refreshHistory(true);
		} catch (error) {
			const failure = error instanceof ApiFailure ? error : null;
			setApplyMsg({
				kind: "error",
				text: failure !== null && (failure.code === "stale" || failure.code === "external_modified" || failure.code === "superseded_by_later_ops") ? "文件在预览后发生了变化，已为你刷新差异 — 请重新核对后再撤销" : `撤销失败：${failure !== null ? failure.message : String(error)}`
			});
			if (failure !== null && (failure.code === "stale" || failure.code === "external_modified" || failure.code === "superseded_by_later_ops")) {
				await loadDetail(selectedId);
				await refreshHistory(true);
			}
			setConfirmState("idle");
		}
		setConfirmState((prev) => prev === "applying" ? "idle" : prev);
	}, [
		detail,
		selectedId,
		confirmState,
		loadDetail,
		refreshHistory,
		sessionAt
	]);
	/** Re-apply a reverted entry: write the after-state back (inverse of undo). */
	const onReapplyClick = (0, react.useCallback)(async () => {
		if (detail === null || selectedId === null) return;
		if (confirmState === "idle") {
			setConfirmState("armed");
			return;
		}
		if (confirmState !== "armed") return;
		setConfirmState("applying");
		try {
			const result = await api.reapply(selectedId, detail.preview.currentHash, sessionAt);
			const revived = result.revived ?? 0;
			const revivedText = revived > 0 ? `，并连带恢复被这次回退作废的 ${revived} 条后续操作` : "";
			setApplyMsg({
				kind: "ok",
				text: result.ledgerSynced === false ? `已重新应用 ${result.reapplied}${revivedText}，但历史标记同步失败。请重新打开本条目，系统会提示补记。` : result.recreated ? `已重建 ${result.reapplied}（重新应用创建的内容）${revivedText}——文件已写回磁盘` : `已重新应用 ${result.reapplied}（恢复 ${result.command} 的结果）${revivedText}——已写入磁盘；编辑器若未刷新请重新打开该文件`
			});
			await loadDetail(selectedId);
			await refreshHistory(true);
		} catch (error) {
			const failure = error instanceof ApiFailure ? error : null;
			setApplyMsg({
				kind: "error",
				text: failure !== null && failure.code === "stale" ? "文件在预览后发生了变化，已为你刷新 — 请重新核对后再应用" : `重新应用失败：${failure !== null ? failure.message : String(error)}`
			});
			if (failure !== null && failure.code === "stale") {
				await loadDetail(selectedId);
				await refreshHistory(true);
			}
			setConfirmState("idle");
		}
		setConfirmState((prev) => prev === "applying" ? "idle" : prev);
	}, [
		detail,
		selectedId,
		confirmState,
		loadDetail,
		refreshHistory,
		sessionAt
	]);
	/** 5.2 RewindTo 阶段 1：预检 —— 计算回退目标与连锁作废步数，弹出确认。 */
	const onRewindClick = (0, react.useCallback)(async () => {
		if (detail === null || selectedId === null || rewindBusy) return;
		setRewindBusy(true);
		try {
			const plan = await api.rewindPreview(selectedId, sessionAt);
			setRewindPlan(plan);
			setApplyMsg(null);
		} catch (error) {
			const failure = error instanceof ApiFailure ? error : null;
			setApplyMsg({
				kind: "error",
				text: `回退预检失败：${failure !== null ? failure.message : String(error)}`
			});
		} finally {
			setRewindBusy(false);
		}
	}, [
		detail,
		selectedId,
		rewindBusy,
		sessionAt
	]);
	/** 5.2 阶段 2：确认后执行回退（单次原子写入 + 批量状态标记）。 */
	const onRewindConfirm = (0, react.useCallback)(async () => {
		if (detail === null || selectedId === null || rewindPlan === null || rewindPlan.status !== "ok" || rewindBusy) return;
		setRewindBusy(true);
		try {
			const result = await api.rewindApply(selectedId, rewindPlan.expectedCurrentHash, sessionAt);
			setRewindPlan(null);
			setApplyMsg({
				kind: "ok",
				text: result.ledgerSynced ? `已回退到 ${result.restored}（丢弃其后的 ${result.invalidated} 步）——已写入磁盘；编辑器若未刷新请重新打开该文件` : `已回退到 ${result.restored}，但历史标记同步失败。请重新打开本条目，系统会提示补记。`
			});
			await loadDetail(selectedId);
			await refreshHistory(true);
		} catch (error) {
			const failure = error instanceof ApiFailure ? error : null;
			if (failure !== null && failure.code === "stale") {
				await loadDetail(selectedId);
				await refreshHistory(true);
			}
			setRewindPlan(null);
			setApplyMsg({
				kind: "error",
				text: `回退失败：${failure !== null ? failure.message : String(error)}`
			});
		} finally {
			setRewindBusy(false);
		}
	}, [
		detail,
		selectedId,
		rewindPlan,
		rewindBusy,
		loadDetail,
		refreshHistory,
		sessionAt
	]);
	/** 账本滞后修复：确认是"已撤销但未标记"，只补记状态不写盘。 */
	const onStaleLedgerRepair = (0, react.useCallback)(async () => {
		if (selectedId === null || rewindBusy) return;
		setRewindBusy(true);
		try {
			const { repaired } = await api.confirmStaleLedger(selectedId, sessionAt);
			setRewindPlan(null);
			setApplyMsg({
				kind: "ok",
				text: `已补记 ${repaired}（只改状态，未写盘）`
			});
			await loadDetail(selectedId);
			await refreshHistory(true);
		} catch (error) {
			const failure = error instanceof ApiFailure ? error : null;
			setApplyMsg({
				kind: "error",
				text: `补记失败：${failure !== null ? failure.message : String(error)}`
			});
		} finally {
			setRewindBusy(false);
		}
	}, [
		selectedId,
		rewindBusy,
		loadDetail,
		refreshHistory,
		sessionAt
	]);
	/** 5.1 复制修复指令：一条剪贴板文本，插件零写盘。 */
	const copyFixInstruction = (0, react.useCallback)(async (line) => {
		const text = `第 ${line} 行是被清空的内容行而非删除。请用 old_string 包含行尾换行符重新删除该行。`;
		try {
			await navigator.clipboard.writeText(text);
			setCopiedLine(line);
			setTimeout(() => setCopiedLine((prev) => prev === line ? null : prev), 2e3);
		} catch {
			setApplyMsg({
				kind: "error",
				text: `复制失败：${text}`
			});
		}
	}, []);
	const onPrune = (0, react.useCallback)(async () => {
		const days = Number(pruneDays);
		if (!Number.isFinite(days) || days <= 0) {
			setFootMsg({
				kind: "error",
				text: "天数需为正数"
			});
			return;
		}
		try {
			const { message } = await api.prune(days, sessionAt);
			setFootMsg({
				kind: "ok",
				text: message
			});
			await refreshHistory(false);
		} catch (error) {
			setFootMsg({
				kind: "error",
				text: error instanceof ApiFailure ? error.message : String(error)
			});
		}
	}, [
		pruneDays,
		refreshHistory,
		sessionAt
	]);
	const pendingCount = items?.filter((i) => i.state === "recorded").length ?? 0;
	const sessionItems = sessions?.available === true ? sessions.items : [];
	const options = pinned !== null && !sessionItems.some((s) => s.id === pinned) ? [...sessionItems, {
		id: pinned,
		cwd: "",
		current: false,
		live: false,
		hasRecords: false
	}] : sessionItems;
	const selectValue = pinned ?? followed ?? sessions?.currentId ?? "";
	const boundId = sessions?.available === true && sessions.currentId !== null ? sessions.currentId : scopeInfo?.scope?.chatKey ?? null;
	const blankLine = detail?.blankLine;
	return (0, react.createElement)("div", {
		className: "fu-overlay",
		onClick: (event) => {
			if (event.target === event.currentTarget) props.onClose();
		}
	}, (0, react.createElement)("div", { className: "fu-panel fu-root" }, (0, react.createElement)("div", { className: "fu-head" }, (0, react.createElement)("span", { className: "fu-title" }, "文件撤销历史"), (0, react.createElement)("span", { className: "fu-count" }, `${items?.length ?? 0} 条记录 · ${pendingCount} 条可撤销`, boundId !== null ? (0, react.createElement)("span", {
		className: "fu-scope",
		title: boundId
	}, ` · 当前会话${pinned === null && followed !== null ? "（跟随）" : ""}`) : null), (0, react.createElement)("span", { className: "fu-spacer" }), (0, react.createElement)("button", {
		className: "fu-iconbtn",
		title: "刷新",
		"aria-label": "刷新",
		onClick: () => void refreshHistory(true)
	}, "⟳"), (0, react.createElement)("button", {
		className: "fu-iconbtn",
		title: "关闭 (Esc)",
		"aria-label": "关闭",
		onClick: props.onClose
	}, "✕")), sessions?.available === true ? (0, react.createElement)("div", { className: "fu-sessions" }, (0, react.createElement)("label", {
		className: "fu-sessions-label",
		htmlFor: "fu-session-select"
	}, "会话"), (0, react.createElement)("select", {
		id: "fu-session-select",
		className: "fu-select",
		value: selectValue,
		title: "同一项目树（当前目录及其父子目录）下的会话；未钉住时自动跟随当前查看的会话（平台推送），钉住后固定作用于所选会话",
		onChange: (event) => {
			const next = event.target.value;
			setPinned(next === "" ? null : next);
			setSelectedId(null);
			setDetail(null);
			setApplyMsg(null);
			setRewindPlan(null);
		}
	}, options.map((option) => (0, react.createElement)("option", {
		key: option.id,
		value: option.id
	}, sessionLabel(option)))), pinned !== null ? (0, react.createElement)("button", {
		className: "fu-linkbtn",
		title: "取消钉住，回到跟随当前查看的会话（平台推送）",
		onClick: () => {
			setPinned(null);
			setSelectedId(null);
		}
	}, "跟随当前会话") : null) : null, (0, react.createElement)("div", { className: "fu-body" }, (0, react.createElement)("div", { className: "fu-list" }, items === null && (0, react.createElement)("div", { className: "fu-empty" }, loadError ?? "加载中…"), items !== null && items.length === 0 && (0, react.createElement)("div", { className: "fu-empty" }, "暂无文件操作记录\nwrite / edit 执行后会出现在这里"), items !== null && items.length > 0 ? (() => {
		const groups = groupByFile(items);
		const dirSuffix = dirDisambiguators(groups);
		return groups.map((group) => {
			const isOpen = expandedFiles.has(group.filePath);
			const latest = group.entries[0];
			const dirTag = dirSuffix.get(group.filePath);
			return (0, react.createElement)("div", {
				key: group.filePath,
				className: "fu-group"
			}, (0, react.createElement)("div", {
				className: "fu-group-head",
				"data-open": isOpen ? "true" : "false",
				title: group.filePath,
				onClick: () => {
					setExpandedFiles((prev) => {
						const next = new Set(prev);
						if (next.has(group.filePath)) next.delete(group.filePath);
						else next.add(group.filePath);
						return next;
					});
					setSelectedId(latest.id);
				}
			}, (0, react.createElement)("span", { className: "fu-group-caret" }, isOpen ? "▾" : "▸"), (0, react.createElement)("span", { className: "fu-group-name" }, basename(group.filePath)), dirTag !== void 0 && dirTag !== "" ? (0, react.createElement)("span", {
				className: "fu-group-dir",
				title: group.filePath
			}, ` · ${dirTag}`) : null, (0, react.createElement)("span", { className: "fu-group-count" }, `${group.entries.length} 次`), (0, react.createElement)("span", { className: "fu-group-spacer" }), (0, react.createElement)("span", { className: "fu-group-stats" }, (0, react.createElement)("span", { className: "fu-stat-add" }, `+${group.added}`), (0, react.createElement)("span", { className: "fu-stat-del" }, `-${group.removed}`))), isOpen ? (0, react.createElement)("div", { className: "fu-group-items" }, group.entries.map((item) => (0, react.createElement)("div", {
				key: item.id,
				className: "fu-row",
				"data-selected": selectedId === item.id ? "true" : "false",
				"data-state": item.state,
				title: item.filePath,
				onClick: () => setSelectedId(item.id)
			}, (0, react.createElement)("div", { className: "fu-row-top" }, (0, react.createElement)("span", null, formatTime(item.time)), (0, react.createElement)("span", { className: "fu-row-cmd" }, item.op ?? item.command), (() => {
				if (item.turn === void 0) return null;
				const ops = item.turnOps ?? "?";
				return (0, react.createElement)("span", {
					className: "fu-round",
					title: `第 ${item.turn} 轮 · 第 ${item.step ?? "?"} 步 · 本轮共 ${ops} 次工具调用`
				}, `轮${item.turn}`);
			})(), item.state === "reverted" ? (0, react.createElement)("span", { className: "fu-row-undone" }, "已撤销") : null, item.state === "reapplied" ? (0, react.createElement)("span", { className: "fu-row-reapplied" }, "已重应用") : null, item.state === "aborted" ? (0, react.createElement)("span", { className: "fu-row-failed" }, "失败") : null, item.state === "noop" ? (0, react.createElement)("span", { className: "fu-row-noop" }, "无变化") : null), item.created ? (0, react.createElement)("div", { className: "fu-row-stats" }, (0, react.createElement)("span", { className: "fu-row-created" }, "新文件")) : item.hasAfter ? (0, react.createElement)("div", { className: "fu-row-stats" }, (0, react.createElement)("span", { className: "fu-stat-add" }, `+${item.added}`), (0, react.createElement)("span", { className: "fu-stat-del" }, `-${item.removed}`)) : (0, react.createElement)("div", { className: "fu-row-stats" }, (0, react.createElement)("span", null, "（改后状态未捕获）"))))) : null);
		});
	})() : null), (0, react.createElement)("div", { className: "fu-review" }, detailError !== null && (0, react.createElement)("div", { className: "fu-empty" }, detailError), detailError === null && detail === null && (0, react.createElement)("div", { className: "fu-empty" }, selectedId === null ? "选择左侧一条记录查看差异" : "加载差异…"), detail !== null && (0, react.createElement)("div", { style: {
		display: "flex",
		flexDirection: "column",
		flex: "1",
		minHeight: "0"
	} }, (0, react.createElement)("div", { className: "fu-review-head" }, (0, react.createElement)("span", {
		className: "fu-path",
		title: detail.item.filePath
	}, detail.item.filePath), detail.item.state === "aborted" ? (0, react.createElement)("span", { className: "fu-reverted-tag" }, "✕ 失败 · 未改动文件") : detail.item.state === "noop" ? (0, react.createElement)("span", { className: "fu-reverted-tag" }, "○ 无变化 · 未改动文件") : detail.item.state === "reverted" ? detail.preview.canReapply ? confirmState === "armed" ? (0, react.createElement)("div", { style: {
		display: "flex",
		gap: "6px"
	} }, (0, react.createElement)("button", {
		className: "fu-reapply-btn",
		"data-confirm": "true",
		onClick: () => void onReapplyClick(),
		title: (detail.revivable ?? 0) > 0 ? `将连带恢复被这次回退作废的 ${detail.revivable} 条后续操作` : "把这次操作的结果重新写回文件"
	}, (detail.revivable ?? 0) > 0 ? `确认重新应用（连带恢复 ${detail.revivable} 条）？` : "确认重新应用？"), (0, react.createElement)("button", {
		className: "fu-cancel-btn",
		onClick: () => setConfirmState("idle")
	}, "取消")) : (0, react.createElement)("button", {
		className: "fu-reapply-btn",
		disabled: confirmState === "applying",
		title: "把这次操作的结果重新写回文件（撤销的逆操作）",
		onClick: () => void onReapplyClick()
	}, confirmState === "applying" ? "应用中…" : "重新应用") : (0, react.createElement)("span", { className: "fu-reverted-tag" }, "✓ 已撤销") : confirmState === "armed" ? (0, react.createElement)("div", { style: {
		display: "flex",
		gap: "6px"
	} }, (0, react.createElement)("button", {
		className: "fu-undo-btn",
		"data-confirm": "true",
		onClick: () => void onUndoClick()
	}, detail.item.created ? "确认删除？" : "确认撤销？"), (0, react.createElement)("button", {
		className: "fu-cancel-btn",
		onClick: () => setConfirmState("idle")
	}, "取消")) : (0, react.createElement)("div", { style: {
		display: "flex",
		gap: "6px",
		alignItems: "center"
	} }, detail.item.state === "reapplied" ? (0, react.createElement)("span", { className: "fu-reverted-tag" }, "↻ 已重新应用") : null, (0, react.createElement)("button", {
		className: "fu-undo-btn",
		disabled: !detail.preview.canApply || confirmState === "applying",
		title: detail.item.created ? detail.preview.canApply ? "撤销创建 = 删除该文件（创建后未被修改才允许）" : "存在不能安全删除的原因（见下方提示）" : detail.item.state === "reapplied" ? detail.preview.canApply ? "撤销这次重新应用 — 把文件恢复到该次操作前的内容（可与重新应用来回切换）" : "存在不能安全撤销的原因（见下方提示）" : detail.preview.canApply ? "把文件恢复到这次操作之前的内容" : "存在不能安全撤销的原因（见下方提示）",
		onClick: () => void onUndoClick()
	}, confirmState === "applying" ? detail.item.created ? "删除中…" : "撤销中…" : detail.item.created ? "删除该文件" : "撤销此操作"), !detail.item.created ? (0, react.createElement)("button", {
		className: "fu-rewind-btn",
		disabled: rewindBusy,
		title: "把文件恢复到这次操作之前的内容，并丢弃其后的所有编辑（后续记录保留为日志）",
		onClick: () => void onRewindClick()
	}, "回退到此状态") : null)), detail.item.state === "aborted" ? (0, react.createElement)("div", {
		className: "fu-reason",
		"data-severity": "error"
	}, (0, react.createElement)("span", { className: "fu-reason-code" }, "failed"), (0, react.createElement)("span", null, `此操作失败，未改动任何文件${detail.item.failReason ? "：" + detail.item.failReason : ""}`)) : null, detail.item.state === "noop" ? (0, react.createElement)("div", { className: "fu-reason" }, (0, react.createElement)("span", { className: "fu-reason-code" }, "no_change"), (0, react.createElement)("span", null, "此调用成功执行但未产生实际改动（改后内容与改前完全一致），无需撤销")) : null, applyMsg !== null ? (0, react.createElement)("div", {
		className: "fu-reason",
		"data-severity": applyMsg.kind === "error" ? "error" : void 0
	}, applyMsg.text) : null, detail.preview.reasons.map((reason, i) => (0, react.createElement)("div", {
		key: `reason-${i}`,
		className: "fu-reason",
		"data-severity": reason.code === "file_creation" || reason.code === "already_reverted" ? "error" : void 0
	}, (0, react.createElement)("span", { className: "fu-reason-code" }, reason.code), (0, react.createElement)("span", null, REASON_COPY[reason.code] ?? reason.message))), (0, react.createElement)("div", { style: {
		display: "flex",
		gap: "10px",
		padding: "0 14px 6px",
		fontSize: "11px",
		flex: "none"
	} }, (0, react.createElement)("span", { className: "fu-stat-add" }, detail.item.created ? `+${detail.added} 新增` : `+${detail.added} 恢复`), detail.item.created ? null : (0, react.createElement)("span", { className: "fu-stat-del" }, `-${detail.removed} 移除`), detail.charDelta !== null ? (0, react.createElement)("span", {
		style: { color: "var(--dsw-alias-label-tertiary)" },
		title: "行数 = 变更行；Δ字符 = 改后长度 − 改前长度（净体积变化，压缩 JSON 等长行文件看这个）"
	}, `Δ${detail.charDelta >= 0 ? "+" : ""}${detail.charDelta} 字符`) : null, detail.preview.externalModified ? (0, react.createElement)("span", { style: { color: "var(--dsw-alias-state-warn-primary)" } }, "⚠ 文件已被外部修改") : null), rewindPlan !== null && rewindPlan.status === "stale_ledger" ? (0, react.createElement)("div", {
		className: "fu-reason",
		"data-severity": "error"
	}, (0, react.createElement)("span", { className: "fu-reason-code" }, "stale_ledger"), (0, react.createElement)("span", null, rewindPlan.message), (0, react.createElement)("button", {
		className: "fu-repair-btn",
		onClick: () => void onStaleLedgerRepair(),
		disabled: rewindBusy
	}, "补记状态")) : rewindPlan !== null && rewindPlan.status === "ok" ? (0, react.createElement)("div", { className: "fu-rewind-confirm" }, (0, react.createElement)("span", null, `回退到此状态（之后的 ${rewindPlan.invalidatedCount} 步将作废，仅保留为日志，无法单独恢复）`), (0, react.createElement)("div", { style: {
		display: "flex",
		gap: "6px",
		marginTop: "6px"
	} }, (0, react.createElement)("button", {
		className: "fu-undo-btn",
		"data-confirm": "true",
		onClick: () => void onRewindConfirm(),
		disabled: rewindBusy
	}, "确认回退"), (0, react.createElement)("button", {
		className: "fu-cancel-btn",
		onClick: () => setRewindPlan(null)
	}, "取消"))) : null, blankLine !== void 0 ? (0, react.createElement)("div", { className: "fu-reason fu-blankline" }, (0, react.createElement)("span", { className: "fu-reason-code" }, "blank_line"), (0, react.createElement)("span", null, `疑似留下空行：第 ${blankLine.line} 行由内容被清空（应删除整行而非清空内容）`), (0, react.createElement)("button", {
		className: "fu-copyfix-btn",
		onClick: () => void copyFixInstruction(blankLine.line)
	}, copiedLine === blankLine.line ? "✓ 已复制" : "复制修复指令")) : null, (0, react.createElement)(DiffView, {
		hunks: detail.hunks,
		emptyText: emptyDiffText(detail)
	})))), (0, react.createElement)("div", { className: "fu-foot" }, "清理", (0, react.createElement)("input", {
		className: "fu-days",
		type: "number",
		min: "1",
		value: pruneDays,
		onChange: (event) => setPruneDays(event.target.value)
	}), "天前的记录", (0, react.createElement)("button", {
		className: "fu-prune-btn",
		onClick: () => void onPrune()
	}, "清理"), footMsg !== null ? (0, react.createElement)("span", {
		className: "fu-foot-msg",
		"data-kind": footMsg.kind
	}, `${footMsg.kind === "ok" ? "✓ " : "✗ "}${footMsg.text}`) : null, (0, react.createElement)("span", { className: "fu-foot-hint" }, "撤销 = 将文件恢复到该次操作之前；记录跨会话保存在 ~/.dsh/file-undo/"))));
}
//#endregion
//#region src/client/index.tsx
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
const inject = ["slots"];
/** Tiny module-level store: pending (recorded) count shared by badge + panel. */
let pendingCount = 0;
const listeners = /* @__PURE__ */ new Set();
function publishCount(count) {
	pendingCount = count;
	for (const listener of listeners) listener();
}
function usePendingCount() {
	const [, force] = (0, react.useReducer)((x) => x + 1, 0);
	(0, react.useEffect)(() => {
		listeners.add(force);
		return () => {
			listeners.delete(force);
		};
	}, []);
	return pendingCount;
}
async function pollOnce() {
	try {
		const { items } = await api.history(getFollowedSessionId() ?? void 0);
		publishCount(items.filter((item) => item.state === "recorded").length);
	} catch {}
}
function UndoIcon() {
	return (0, react.createElement)("svg", {
		viewBox: "0 0 16 16",
		fill: "none",
		"aria-hidden": "true"
	}, (0, react.createElement)("path", {
		d: "M3 7h6.5a3.5 3.5 0 1 1 0 7H6",
		stroke: "currentColor",
		"stroke-width": "1.6",
		"stroke-linecap": "round",
		"stroke-linejoin": "round"
	}), (0, react.createElement)("path", {
		d: "M5.5 4.5 3 7l2.5 2.5",
		stroke: "currentColor",
		"stroke-width": "1.6",
		"stroke-linecap": "round",
		"stroke-linejoin": "round"
	}));
}
function EntryButton(props) {
	const [open, setOpen] = (0, react.useState)(false);
	const count = usePendingCount();
	(0, react.useEffect)(() => {
		pollOnce();
		const timer = setInterval(() => void pollOnce(), 6e4);
		return () => clearInterval(timer);
	}, []);
	(0, react.useEffect)(() => {
		if (open) pollOnce();
	}, [open]);
	return (0, react.createElement)("div", { className: "fu-root" }, (0, react.createElement)("button", {
		className: "fu-entry",
		"data-open": open ? "true" : "false",
		"aria-label": "文件撤销历史",
		"aria-expanded": open,
		title: "文件撤销历史",
		onClick: () => setOpen((prev) => !prev)
	}, (0, react.createElement)(UndoIcon), count > 0 ? (0, react.createElement)("span", { className: "fu-entry-badge" }, count > 99 ? "99+" : String(count)) : null, props.wide === true ? (0, react.createElement)("span", { className: "fu-entry-label" }, "撤销") : null), open ? (0, react.createElement)(UndoPanel, { onClose: () => setOpen(false) }) : null);
}
function apply(ctx) {
	try {
		injectStyles();
	} catch (error) {
		console.warn("[file-undo] injectStyles failed (degraded, unstyled):", error);
	}
	try {
		startFollowing(ctx);
	} catch (error) {
		console.warn("[file-undo] startFollowing failed (degraded, no follow):", error);
	}
	try {
		ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
			name: "sidebar.footer.action",
			id: "file-undo",
			order: 101,
			label: "文件撤销历史"
		}, EntryButton));
	} catch (error) {
		console.warn("[file-undo] sidebar.footer.action registration failed (degraded, no entry button):", error);
	}
}
//#endregion
exports.apply = apply;
exports.inject = inject;

    return module.exports;
  }
});