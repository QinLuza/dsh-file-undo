import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
//#region src/index.ts
/**
* dsh-file-undo — undo file write/edit operations in DSH.
*
* Snapshot the before-state of every `write` / `edit` tool mutation
* through the `tools/pre-execute` waterfall, store it append-only, and
* restore with `/undo`.
*
* Design (evidence-backed):
* - The write/edit tools discard the fs outcome's `before` (return only a
*   success string), so the before-state MUST be captured by reading the
*   target in `tools/pre-execute`, before the tool body runs.
* - Official fs has NO delete/unlink method, and file deletion is out of
*   scope (awaiting official support): creation undo (before=null) reports
*   the limitation instead of side-stepping it.
* - Snapshots are append-only JSONL (one line per snapshot) to avoid
*   read-modify-write races between concurrent tool calls.
*/
const name = "file-undo";
const inject = [
	"commands",
	"tools",
	"fs",
	"sandboxPolicy"
];
/** Default retention for snapshot pruning, in days. */
const DEFAULT_PRUNE_DAYS = 7;
/** Append-only JSONL snapshot store under ~/.dsh/file-undo/snapshots.jsonl. */
function snapshotPath() {
	return join(homedir(), ".dsh", "file-undo", "snapshots.jsonl");
}
async function ensureDir() {
	await mkdir(join(homedir(), ".dsh", "file-undo"), { recursive: true });
}
async function appendSnapshot(snapshot) {
	await ensureDir();
	await appendFile(snapshotPath(), `${JSON.stringify(snapshot)}\n`, "utf8");
}
async function loadSnapshots() {
	try {
		return (await readFile(snapshotPath(), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}
/** Remove the last snapshot and return it. */
async function popSnapshot() {
	const all = await loadSnapshots();
	if (all.length === 0) return void 0;
	const last = all[all.length - 1];
	await writeFile(snapshotPath(), all.slice(0, -1).map((s) => `${JSON.stringify(s)}\n`).join(""), "utf8");
	return last;
}
/**
* Drop snapshots older than `days` and rewrite the store with the survivors.
* This only shrinks undo history (how far back /undo can reach); it never
* touches current file contents. Entries whose `time` is not a number are
* kept (conservative: unknown-age data is never deleted).
*/
async function pruneSnapshots(days) {
	const all = await loadSnapshots();
	if (all.length === 0) return "No snapshots to prune.";
	const cutoff = Date.now() - days * 864e5;
	const kept = all.filter((s) => typeof s.time !== "number" || s.time >= cutoff);
	const removed = all.length - kept.length;
	if (removed === 0) return `Nothing pruned: all ${all.length} snapshot(s) are within ${days} day(s).`;
	await writeFile(snapshotPath(), kept.map((s) => `${JSON.stringify(s)}\n`).join(""), "utf8");
	return `Pruned ${removed} snapshot(s) older than ${days} day(s); ${kept.length} kept.`;
}
/** Remove one snapshot at an index (used by /undo <n>). */
async function removeSnapshotAt(index) {
	const all = await loadSnapshots();
	const target = all[index];
	if (target === void 0) return void 0;
	const rest = all.filter((_, i) => i !== index);
	await writeFile(snapshotPath(), rest.map((s) => `${JSON.stringify(s)}\n`).join(""), "utf8");
	return target;
}
/** Snapshot one mutation before it executes; never throws (must not block tools). */
async function snapshotIfMutation(exec, fs) {
	if (exec.name !== "write" && exec.name !== "edit") return;
	const args = exec.arguments;
	if (args === void 0 || typeof args !== "object" || typeof args.file_path !== "string") return;
	try {
		const target = await fs.resolve(args.file_path);
		let before = null;
		try {
			before = await fs.readText(target);
		} catch {}
		await appendSnapshot({
			filePath: args.file_path,
			command: exec.name,
			before,
			time: Date.now()
		});
	} catch (error) {
		console.error("[file-undo] snapshot failed:", error);
	}
}
function apply(ctx) {
	ctx.on("tools/pre-execute", async (exec, next) => {
		const fs = ctx.fs;
		if (fs !== void 0) await snapshotIfMutation(exec, fs);
		return next();
	});
	ctx.effect(function* () {
		pruneSnapshots(DEFAULT_PRUNE_DAYS).catch((error) => {
			console.error("[file-undo] lazy prune failed:", error);
		});
		yield ctx.commands.register({
			name: "undo",
			description: "Undo file write/edit operations. Usage: /undo (last), /undo list, /undo <n>, /undo prune [days]",
			input: { hint: "[list | <n> | prune [days]]" },
			handler: async (invocation) => {
				const raw = invocation.rawInput.trim();
				if (raw === "prune" || raw.startsWith("prune ")) {
					const arg = raw.split(/\s+/)[1];
					let days = DEFAULT_PRUNE_DAYS;
					if (arg !== void 0) {
						const parsed = Number(arg);
						if (!Number.isFinite(parsed) || parsed <= 0) return {
							kind: "error",
							text: `Invalid prune retention "${arg}". Usage: /undo prune [days] (days > 0, default ${DEFAULT_PRUNE_DAYS}).`
						};
						days = parsed;
					}
					return {
						kind: "success",
						text: await pruneSnapshots(days)
					};
				}
				if (raw === "list") {
					const all = await loadSnapshots();
					if (all.length === 0) return {
						kind: "error",
						text: "No file operations recorded yet."
					};
					const lines = all.map((s, i) => `[${i}] ${s.time !== void 0 ? new Date(s.time).toLocaleTimeString() : "?"} ${s.command} ${s.filePath}`);
					return {
						kind: "success",
						text: `Undo history (${all.length}):\n${lines.join("\n")}`
					};
				}
				if (/^\d+$/.test(raw)) {
					const index = Number(raw);
					const all = await loadSnapshots();
					const snapshot = all[index];
					if (snapshot === void 0) return {
						kind: "error",
						text: `No operation at index ${index} (0..${all.length - 1}).`
					};
					await removeSnapshotAt(index);
					return restoreSnapshot(ctx, snapshot, invocation.agent.session);
				}
				const snapshot = await popSnapshot();
				if (snapshot === void 0) return {
					kind: "error",
					text: "Nothing to undo."
				};
				return restoreSnapshot(ctx, snapshot, invocation.agent.session);
			}
		});
	}, "file-undo lifecycle");
}
/** Restore one snapshot's before-state via the official fs service. */
async function restoreSnapshot(ctx, snapshot, session) {
	if (snapshot.before === null) return {
		kind: "error",
		text: `Cannot undo a file creation (${snapshot.filePath}) — file deletion is not supported by official fs yet.`
	};
	try {
		const target = await ctx.fs.resolve(snapshot.filePath);
		const policy = ctx.sandboxPolicy.resolve({ session });
		await ctx.fs.writeText(target, snapshot.before, void 0, void 0, policy);
		return {
			kind: "success",
			text: `Restored ${snapshot.filePath} (undo of ${snapshot.command}).`
		};
	} catch (error) {
		return {
			kind: "error",
			text: `Undo failed: ${String(error)}`
		};
	}
}
//#endregion
export { apply, inject, name };
