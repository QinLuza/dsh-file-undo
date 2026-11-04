//#region src/patch-capture.ts
/**
* Dependency-free adapter for the current apply_patch canonical result.
*
* These are deletion candidates, not restorable snapshots: the provider's
* `before` is a bounded, LF-normalized diff basis. The caller must match it
* against content captured at the admitted delete intent, resolve both paths
* to the same filesystem identity, and preserve the captured original text.
* Never derive deletions from model arguments, rendered output, or metadata.
*/
/** Bound raw capture and guarded restoration to one MiB per text file. */
const PATCH_SNAPSHOT_MAX_BYTES = 1048576;
function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonemptyString(value) {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}
/**
* Select only known completed deletions, including earlier successes in a
* stopped/cancelled patch. Failed, unknown, skipped, move, add and update
* operations deliberately provide no deletion candidates. A null baseline
* means unavailable (oversized/non-text), never an empty file.
*/
function buildPatchDeletions(exec, result) {
	if (!record(exec) || exec.name !== "apply_patch" || !nonemptyString(exec.callId) || !record(result) || result.isError !== false || !record(result.value)) return [];
	const value = result.value;
	if (value.phase !== "commit" || typeof value.cancelled !== "boolean" || !Array.isArray(value.operations) || !Array.isArray(value.affectedPaths) || !value.affectedPaths.every(nonemptyString)) return [];
	const affectedPaths = new Set(value.affectedPaths);
	const candidates = [];
	for (const [index, operation] of value.operations.entries()) {
		if (!record(operation) || operation.index !== index || operation.kind !== "delete" || operation.status !== "completed" || !nonemptyString(operation.path) || operation.destination !== void 0 || !Number.isSafeInteger(operation.patchLine) || operation.patchLine < 1 || !Array.isArray(operation.changes) || operation.changes.length !== 1) continue;
		const change = operation.changes[0];
		if (!record(change) || !nonemptyString(change.path) || !affectedPaths.has(change.path) || typeof change.before !== "string" || change.after !== null) continue;
		candidates.push({
			kind: "delete",
			operationIndex: index,
			path: change.path,
			displayPath: operation.path,
			before: change.before,
			after: null,
			callId: exec.callId,
			...nonemptyString(exec.rootCallId) ? { rootCallId: exec.rootCallId } : {}
		});
	}
	return candidates;
}
/**
* Match original UTF-8 text to DSH's diff basis without changing stored text.
* DSH's TextDecoder strips one leading UTF-8 BOM and its diff basis converts
* CRLF to LF; lone CR and every other character must match exactly. To retain
* a BOM, the caller must capture bytes and decode with `ignoreBOM: true`:
* readText has already discarded it and cannot prove byte-exact recovery.
* Content equality alone does not replace filesystem identity/version guards.
*/
function matchesPatchDeletionBefore(rawBefore, candidate) {
	return (rawBefore.startsWith("﻿") ? rawBefore.slice(1) : rawBefore).replaceAll("\r\n", "\n") === candidate.before;
}
//#endregion
export { PATCH_SNAPSHOT_MAX_BYTES, buildPatchDeletions, matchesPatchDeletionBefore };
