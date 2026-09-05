import { cachedStructuredDiff, diffStats } from "./diff.js";
import { loadSnapshots, markReappliedBatch, markReverted, markRevertedBatch, pruneSnapshots, selectWorkspaceMembers, sha256, snapshotPath, snapshotStats, workspaceKeyOf } from "./store.js";
import { existsSync } from "node:fs";
//#region src/api.ts
/** ApiError carries an HTTP-ish code and a user-facing message. */
var ApiError = class extends Error {
	status;
	code;
	constructor(code, message, status = 400) {
		super(message);
		this.code = code;
		this.status = status;
	}
};
/** Pull the title text out of one batch observation, or undefined. */
function titleFromObservation(result) {
	if (result === void 0) return void 0;
	if (result.status !== "fulfilled") return void 0;
	const title = result.value?.title?.title;
	return typeof title === "string" && title !== "" ? title : void 0;
}
/**
* Cache keyed by session id. The raw log is append-only and `tool/call`
* payloads never change, so an ingested mapping stays valid forever;
* incremental polls cost one lightweight listEvents plus one small readEvent
* per NEW call. Bounded in practice: one entry per session, one map entry
* per tool call.
*/
const turnIndexes = /* @__PURE__ */ new Map();
function ingestCallEvent(index, event) {
	const data = event?.data;
	const turn = data?.turn;
	const step = data?.step;
	const callId = data?.callId;
	if (typeof turn !== "number" || typeof step !== "number" || typeof callId !== "string" || callId === "") return;
	if (index.byCall.has(callId)) return;
	index.byCall.set(callId, {
		turn,
		step
	});
	index.perTurn.set(turn, (index.perTurn.get(turn) ?? 0) + 1);
}
/**
* Build or incrementally extend the callId→turn index for one session.
* Returns undefined whenever the seam misbehaves — turn enrichment is
* optional and must never fail history rendering.
*/
async function turnIndexFor(sq, sessionId) {
	try {
		let index = turnIndexes.get(sessionId);
		if (index === void 0) {
			const snapshot = await sq.readSession?.(sessionId);
			if (snapshot === void 0) return void 0;
			index = {
				byCall: /* @__PURE__ */ new Map(),
				perTurn: /* @__PURE__ */ new Map(),
				throughSeq: 0
			};
			for (const event of snapshot.events ?? []) {
				if (typeof event?.seq === "number" && event.seq > index.throughSeq) index.throughSeq = event.seq;
				if (event?.type === "tool/call") ingestCallEvent(index, event);
			}
			turnIndexes.set(sessionId, index);
			return index;
		}
		const records = await sq.listEvents?.(sessionId);
		if (records === void 0) return index;
		const pending = [];
		for (const record of records) {
			const seq = typeof record?.seq === "number" ? record.seq : 0;
			if (seq <= index.throughSeq) continue;
			index.throughSeq = seq;
			if (record?.type === "tool/call") pending.push(seq);
		}
		for (const seq of pending) {
			const window = await sq.readEvent?.({
				sessionId,
				seq
			});
			if (window?.target?.type === "tool/call") ingestCallEvent(index, window.target);
		}
		return index;
	} catch {
		return;
	}
}
function toHistoryItem(scope, snapshot, turnInfo) {
	const stats = snapshotStats(scope, snapshot);
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
		...snapshot.rootCallId !== void 0 ? { rootCallId: snapshot.rootCallId } : {},
		...turnInfo !== void 0 ? {
			turn: turnInfo.turn,
			step: turnInfo.step,
			turnOps: turnInfo.turnOps
		} : {}
	};
}
/** Read the live file content through the official fs service. */
/**
* Git-style new-file diff: every content line is an addition, single hunk
* starting at line 1 of the (nonexistent) old side.
*/
function newFileHunks(after) {
	const lines = (after === "" ? [] : after.replace(/\n$/, "").split("\n")).map((line) => `+${line}`);
	if (lines.length === 0) return [];
	return [{
		oldStart: 0,
		oldLines: 0,
		newStart: 1,
		newLines: lines.length,
		lines
	}];
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
function detectBlankLineArtifact(before, after) {
	if (before === null || after === null) return null;
	const b = contentLines(before);
	const a = contentLines(after);
	if (b.length !== a.length) return null;
	for (let i = 0; i < a.length; i++) if (b[i] !== "" && a[i] === "") return { line: i + 1 };
	return null;
}
/** 行拆分（与 diff.ts 同语义）：trailing newline 不算一行。 */
function contentLines(text) {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}
/**
* Delete a file for a creation-undo. Prefers an fs-service delete when a
* backend ever grows one; the official fs has none (resolve/stat/read/
* write only), so this falls back to node fs in the host process — the same
* explicit-escape rationale as the danger-full-access write (P3). ENOENT is
* success (idempotent undo of an already-removed creation).
*/
async function removeFile(ctx, target) {
	const fsAny = ctx.fs;
	if (typeof fsAny.unlink === "function") {
		await fsAny.unlink(target);
		return;
	}
	const { unlink } = await import("node:fs/promises");
	try {
		await unlink(String(target.targetKey));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}
async function readCurrent(ctx, filePath) {
	try {
		const target = await ctx.fs.resolve(filePath);
		return await ctx.fs.readText(target);
	} catch {
		return null;
	}
}
/**
* 2.1 blocking conditions — all six carry an error code, because the client's
* `UndoReason` union is closed and has nothing to map an unnamed rejection to.
*
* Declared as a type assertion so callers get `before`/`after` narrowed to
* `string` afterwards (both are `string | null` on the row type).
*/
function assertRewindTarget(target) {
	if (target.state === "aborted") throw new ApiError("aborted_op", "该操作失败且从未改动文件，无法回退。");
	if (target.state === "noop") throw new ApiError("noop_op", "该操作未产生实际改动，无法回退。");
	if (target.state === "reverted") throw new ApiError("already_reverted", "该操作已撤销过。");
	if (target.before === null) throw new ApiError("creation_rewind_unsupported", "暂不支持级联撤销创建操作。请先逆序撤销其后的条目，再对本条使用单条撤销。");
	if (target.after === null) throw new ApiError("unsupported_checkpoint", "该快照未捕获改后状态，无法定位链条终点。");
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
function findLaterOps(all, target) {
	const idx = all.findIndex((s) => s.id === target.id);
	if (idx === -1) return [];
	return all.slice(idx + 1).filter((s) => s.filePath === target.filePath && ![
		"aborted",
		"noop",
		"reverted"
	].includes(s.state));
}
/**
* Build the chain after `target` (定稿 2.1).
*
* Returns BOTH shapes on purpose: the mesh check needs the unfiltered tail to
* tell a legal discontinuity (our own undo moved the disk) from an illegal one
* (someone edited the file between two snapshots).
*/
function buildRewindChain(all, target) {
	const idx = all.findIndex((s) => s.id === target.id);
	if (idx === -1) throw new ApiError("snapshot_missing", `no snapshot with id "${target.id}"`, 404);
	const entriesAfter = all.slice(idx + 1).filter((s) => s.filePath === target.filePath);
	const validChain = [];
	for (const s of entriesAfter) {
		if (s.state === "aborted" || s.state === "noop" || s.state === "reverted") continue;
		if (s.after === null) throw new ApiError("unsupported_checkpoint", "链条中存在未捕获改后状态的旧条目。");
		validChain.push({
			...s,
			after: s.after
		});
	}
	return {
		validChain,
		entriesAfter
	};
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
function assertChainContinuity(target, entriesAfter) {
	let baseline = target.afterHash;
	let lastDirectBefore = null;
	for (const s of entriesAfter) {
		if (s.state === "aborted" || s.state === "noop") continue;
		if (s.state === "reverted") {
			if (s.revertReason === "cascade") {
				if (lastDirectBefore !== null) baseline = lastDirectBefore;
			} else {
				baseline = s.beforeHash;
				lastDirectBefore = s.beforeHash;
			}
			continue;
		}
		if (baseline !== null && s.beforeHash !== null && baseline !== s.beforeHash) throw new ApiError("external_modified", "链条中间存在未被快照记录的外部改动，已阻断回退。", 409);
		baseline = s.afterHash;
	}
}
/**
* Read-only precheck for a rewind to `target` (定稿 2.2). Never writes anything.
* `all` is passed in so preview and apply share one load and one code path.
*/
async function previewRewindTo(ctx, all, target) {
	assertRewindTarget(target);
	const { validChain, entriesAfter } = buildRewindChain(all, target);
	const currentFileContent = await readCurrent(ctx, target.filePath);
	if (currentFileContent !== (validChain.length > 0 ? validChain[validChain.length - 1].after : target.after)) {
		if (currentFileContent === target.before && target.state === "recorded") return {
			status: "stale_ledger",
			message: "检测到已撤销但未标记，是否补记？",
			filePath: target.filePath,
			id: target.id,
			invalidatedCount: validChain.length
		};
		throw new ApiError("external_modified", "链条外存在外部改动，快照已失效。", 409);
	}
	assertChainContinuity(target, entriesAfter);
	return {
		status: "ok",
		filePath: target.filePath,
		id: target.id,
		invalidatedCount: validChain.length,
		contentToWrite: target.before,
		idsToMark: [target.id, ...validChain.map((s) => s.id)],
		expectedCurrentHash: sha256(currentFileContent)
	};
}
/** The read-only precheck over one snapshot (never writes anything). */
async function previewUndo(ctx, all, snapshot) {
	const reasons = [];
	if (snapshot.state === "noop") return {
		canApply: false,
		canReapply: false,
		externalModified: false,
		currentHash: null,
		currentExists: false,
		reasons
	};
	if (snapshot.state === "reverted") {
		reasons.push({
			code: "already_reverted",
			message: "This operation was already undone."
		});
		return {
			canApply: false,
			canReapply: snapshot.after !== null,
			externalModified: false,
			currentHash: null,
			currentExists: false,
			reasons
		};
	}
	if (snapshot.before === null) {
		if (snapshot.command === "write" || snapshot.op === "create") {
			if (snapshot.after === null) reasons.push({
				code: "file_creation",
				message: "Creation whose content was never captured — a delete cannot be verified as safe."
			});
		} else reasons.push({
			code: "no_before",
			message: "Legacy snapshot without a recorded before-state; there is nothing to restore to."
		});
	}
	const current = await readCurrent(ctx, snapshot.filePath);
	if (current === null) {
		if (snapshot.before !== null) reasons.push({
			code: "file_missing",
			message: "The file no longer exists on disk."
		});
		return {
			canApply: reasons.length === 0,
			canReapply: snapshot.before === null && snapshot.after !== null,
			externalModified: false,
			currentHash: null,
			currentExists: false,
			reasons
		};
	}
	const currentHash = sha256(current);
	if (snapshot.state === "recorded" && snapshot.beforeHash !== null && currentHash === snapshot.beforeHash) return {
		canApply: false,
		canReapply: false,
		externalModified: false,
		currentHash,
		currentExists: true,
		reasons,
		status: "stale_ledger",
		message: "检测到已撤销但未标记，是否补记？"
	};
	let externalModified = false;
	if (snapshot.afterHash !== null && snapshot.afterHash !== currentHash) {
		externalModified = true;
		const laterOps = findLaterOps(all, snapshot);
		if (laterOps.length > 0) reasons.push({
			code: "superseded_by_later_ops",
			message: `此操作之后还有 ${laterOps.length} 次编辑，无法单独撤销本条。继续将连同这 ${laterOps.length} 步一起撤销。`
		});
		else reasons.push({
			code: "external_modified",
			message: "The file changed after this operation (external edit or a later write). Undoing now would discard those changes."
		});
	} else if (snapshot.afterHash === null && snapshot.before !== null && snapshot.before !== current) reasons.push({
		code: "unknown_state",
		message: "No after-state was captured for this snapshot; the file differs from the recorded before-state. Verify the diff before undoing."
	});
	return {
		canApply: reasons.length === 0,
		canReapply: false,
		externalModified,
		currentHash,
		currentExists: true,
		reasons
	};
}
/** Validate and return the `id` field of a request payload. */
function requireId(payload) {
	const id = payload.id;
	if (typeof id !== "string" || id === "") throw new ApiError("bad-request", "missing or invalid \"id\"");
	return id;
}
/** Build the method table mounted under POST /file-undo/api/<method>. */
function buildApi(ctx, getScope, getSessionQuery) {
	/** The active store scope, or an error the client can surface. */
	const requireScope = () => {
		const scope = getScope();
		if (scope === void 0) throw new ApiError("no-active-scope", "no session has produced file operations yet — run a write/edit first", 409);
		return scope;
	};
	const MIN_DIRECTORY_AGE_MS = 2e3;
	const dirById = /* @__PURE__ */ new Map();
	let directoryAt = 0;
	let warnedNoTitleSeam = false;
	const seamUsable = () => typeof getSessionQuery?.()?.listSessions === "function";
	const refreshDirectory = async () => {
		const list = await getSessionQuery?.()?.listSessions?.();
		if (list === void 0) return;
		dirById.clear();
		for (const record of list) {
			const id = record?.header?.id;
			const cwd = record?.header?.cwd;
			if (typeof id === "string" && id !== "" && typeof cwd === "string" && cwd !== "") dirById.set(id, {
				cwd,
				live: record?.live === true
			});
		}
		const seam = getSessionQuery?.();
		const readTitlesBatch = typeof seam?.readTitleSnapshots === "function" ? seam.readTitleSnapshots.bind(seam) : void 0;
		const readTitleSingle = typeof seam?.readTitle === "function" ? seam.readTitle.bind(seam) : void 0;
		const ids = [...dirById.keys()];
		if (readTitlesBatch !== void 0) try {
			const results = await readTitlesBatch(ids);
			if (results !== void 0) for (const result of results) {
				const id = result?.sessionId;
				const entry = typeof id === "string" ? dirById.get(id) : void 0;
				if (entry === void 0) continue;
				const title = titleFromObservation(result);
				if (title !== void 0) entry.title = title;
			}
		} catch {}
		else if (readTitleSingle === void 0) {
			if (!warnedNoTitleSeam) {
				warnedNoTitleSeam = true;
				console.warn("[file-undo] 会话切换器：当前 host 的 ctx.sessionQuery 未提供 readTitleSnapshots / readTitle，条目回退为「<目录名> · <短 id>」");
			}
		} else await Promise.all(ids.map(async (id) => {
			try {
				const title = (await readTitleSingle(id))?.title;
				if (typeof title === "string" && title !== "") {
					const entry = dirById.get(id);
					if (entry !== void 0) entry.title = title;
				}
			} catch {}
		}));
		directoryAt = Date.now();
	};
	/**
	* cwd of one session; refreshes the directory on a miss (rate-limited).
	* REJECTS when the seam itself is broken — the caller decides whether that
	* means "refuse the claim" or "degrade to the active scope".
	*/
	const cwdOfSession = async (sessionId) => {
		const hit = dirById.get(sessionId);
		if (hit !== void 0) return hit.cwd;
		if (Date.now() - directoryAt < MIN_DIRECTORY_AGE_MS) return void 0;
		await refreshDirectory();
		return dirById.get(sessionId)?.cwd;
	};
	/**
	* Scope for one request: an explicit, VERIFIED `sessionId` wins over the
	* host's active scope. When the seam cannot confirm the claim the request
	* falls back to the active scope — today's behaviour, never worse.
	*/
	const scopeFor = async (payload) => {
		const requested = payload?.sessionId;
		if (typeof requested === "string" && requested !== "") {
			if (!seamUsable()) return requireScope();
			let cwd;
			let seamFailed = false;
			try {
				cwd = await cwdOfSession(requested);
			} catch {
				seamFailed = true;
			}
			if (seamFailed) return requireScope();
			if (cwd === void 0) throw new ApiError("unknown-session", `session "${requested}" is not visible to this host`, 404);
			return {
				workspaceKey: workspaceKeyOf(cwd),
				chatKey: requested
			};
		}
		return requireScope();
	};
	const findSnapshot = async (scope, payload) => {
		const id = requireId(payload);
		const snapshot = (await loadSnapshots(scope)).find((s) => s.id === id);
		if (snapshot === void 0) throw new ApiError("snapshot_missing", `no snapshot with id "${id}"`, 404);
		return snapshot;
	};
	/**
	* findSnapshot + the full list in one load: the 3.1 superseded split needs
	* `all` (later-ops evidence), so the handlers that run it must not load
	* the store twice.
	*/
	const loadAndFind = async (scope, payload) => {
		const id = requireId(payload);
		const all = await loadSnapshots(scope);
		const snapshot = all.find((s) => s.id === id);
		if (snapshot === void 0) throw new ApiError("snapshot_missing", `no snapshot with id "${id}"`, 404);
		return {
			all,
			snapshot
		};
	};
	/**
	* Session-log turn index for the active session. Undefined whenever the
	* seam is absent or misbehaves — enrichment only, never a failure.
	*/
	const turnIndexOfScope = async (scope) => {
		const sq = getSessionQuery?.();
		if (sq === void 0) return void 0;
		return turnIndexFor(sq, scope.chatKey);
	};
	const turnInfoOf = (index, snapshot) => {
		if (index === void 0 || snapshot.callId === void 0) return void 0;
		const hit = index.byCall.get(snapshot.callId);
		if (hit === void 0) return void 0;
		return {
			turn: hit.turn,
			step: hit.step,
			turnOps: index.perTurn.get(hit.turn) ?? 0
		};
	};
	return {
		/** Which store the panel is bound to (workspace × chat). */
		context: async () => {
			const scope = getScope();
			return {
				active: scope !== void 0,
				scope: scope !== void 0 ? {
					workspaceKey: scope.workspaceKey,
					chatKey: scope.chatKey
				} : null
			};
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
		sessions: async (payload) => {
			const current = getScope();
			if (!seamUsable()) return {
				available: false,
				currentId: current?.chatKey ?? null,
				items: []
			};
			let scope;
			try {
				scope = await scopeFor(payload);
			} catch {
				return {
					available: false,
					currentId: current?.chatKey ?? null,
					items: []
				};
			}
			const anchorCwd = await cwdOfSession(scope.chatKey).catch(() => void 0);
			if (anchorCwd === void 0) return {
				available: false,
				currentId: scope.chatKey,
				items: []
			};
			const entries = [...dirById.entries()].map(([id, meta]) => ({
				id,
				...meta
			}));
			const members = new Set(await selectWorkspaceMembers(anchorCwd, entries.map((e) => e.cwd)));
			const items = [];
			for (const entry of entries) {
				if (!members.has(entry.cwd)) continue;
				const option = {
					id: entry.id,
					cwd: entry.cwd,
					current: entry.id === scope.chatKey,
					live: entry.live,
					hasRecords: existsSync(snapshotPath({
						workspaceKey: workspaceKeyOf(entry.cwd),
						chatKey: entry.id
					}))
				};
				if (entry.title !== void 0) option.title = entry.title;
				items.push(option);
			}
			return {
				available: true,
				currentId: scope.chatKey,
				items
			};
		},
		/** List the recorded history (newest first) with +/- stats. */
		history: async (payload) => {
			const scope = await scopeFor(payload);
			const all = await loadSnapshots(scope);
			const index = await turnIndexOfScope(scope);
			return { items: all.map((s) => toHistoryItem(scope, s, turnInfoOf(index, s))).reverse() };
		},
		/** Review payload for one snapshot: diff + auto-run precheck. */
		detail: async (payload) => {
			const scope = await scopeFor(payload);
			const { all, snapshot } = await loadAndFind(scope, payload);
			const preview = await previewUndo(ctx, all, snapshot);
			const current = preview.currentExists ? await readCurrent(ctx, snapshot.filePath) : null;
			const oldSide = snapshot.after ?? current ?? "";
			const newSide = snapshot.before ?? "";
			const hunks = snapshot.before === null ? snapshot.after !== null ? newFileHunks(snapshot.after) : [] : oldSide === newSide ? [] : cachedStructuredDiff(oldSide, newSide);
			const stats = diffStats(hunks);
			const charDelta = snapshot.before !== null && snapshot.after !== null ? snapshot.after.length - snapshot.before.length : snapshot.after !== null ? snapshot.after.length : snapshot.before !== null ? -snapshot.before.length : null;
			const blankLine = snapshot.before !== null && (snapshot.after ?? current) !== null ? detectBlankLineArtifact(snapshot.before, oldSide) : null;
			const revivable = snapshot.state === "reverted" && snapshot.revertReason === "direct" ? all.filter((s) => s.cascadeOf === snapshot.id && s.filePath === snapshot.filePath && s.after !== null).length : 0;
			return {
				item: toHistoryItem(scope, snapshot, turnInfoOf(await turnIndexOfScope(scope), snapshot)),
				hunks,
				added: stats.added,
				removed: stats.removed,
				charDelta,
				...blankLine !== null ? { blankLine } : {},
				...revivable > 0 ? { revivable } : {},
				preview
			};
		},
		/** Read-only precheck alone (used to re-validate right before apply). */
		preview: async (payload) => {
			const scope = await scopeFor(payload);
			const { all, snapshot } = await loadAndFind(scope, payload);
			return previewUndo(ctx, all, snapshot);
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
		rewindPreview: async (payload) => {
			const scope = await scopeFor(payload);
			const id = requireId(payload);
			const all = await loadSnapshots(scope);
			const target = all.find((s) => s.id === id);
			if (target === void 0) throw new ApiError("snapshot_missing", `no snapshot with id "${id}"`, 404);
			return previewRewindTo(ctx, all, target);
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
		rewindApply: async (payload) => {
			const scope = await scopeFor(payload);
			const id = requireId(payload);
			const all = await loadSnapshots(scope);
			const target = all.find((s) => s.id === id);
			if (target === void 0) throw new ApiError("snapshot_missing", `no snapshot with id "${id}"`, 404);
			assertRewindTarget(target);
			const current = await readCurrent(ctx, target.filePath);
			if (current === null) throw new ApiError("file_missing", "文件在预检后已被外部删除。", 404);
			const expected = payload.expectedCurrentHash;
			if (typeof expected !== "string") throw new ApiError("bad-request", "missing \"expectedCurrentHash\" — 回退必须先预览", 400);
			if (sha256(current) !== expected) throw new ApiError("stale", "文件在预检后已被修改，请重新预览。", 409);
			const { validChain, entriesAfter } = buildRewindChain(all, target);
			assertChainContinuity(target, entriesAfter);
			const targetRef = await ctx.fs.resolve(target.filePath);
			const policy = ctx.sandboxPolicy.resolve({ mode: "danger-full-access" });
			await ctx.fs.writeText(targetRef, target.before, void 0, void 0, policy);
			const marks = [{
				id: target.id,
				reason: "direct"
			}, ...validChain.map((s) => ({
				id: s.id,
				reason: "cascade",
				cascadeOf: target.id
			}))];
			let ledgerSynced = true;
			try {
				if (await markRevertedBatch(scope, marks, { allowStates: ["recorded", "reapplied"] }) !== marks.length) ledgerSynced = false;
			} catch (error) {
				ledgerSynced = false;
				console.warn("[DSH] 磁盘已回退但账本标记失败，进入 stale_ledger 态:", error);
			}
			return {
				restored: target.filePath,
				invalidated: validChain.length,
				ledgerSynced,
				warning: ledgerSynced ? void 0 : "已回退，但历史标记同步失败。请重新打开本条目，系统会提示补记。"
			};
		},
		/**
		* Two-phase apply: optimistic-concurrency check (`expectedCurrentHash`
		* from the preview the user confirmed against) → transactional
		* full-text write-back → state badge update.
		*/
		apply: async (payload) => {
			const scope = await scopeFor(payload);
			const { all, snapshot } = await loadAndFind(scope, payload);
			if (snapshot.state === "aborted") throw new ApiError("aborted_op", "this operation failed and never changed the file — nothing to undo");
			if (snapshot.state === "noop") throw new ApiError("noop_op", "this operation did not change the file — nothing to undo");
			if (snapshot.state === "reverted") throw new ApiError("already_reverted", "this operation was already undone");
			if (snapshot.before === null) {
				if (snapshot.after === null) throw new ApiError("no_before", "this creation snapshot has no captured content — deleting cannot be verified as safe");
				const current = await readCurrent(ctx, snapshot.filePath);
				if (current !== null) {
					const currentHash = sha256(current);
					const expected = payload.expectedCurrentHash;
					if (typeof expected === "string" && expected !== currentHash) throw new ApiError("stale", "the file changed since the preview was loaded — reopen the entry and review the new diff", 409);
					if (snapshot.afterHash !== null && snapshot.afterHash !== currentHash) throw new ApiError("external_modified", "the file changed after it was created — refusing to delete (the later edits would be lost)", 409);
				}
				await removeFile(ctx, await ctx.fs.resolve(snapshot.filePath));
				await markReverted(scope, snapshot.id);
				return {
					restored: snapshot.filePath,
					command: snapshot.command,
					deleted: true,
					alreadyGone: current === null
				};
			}
			const current = await readCurrent(ctx, snapshot.filePath);
			if (current === null) throw new ApiError("file_missing", "the file no longer exists on disk");
			const currentHash = sha256(current);
			const expected = payload.expectedCurrentHash;
			if (typeof expected === "string" && expected !== currentHash) throw new ApiError("stale", "the file changed since the preview was loaded — reopen the entry and review the new diff", 409);
			if (snapshot.afterHash !== null && snapshot.afterHash !== currentHash) {
				const laterOps = findLaterOps(all, snapshot);
				if (laterOps.length > 0) throw new ApiError("superseded_by_later_ops", `此操作之后还有 ${laterOps.length} 次编辑，无法单独撤销本条。请使用「回退到此状态」连同后续步骤一起撤销。`, 409);
				throw new ApiError("external_modified", "the file changed after this operation (external edit or a later write); use /undo <index> in the chat if you really want to force it", 409);
			}
			const target = await ctx.fs.resolve(snapshot.filePath);
			const policy = ctx.sandboxPolicy.resolve({ mode: "danger-full-access" });
			await ctx.fs.writeText(target, snapshot.before, void 0, void 0, policy);
			await markReverted(scope, snapshot.id);
			return {
				restored: snapshot.filePath,
				command: snapshot.command
			};
		},
		/**
		* Re-apply a reverted snapshot: write the `after` content back (the
		* inverse of apply). Only valid on reverted entries that captured an
		* after-state; the optimistic-concurrency token is the live file hash,
		* which after an undo equals the before-state's hash.
		*/
		reapply: async (payload) => {
			const scope = await scopeFor(payload);
			const snapshot = await findSnapshot(scope, payload);
			if (snapshot.state === "aborted") throw new ApiError("aborted_op", "this operation failed and never changed the file — nothing to re-apply");
			if (snapshot.state === "noop") throw new ApiError("noop_op", "this operation did not change the file — nothing to re-apply");
			if (snapshot.state !== "reverted") throw new ApiError("not_reverted", "only a reverted operation can be re-applied");
			if (snapshot.revertReason !== "direct") throw new ApiError(snapshot.revertReason === "cascade" ? "cascade_invalidated" : "unknown_revert", snapshot.revertReason === "cascade" ? "此条目因级联回退而失效，请改用「回退到此状态」恢复。" : "此条目的撤销来源未知，为保证状态一致，拒绝重新应用。", 409);
			if (snapshot.after === null) throw new ApiError("no_after", "this snapshot has no recorded after-state to re-apply");
			const current = await readCurrent(ctx, snapshot.filePath);
			if (current === null && snapshot.before !== null) throw new ApiError("file_missing", "the file no longer exists on disk");
			if (current !== null) {
				const currentHash = sha256(current);
				const expected = payload.expectedCurrentHash;
				if (typeof expected === "string" && expected !== currentHash) throw new ApiError("stale", "the file changed since the preview was loaded — reopen the entry and review the new diff", 409);
				if (snapshot.before === null && snapshot.afterHash !== null && snapshot.afterHash !== currentHash) throw new ApiError("external_modified", "the file was re-created with different content after the undo — refusing to overwrite", 409);
			}
			const cascadeRows = (await loadSnapshots(scope)).filter((s) => s.cascadeOf === snapshot.id && s.filePath === snapshot.filePath && s.after !== null).sort((a, b) => a.time - b.time);
			const tail = cascadeRows.length > 0 ? cascadeRows[cascadeRows.length - 1] : void 0;
			const contentToWrite = tail !== void 0 && tail.after !== null ? tail.after : snapshot.after;
			const target = await ctx.fs.resolve(snapshot.filePath);
			const policy = ctx.sandboxPolicy.resolve({ mode: "danger-full-access" });
			await ctx.fs.writeText(target, contentToWrite, void 0, void 0, policy);
			const ids = [snapshot.id, ...cascadeRows.map((s) => s.id)];
			const changed = await markReappliedBatch(scope, ids);
			return {
				reapplied: snapshot.filePath,
				command: snapshot.command,
				recreated: snapshot.before === null && current === null,
				revived: cascadeRows.length,
				ledgerSynced: changed === ids.length
			};
		},
		/**
		* 账本滞后补记（定稿 4.2）：磁盘已处于撤销态但状态标记丢失。
		* 只补标记，不写一个字节 —— 内容本就一致，写盘反而引入并发风险。
		* 只服务编辑类：创建类的幂等撤销路径（删除已删文件）已在 previewUndo
		* 处理，不会产生 stale_ledger；此处对创建类显式拒绝。
		*/
		confirmStaleLedger: async (payload) => {
			const scope = await scopeFor(payload);
			const snapshot = await findSnapshot(scope, payload);
			if (snapshot.before === null) throw new ApiError("unsupported_operation", "creation snapshots are repaired through the idempotent single-undo path", 409);
			const current = await readCurrent(ctx, snapshot.filePath);
			if (!(current !== null && snapshot.beforeHash !== null && sha256(current) === snapshot.beforeHash)) throw new ApiError("not_undone", "disk state does not match the undone state", 409);
			if (await markRevertedBatch(scope, [{
				id: snapshot.id,
				reason: "direct"
			}], { allowStates: ["recorded", "reapplied"] }) !== 1) throw new ApiError("already_marked", "snapshot already has a terminal state", 409);
			return { repaired: snapshot.filePath };
		},
		/** Drop snapshots older than `days` (default 7). */
		prune: async (payload) => {
			const scope = await scopeFor(payload);
			let days = 7;
			if (payload.days !== void 0) {
				const parsed = Number(payload.days);
				if (!Number.isFinite(parsed) || parsed <= 0) throw new ApiError("bad-request", "invalid \"days\"");
				days = parsed;
			}
			return { message: await pruneSnapshots(scope, days) };
		}
	};
}
/** Body size bound of one JSON request (defense against unbounded reads). */
const MAX_BODY_BYTES = 1 << 20;
function header(headers, name) {
	const value = headers[name];
	if (typeof value === "string") return value;
	if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") return value[0];
}
function isLoopbackHostname(hostname) {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
/**
* Host-header trust fence (platform convention): the request must target a
* loopback authority or one the deployment declared trusted, must not be
* marked cross-site by fetch metadata, and its Origin (when present) must
* match the Host hostname.
*/
function isTrustedApiRequest(request, trustedAuthorities) {
	const host = header(request.headers, "host");
	if (host === void 0) return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	const trusted = trustedAuthorities.some((entry) => {
		try {
			const entryUrl = new URL(`http://${entry}`);
			return entryUrl.hostname === hostUrl.hostname && entryUrl.port === hostUrl.port;
		} catch {
			return false;
		}
	});
	if (!isLoopbackHostname(hostUrl.hostname) && !trusted) return false;
	if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
	const origin = header(request.headers, "origin");
	if (origin === void 0) return true;
	try {
		return new URL(origin).hostname === hostUrl.hostname;
	} catch {
		return false;
	}
}
/** Read and parse a bounded JSON request body ({ } when empty). */
async function readJsonBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES) throw new ApiError("bad-request", "request body too large", 413);
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim() === "") return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new ApiError("bad-request", "request body is not valid JSON");
	}
}
//#endregion
export { ApiError, buildApi, detectBlankLineArtifact, isTrustedApiRequest, readJsonBody };
