import { cachedStructuredDiff, diffStats } from "./diff.js";
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
//#region src/store.ts
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
/** Default retention for snapshot pruning, in days. */
const DEFAULT_PRUNE_DAYS = 7;
function storeRoot() {
	return join(homedir(), ".dsh", "file-undo");
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
function canonicalCwd(cwd) {
	const trimmed = cwd.trim();
	if (trimmed === "") return trimmed;
	const win = process.platform === "win32";
	const sep = win ? "\\" : "/";
	const unified = trimmed.replace(/[/\\]+/g, sep);
	let prefix = "";
	let body = unified;
	if (win) {
		if (body.startsWith("\\\\")) {
			prefix = "\\\\";
			body = body.slice(2);
		}
	} else if (body.startsWith(sep)) {
		prefix = sep;
		body = body.slice(1);
	}
	const stack = [];
	for (const part of body.split(sep)) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (stack.length > 0 && stack[stack.length - 1] !== "..") stack.pop();
			continue;
		}
		stack.push(part);
	}
	let out = prefix + stack.join(sep);
	if (win) {
		if (/^[a-zA-Z]:$/.test(out)) out += sep;
		if (/^[a-zA-Z]:/.test(out)) out = out[0].toUpperCase() + out.slice(1);
	} else if (out === "") out = sep;
	if (out === "" && trimmed.startsWith(sep)) out = sep;
	return out;
}
/**
* Whether a path designates a filesystem root — a boundary that must never
* swallow unrelated projects into one "workspace".
*/
function isFilesystemRoot(dir) {
	if (process.platform === "win32") return dir === "\\" || /^[a-zA-Z]:\\?$/.test(dir) || /^\\\\[^\\]+\\?$/.test(dir) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(dir);
	return dir === "/" || dir === homedir();
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
function sameWorkspaceTree(a, b) {
	return isSameTree(canonicalCwd(a), canonicalCwd(b));
}
/** Containment on canonical paths, excluding filesystem roots. */
function isSameTree(ca, cb) {
	if (ca === "" || cb === "") return false;
	if (ca === cb) return true;
	const [ancestor, descendant] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
	if (isFilesystemRoot(ancestor)) return false;
	const sep = process.platform === "win32" ? "\\" : "/";
	const stem = ancestor.endsWith(sep) ? ancestor : ancestor + sep;
	return descendant.startsWith(stem);
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
async function selectWorkspaceMembers(anchorCwd, candidates) {
	const anchor = canonicalCwd(anchorCwd);
	if (anchor === "") return [];
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const candidate of candidates) {
		const canonical = canonicalCwd(candidate);
		if (canonical === "" || seen.has(canonical)) continue;
		seen.add(canonical);
		if (isSameTree(anchor, canonical)) out.push(candidate);
	}
	return out;
}
/**
* Sanitize a cwd into a filesystem-safe directory name (collision-hardened).
*
* The IDENTITY is the hash suffix, computed over the CANONICAL directory —
* the readable prefix is cosmetic and stays lossy on purpose (non-ASCII
* directory names are still collapsed to '_', which is why two sibling
* directories can share a prefix and differ only by suffix).
*/
function workspaceKeyOf(cwd) {
	const canonical = canonicalCwd(cwd);
	let key = canonical.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
	if (key === "") key = "default";
	const chars = [...key];
	if (chars.length > 64) key = chars.slice(0, 64).join("");
	const digest = createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 8);
	return `${key}~${digest}`;
}
function scopeDir(scope) {
	return join(storeRoot(), scope.workspaceKey, scope.chatKey);
}
function snapshotPath(scope) {
	return join(scopeDir(scope), "snapshots.jsonl");
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
async function recoverActiveScope() {
	let workspaceKeys;
	try {
		workspaceKeys = await readdir(storeRoot(), { withFileTypes: true }).then((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name));
	} catch {
		return;
	}
	let best;
	for (const workspaceKey of workspaceKeys) {
		let chatKeys;
		try {
			chatKeys = await readdir(join(storeRoot(), workspaceKey), { withFileTypes: true }).then((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name));
		} catch {
			continue;
		}
		for (const chatKey of chatKeys) {
			const path = join(storeRoot(), workspaceKey, chatKey, "snapshots.jsonl");
			try {
				const info = await stat(path);
				if (best === void 0 || info.mtimeMs > best.mtimeMs) best = {
					scope: {
						workspaceKey,
						chatKey
					},
					mtimeMs: info.mtimeMs
				};
			} catch {}
		}
	}
	return best?.scope;
}
/** Temp path used by the locked rewrite (atomic rename keeps readers safe). */
function stagingPath(scope) {
	return join(scopeDir(scope), "snapshots.jsonl.tmp");
}
function sha256(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
/** Serializes every store mutation that is not a pure append. */
let writeChain = Promise.resolve();
/**
* Run `task` exclusively among locked mutations; failures never poison the chain.
* Generic so a locked task can hand a value back to its caller (see
* `markRevertedBatch`, which returns the number of rows it actually marked).
*/
function withLock(task) {
	const run = writeChain.then(task);
	writeChain = run.then(() => void 0, () => void 0);
	return run;
}
async function ensureDir(scope) {
	await mkdir(scopeDir(scope), { recursive: true });
}
/** Mint a stable id for a snapshot that predates the v2 format. */
function legacyId(time, index) {
	return `${time}-legacy${index}`;
}
/** Normalize one parsed JSONL line into a v2 snapshot. */
function normalize(raw, index) {
	if (typeof raw.filePath !== "string" || typeof raw.command !== "string") return void 0;
	const time = typeof raw.time === "number" && raw.time > 0 ? raw.time : -1;
	const before = typeof raw.before === "string" ? raw.before : null;
	const after = typeof raw.after === "string" ? raw.after : null;
	const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : legacyId(time, index);
	const state = raw.state === "reverted" ? "reverted" : raw.state === "reapplied" ? "reapplied" : raw.state === "aborted" ? "aborted" : raw.state === "noop" ? "noop" : "recorded";
	const op = typeof raw.op === "string" && raw.op !== "" ? raw.op : void 0;
	const callId = typeof raw.callId === "string" && raw.callId !== "" ? raw.callId : void 0;
	const failReason = typeof raw.failReason === "string" && raw.failReason !== "" ? raw.failReason : void 0;
	const rootCallId = typeof raw.rootCallId === "string" && raw.rootCallId !== "" ? raw.rootCallId : callId !== void 0 ? callId : id;
	const revertReason = raw.revertReason === "direct" ? "direct" : raw.revertReason === "cascade" ? "cascade" : raw.revertReason === void 0 && state === "reverted" ? "direct" : void 0;
	const cascadeOf = typeof raw.cascadeOf === "string" && raw.cascadeOf !== "" ? raw.cascadeOf : void 0;
	return {
		id,
		filePath: raw.filePath,
		command: raw.command,
		...op !== void 0 ? { op } : {},
		...callId !== void 0 ? { callId } : {},
		...failReason !== void 0 ? { failReason } : {},
		before,
		beforeHash: before === null ? null : typeof raw.beforeHash === "string" ? raw.beforeHash : sha256(before),
		after,
		afterHash: after === null ? null : typeof raw.afterHash === "string" ? raw.afterHash : sha256(after),
		time,
		state,
		...rootCallId !== void 0 ? { rootCallId } : {},
		...revertReason !== void 0 ? { revertReason } : {},
		...cascadeOf !== void 0 ? { cascadeOf } : {}
	};
}
/** Parse and normalize every line; malformed lines are skipped (not fatal). */
async function loadSnapshots(scope) {
	let text;
	try {
		text = await readFile(snapshotPath(scope), "utf8");
	} catch {
		return [];
	}
	const out = [];
	let index = 0;
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const snap = normalize(JSON.parse(line), index);
			if (snap !== void 0) out.push(snap);
		} catch {}
		index += 1;
	}
	return out;
}
/** Rewrite the whole store behind the write lock (atomic tmp+rename). */
async function saveAllLocked(scope, all) {
	await ensureDir(scope);
	await writeFile(stagingPath(scope), all.map((s) => `${JSON.stringify(s)}\n`).join(""), "utf8");
	await rename(stagingPath(scope), snapshotPath(scope));
}
/** Append one snapshot (append-only: safe under concurrent tool calls). */
async function appendSnapshot(scope, snapshot) {
	await ensureDir(scope);
	await appendFile(snapshotPath(scope), `${JSON.stringify(snapshot)}\n`, "utf8");
}
/** Rewrite the store under the lock with the caller's full list. */
function rewriteStore(scope, all) {
	return withLock(() => saveAllLocked(scope, all));
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
async function backfillAfter(scope, filePath, after, callId, rootCallId) {
	try {
		await withLock(async () => {
			const all = await loadSnapshots(scope);
			let target;
			if (callId !== void 0 && callId !== "") target = all.find((s) => s.callId === callId);
			else target = all.find((s) => s.filePath === filePath && s.after === null && s.afterHash === null);
			if (target === void 0) return;
			if (rootCallId !== void 0 && rootCallId !== "" && target.rootCallId !== rootCallId) target.rootCallId = rootCallId;
			if (after !== null && target.before !== null && target.before === after) {
				target.after = after;
				target.afterHash = sha256(after);
				target.state = "noop";
				target.failReason = "此次调用未产生实际改动（改后内容与改前完全一致）";
				await saveAllLocked(scope, all);
				return;
			}
			if (after !== null || target.after === null) {
				target.after = after;
				target.afterHash = after === null ? null : sha256(after);
				await saveAllLocked(scope, all);
			}
		});
	} catch (error) {
		console.error("[file-undo] backfill failed:", error);
	}
}
/**
* Mark the pre snapshot of a FAILED tool call as aborted (post-execute saw
* isError): the call never wrote anything, so the row carries no undo value.
* Aborted rows stay in the file (no data loss) but every listing hides them.
*/
async function markAbortedByCall(scope, callId, failReason) {
	try {
		await withLock(async () => {
			const all = await loadSnapshots(scope);
			const target = all.find((s) => s.callId === callId);
			if (target === void 0 || target.state !== "recorded" || target.after !== null) return;
			target.state = "aborted";
			target.failReason = failReason;
			await saveAllLocked(scope, all);
		});
	} catch (error) {
		console.error("[file-undo] abort-mark failed:", error);
	}
}
/** Failed calls (post-execute isError): visible as failure-log rows, never undoable. */
function isAbortedSnapshot(s) {
	return s.state === "aborted";
}
/** Successful calls that changed nothing: visible as 无变化 log rows, never undoable. */
function isNoopSnapshot(s) {
	return s.state === "noop";
}
/** Set the lifecycle state of one snapshot under the lock. */
async function markState(scope, id, state) {
	await withLock(async () => {
		const all = await loadSnapshots(scope);
		const target = all.find((s) => s.id === id);
		if (target === void 0) return;
		target.state = state;
		await saveAllLocked(scope, all);
	});
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
async function markRevertedBatch(scope, entries, opts = {}) {
	if (entries.length === 0) return 0;
	return withLock(async () => {
		const all = await loadSnapshots(scope);
		const byId = new Map(entries.map((e) => [e.id, e]));
		const allow = new Set(opts.allowStates ?? ["recorded", "reapplied"]);
		let changed = 0;
		for (const s of all) {
			const mark = byId.get(s.id);
			if (mark !== void 0 && allow.has(s.state)) {
				s.state = "reverted";
				s.revertReason = mark.reason;
				if (mark.cascadeOf !== void 0) s.cascadeOf = mark.cascadeOf;
				changed += 1;
			}
		}
		if (changed > 0) await saveAllLocked(scope, all);
		return changed;
	});
}
/**
* Mark one snapshot reverted (state badge) under the lock.
* 4.1 落地 1（v7.0）：改走批量版 —— 任何进入 `reverted` 的条目必带 `revertReason`
* （不变式 I1），否则 Reapply 的白名单判据会把缺 reason 的行一律拒为
* `unknown_revert`（fail-closed，这正是 I1 想堵的诈尸入口）。
*/
async function markReverted(scope, id) {
	await markRevertedBatch(scope, [{
		id,
		reason: "direct"
	}]);
}
/** Mark one snapshot reapplied (after an undo, the after-state was written back). */
async function markReapplied(scope, id) {
	await markState(scope, id, "reapplied");
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
async function markReappliedBatch(scope, ids, opts = {}) {
	if (ids.length === 0) return 0;
	return withLock(async () => {
		const all = await loadSnapshots(scope);
		const wanted = new Set(ids);
		const allow = new Set(opts.allowStates ?? ["reverted"]);
		let changed = 0;
		for (const s of all) if (wanted.has(s.id) && allow.has(s.state)) {
			s.state = "reapplied";
			delete s.revertReason;
			delete s.cascadeOf;
			changed += 1;
		}
		if (changed > 0) await saveAllLocked(scope, all);
		return changed;
	});
}
/**
* Drop snapshots older than `days` and rewrite the store with the survivors.
* This only shrinks undo history (how far back /undo can reach); it never
* touches current file contents. Unknown-age rows (time < 0, legacy data)
* are kept — conservative: unknown-age data is never deleted.
*/
async function pruneSnapshots(scope, days) {
	const all = await loadSnapshots(scope);
	if (all.length === 0) return "没有可清理的记录（存储为空）";
	const cutoff = Date.now() - days * 864e5;
	const kept = all.filter((s) => typeof s.time !== "number" || s.time < 0 || s.time >= cutoff);
	const removed = all.length - kept.length;
	if (removed === 0) return `没有可清理的记录：全部 ${all.length} 条都在 ${days} 天内`;
	await rewriteStore(scope, kept);
	return `已清理 ${removed} 条超过 ${days} 天的记录，保留 ${kept.length} 条`;
}
/**
* Cache key: scope prefix + snapshot id (ids are only unique within one
* store; two chats can mint the same `<time>-<seq>` id).
*/
const statsCache = /* @__PURE__ */ new Map();
function statsCacheKey(scope, id) {
	return `${scope.workspaceKey}/${scope.chatKey}/${id}`;
}
/**
* +N/-N stats of one snapshot for list rows. Cached per id but keyed on
* `afterHash`: a post-execute backfill changes the hash, so a stale entry
* (computed while `after` was still null) self-invalidates — no cross-module
* invalidation call can be forgotten.
*/
function snapshotStats(scope, snapshot) {
	const key = statsCacheKey(scope, snapshot.id);
	const cached = statsCache.get(key);
	if (cached !== void 0 && cached.afterHash === snapshot.afterHash) return {
		added: cached.added,
		removed: cached.removed
	};
	let stats = {
		added: 0,
		removed: 0
	};
	if (snapshot.before === null && snapshot.after !== null) stats = {
		added: countContentLines(snapshot.after),
		removed: 0
	};
	else if (snapshot.before !== null && snapshot.after !== null && snapshot.before !== snapshot.after) stats = diffStats(cachedStructuredDiff(snapshot.after, snapshot.before));
	statsCache.set(key, {
		afterHash: snapshot.afterHash,
		added: stats.added,
		removed: stats.removed
	});
	return stats;
}
/** Count content lines the way diff would (trailing newline is not a line). */
function countContentLines(content) {
	if (content === "") return 0;
	return content.replace(/\n$/, "").split("\n").length;
}
//#endregion
export { DEFAULT_PRUNE_DAYS, appendSnapshot, backfillAfter, canonicalCwd, isAbortedSnapshot, isNoopSnapshot, loadSnapshots, markAbortedByCall, markReapplied, markReappliedBatch, markReverted, markRevertedBatch, pruneSnapshots, recoverActiveScope, rewriteStore, sameWorkspaceTree, scopeDir, selectWorkspaceMembers, sha256, snapshotPath, snapshotStats, workspaceKeyOf };
