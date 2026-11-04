import { sha256, workspaceKeyOf } from "./store.js";
import { PATCH_SNAPSHOT_MAX_BYTES, buildPatchDeletions, matchesPatchDeletionBefore } from "./patch-capture.js";
import { randomUUID } from "node:crypto";
//#region src/patch-recorder.ts
/** Capture guarded native patch deletions without changing the tool's decision. */
function patchExecution(actor) {
	if (actor === void 0) return void 0;
	const candidate = actor;
	return candidate.name === "apply_patch" && typeof candidate.callId === "string" && candidate.agent !== void 0 && candidate.signal instanceof AbortSignal ? candidate : void 0;
}
/** A compound patch needs its own transaction history, not isolated deletes. */
async function repeatedTargets(ctx, result, cwd) {
	const { operations } = result.value;
	const seen = /* @__PURE__ */ new Set();
	const repeated = /* @__PURE__ */ new Set();
	for (const operation of operations) {
		if (operation === null || typeof operation !== "object") throw new Error("Invalid patch operation");
		const op = operation;
		const paths = [
			op.path,
			op.destination,
			...(op.changes ?? []).map((change) => change.path)
		];
		const targets = /* @__PURE__ */ new Set();
		for (const path of paths) {
			if (path === void 0) continue;
			if (typeof path !== "string" || path === "") throw new Error("Invalid patch path");
			const target = await ctx.fs.resolve(path, { cwd });
			targets.add(String(target.targetKey));
		}
		for (const target of targets) {
			if (seen.has(target)) repeated.add(target);
			seen.add(target);
		}
	}
	return repeated;
}
/**
* Register capture at the resolved delete intent and commit only deletions the
* real tool reports as completed. Unguarded deletes cannot prove which raw
* bytes were removed, so they are deliberately not added to the undo history.
*/
function installPatchRecorder(ctx, save) {
	let pending = /* @__PURE__ */ new WeakMap();
	ctx.effect(function* () {
		yield () => {
			pending = /* @__PURE__ */ new WeakMap();
		};
	});
	ctx.on("fs/delete-intent", async (target, actor, next) => {
		const intent = await next();
		const exec = patchExecution(actor);
		if (exec === void 0) return intent;
		pending.get(exec)?.delete(String(target.targetKey));
		if (intent === void 0) return intent;
		try {
			const fs = ctx.fs;
			const before = await fs.stat(target, exec.signal);
			if (before?.type !== "file" || before.version !== intent.version) return intent;
			const bytes = await fs.readBytes(target, exec.signal, PATCH_SNAPSHOT_MAX_BYTES);
			const text = new TextDecoder("utf-8", {
				fatal: true,
				ignoreBOM: true
			}).decode(bytes);
			if (text.includes("\0")) return intent;
			const after = await fs.stat(target, exec.signal);
			if (after?.type !== "file" || after.version !== before.version) return intent;
			let captured = pending.get(exec);
			if (captured === void 0) pending.set(exec, captured = /* @__PURE__ */ new Map());
			captured.set(String(target.targetKey), {
				before: text,
				path: fs.processPath(target)
			});
		} catch (error) {
			console.error("[file-undo] patch deletion capture unavailable:", error);
		}
		return intent;
	}, { prepend: true });
	ctx.on("tools/post-execute", async (exec, result, next) => {
		const captured = pending.get(exec);
		pending.delete(exec);
		if (captured !== void 0 && exec.agent !== void 0) {
			const cwd = exec.agent.session.header.cwd;
			if (typeof cwd === "string" && cwd !== "") {
				const scope = {
					workspaceKey: workspaceKeyOf(cwd),
					chatKey: exec.agent.id
				};
				const deletions = buildPatchDeletions(exec, result);
				let repeated;
				try {
					repeated = deletions.length > 0 ? await repeatedTargets(ctx, result, cwd) : /* @__PURE__ */ new Set();
				} catch (error) {
					console.error("[file-undo] patch paths unavailable:", error);
					return next();
				}
				for (const deletion of deletions) try {
					const target = await ctx.fs.resolve(deletion.path, { cwd });
					const targetKey = String(target.targetKey);
					if (repeated.has(targetKey)) continue;
					const original = captured.get(targetKey);
					if (original === void 0 || !matchesPatchDeletionBefore(original.before, deletion)) continue;
					captured.delete(targetKey);
					await save(scope, {
						id: randomUUID(),
						filePath: original.path,
						command: "apply_patch",
						op: "delete",
						callId: deletion.callId,
						before: original.before,
						beforeHash: sha256(original.before),
						after: null,
						afterHash: null,
						afterAbsent: true,
						time: Date.now(),
						state: "recorded",
						...deletion.rootCallId === void 0 ? {} : { rootCallId: deletion.rootCallId }
					});
				} catch (error) {
					console.error("[file-undo] patch deletion record failed:", error);
				}
			}
		}
		return next();
	}, { prepend: true });
}
//#endregion
export { installPatchRecorder };
