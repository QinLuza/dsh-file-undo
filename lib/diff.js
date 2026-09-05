import { createHash } from "node:crypto";
//#region src/diff.ts
/**
* Line diff engine — the "compute once, render anywhere" half of the review UI.
*
* Mirrors the reference analysis contract (`structuredPatch` shape): the engine
* side computes a unified diff of full-text snapshots, and the client only
* classifies each line by its first character (`parseLineType`, ~10 lines) to
* paint red/gree rows. No diff library dependency: lines are interned to
* integer ids, common prefix/suffix are trimmed, and the middle section runs
* a classic LCS DP over a Uint32 table. Pathologically large middles (memory
* guard) degrade to a single replace hunk — still a correct diff, just not
* the minimal one.
*
* `cachedStructuredDiff` wraps the engine with an in-process content-keyed
* cache (定稿 6.1): list rows and the detail view recompute the same
* before/after pairs constantly, and a hunk computation is O(LCS) — caching
* the result by content hash turns repeated renders into map lookups. FIFO
* eviction caps memory; null sides (creation/deletion) are never cached.
*/
/** Split text into lines. A trailing newline does not produce a phantom empty line. */
function splitLines(text) {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}
/** Intern lines to ids so equality checks are integer compares. */
function intern(lines) {
	const ids = /* @__PURE__ */ new Map();
	for (const line of lines) if (!ids.has(line)) ids.set(line, ids.size);
	return ids;
}
function editOps(a, b) {
	const n = a.length;
	const m = b.length;
	if ((n + 1) * (m + 1) > 4e7) return void 0;
	const width = m + 1;
	const table = new Uint32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		const row = i * width;
		const next = (i + 1) * width;
		for (let j = m - 1; j >= 0; j--) table[row + j] = a[i] === b[j] ? table[next + j + 1] + 1 : Math.max(table[next + j], table[row + j + 1]);
	}
	const ops = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		const at = i * width;
		if (a[i] === b[j]) {
			ops.push(" ");
			i++;
			j++;
		} else if (table[at + width + j] >= table[at + j + 1]) {
			ops.push("-");
			i++;
		} else {
			ops.push("+");
			j++;
		}
	}
	while (i < n) {
		ops.push("-");
		i++;
	}
	while (j < m) {
		ops.push("+");
		j++;
	}
	return ops;
}
/**
* Compute the unified diff between two full texts.
* `oldText` is the red (removed) side, `newText` the green (added) side —
* for an undo review the caller passes (after-ish current, before) so green
* lines are exactly what a restore would bring back.
*/
function structuredDiff(oldText, newText, context = 3) {
	const oldLines = splitLines(oldText);
	const newLines = splitLines(newText);
	const ids = intern([...oldLines, ...newLines]);
	const a = oldLines.map((l) => ids.get(l));
	const b = newLines.map((l) => ids.get(l));
	let pre = 0;
	while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
	let suf = 0;
	while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
	const midA = a.slice(pre, a.length - suf);
	const midB = b.slice(pre, b.length - suf);
	const midOps = editOps(midA, midB);
	const ops = [];
	const midLines = [];
	for (let k = 0; k < pre; k++) {
		ops.push(" ");
		midLines.push({
			side: "a",
			index: k
		});
	}
	if (midOps === void 0) {
		for (let k = 0; k < midA.length; k++) {
			ops.push("-");
			midLines.push({
				side: "a",
				index: pre + k
			});
		}
		for (let k = 0; k < midB.length; k++) {
			ops.push("+");
			midLines.push({
				side: "b",
				index: pre + k
			});
		}
	} else {
		let ai = 0;
		let bi = 0;
		for (const op of midOps) if (op === "-") {
			ops.push("-");
			midLines.push({
				side: "a",
				index: pre + ai
			});
			ai++;
		} else if (op === "+") {
			ops.push("+");
			midLines.push({
				side: "b",
				index: pre + bi
			});
			bi++;
		} else {
			ops.push(" ");
			midLines.push({
				side: "a",
				index: pre + ai
			});
			ai++;
			bi++;
		}
	}
	for (let k = suf - 1; k >= 0; k--) {
		ops.push(" ");
		midLines.push({
			side: "a",
			index: a.length - 1 - k
		});
	}
	return hunksFromOps(ops, midLines, oldLines, newLines, context);
}
/** Fold the op stream into unified hunks with `context` lines of padding. */
function hunksFromOps(ops, sources, oldLines, newLines, context) {
	const hunks = [];
	let i = 0;
	while (i < ops.length) {
		if (ops[i] === " ") {
			i++;
			continue;
		}
		const start = Math.max(0, i - context);
		let end = i;
		let trailing = 0;
		while (end < ops.length) {
			if (ops[end] !== " ") trailing = 0;
			else {
				trailing++;
				if (trailing > context * 2 && end - trailing + 1 > i) break;
			}
			end++;
		}
		let stop = end;
		if (trailing > context) stop = end - trailing + context;
		if (stop <= i) stop = i + 1;
		const lines = [];
		let oldStart = -1;
		let newStart = -1;
		let oldCount = 0;
		let newCount = 0;
		for (let k = start; k < stop; k++) {
			const op = ops[k];
			const src = sources[k];
			if (op === " ") {
				if (oldStart === -1) oldStart = src.index + 1;
				if (newStart === -1) newStart = src.index + 1;
				lines.push(` ${oldLines[src.index]}`);
				oldCount++;
				newCount++;
			} else if (op === "-") {
				if (oldStart === -1) oldStart = src.index + 1;
				if (newStart === -1) newStart = countNewBefore(sources, k) + 1;
				lines.push(`-${oldLines[src.index]}`);
				oldCount++;
			} else {
				if (newStart === -1) newStart = src.side === "b" ? src.index + 1 : countNewBefore(sources, k) + 1;
				if (oldStart === -1) oldStart = countOldBefore(sources, k) + 1;
				lines.push(`+${newLines[src.index]}`);
				newCount++;
			}
		}
		if (oldStart === -1) oldStart = countOldBefore(sources, start) + 1;
		if (newStart === -1) newStart = countNewBefore(sources, start) + 1;
		hunks.push({
			oldStart,
			oldLines: oldCount,
			newStart,
			newLines: newCount,
			lines
		});
		i = stop;
	}
	return hunks;
}
/** Count old-side lines consumed before position `at` in the op stream. */
function countOldBefore(sources, at) {
	let count = 0;
	for (let k = 0; k < at; k++) if (sources[k].side === "a") count++;
	return count;
}
/** Count new-side lines consumed before position `at` in the op stream. */
function countNewBefore(sources, at) {
	let count = 0;
	for (let k = 0; k < at; k++) if (sources[k].side === "b") count++;
	return count;
}
/** Added/removed line counts across all hunks. */
function diffStats(hunks) {
	let added = 0;
	let removed = 0;
	for (const hunk of hunks) for (const line of hunk.lines) if (line.startsWith("+")) added++;
	else if (line.startsWith("-")) removed++;
	return {
		added,
		removed
	};
}
/** 缓存上限：200 条内容对 —— 超出按 FIFO 淘汰（Map 保持插入序，删最早一条）。 */
const HUNK_CACHE_MAX = 200;
/**
* 内容 → hunks 的进程内缓存。key 是 before/after 全文 hash（`sha256(before):sha256(after)`）。
* 理由：diff 结果只由内容决定，同一次会话里 history 列表 + detail 会反复算同一对内容；
* 而结构化 diff 是 O(LCS) 的，缓存把它降为一次 Map 查找。
*
* 两条纪律：
* 1. before/after 任一为 null 时不缓存 —— 创建/删除类走 `newFileHunks` 等特判分支，
*    而且 `null` 在调用方被规范化成 `''` 后语义会被污染（空串是合法的"空文件"内容）。
* 2. 命中返回缓存数组本身的引用 —— 调用方不得修改返回的 hunks。
*/
const hunkCache = /* @__PURE__ */ new Map();
function cachedStructuredDiff(before, after, context = 3) {
	if (before === null || after === null) return structuredDiff(before ?? "", after ?? "", context);
	const key = `${createHash("sha256").update(before, "utf8").digest("hex")}:${createHash("sha256").update(after, "utf8").digest("hex")}`;
	const hit = hunkCache.get(key);
	if (hit !== void 0) return hit;
	const hunks = structuredDiff(before, after, context);
	if (hunkCache.size >= HUNK_CACHE_MAX) hunkCache.delete(hunkCache.keys().next().value);
	hunkCache.set(key, hunks);
	return hunks;
}
//#endregion
export { cachedStructuredDiff, diffStats, hunkCache, structuredDiff };
