import { appendSnapshot, backfillAfter, loadSnapshots, markAbortedByCall, markReverted, pruneSnapshots, recoverActiveScope, scopeDir, sha256, workspaceKeyOf } from "./store.js";
import { ApiError, buildApi, isTrustedApiRequest, readJsonBody } from "./api.js";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
//#region src/index.ts
/**
* dsh-file-undo — visual undo history for file write/edit operations in DSH.
*
* Snapshot the before-state of every `write` / `edit` tool mutation through
* the `tools/pre-execute` waterfall, backfill the after-state once the tool
* settles (`tools/post-execute`), and expose:
* - the classic `/undo` command family (chat), and
* a visual review surface (sidebar footer entry + portal panel) served by
* the host half's JSON API under POST /file-undo/api/* — diff rendering,
* two-phase undo (read-only preview → transactional apply with optimistic
* concurrency), and enumerated safety reasons, modeled on the reference
* review/rewind/diff analysis.
*
* Storage is scoped per workspace and per chat (v2.1):
*   ~/.dsh/file-undo/<workspace-key>/<chat-key>/{snapshots.jsonl, git-archive/}
* The scope is derived from the executing agent's session (cwd + session id)
* at capture time. The host tracks the most recently active scope so the
* panel (a browser-side UI with no session of its own) reads the right store.
*
* Design (evidence-backed):
* - The write/edit tools discard the fs outcome's `before`, so the
*   before-state MUST be captured by reading the target in
*   `tools/pre-execute`, before the tool body runs.
* - Official fs has NO delete/unlink method: creation undo (before=null)
*   reports the limitation instead of side-stepping it.
* - Snapshots are append-only JSONL (one line per snapshot) to avoid
*   read-modify-write races between concurrent tool calls; point updates
*   (backfill / revert mark / prune) rewrite behind a single-flight lock.
* - The web routes mount reactively (ctx.inject waits for webServer) so
*   headless deployments keep the /undo command family without a webServer.
*/
const name = "file-undo";
const inject = [
	"commands",
	"tools",
	"fs",
	"sandboxPolicy"
];
/**
* The most recently active store scope (updated on every mutating tool call).
* The HTTP API is browser-driven and carries no session of its own, so it
* reads this to decide which store to serve. First tool call in a fresh
* process wins until a newer one arrives; `/undo` commands also refresh it.
*/
let activeScope;
/** Read the session identity (cwd + session id) off an agent-shaped object. */
function agentScope(agent) {
	const a = agent;
	if (a === void 0) return void 0;
	const cwd = a.session?.header?.cwd;
	const chatKey = a.id;
	if (typeof cwd !== "string" || cwd === "" || typeof chatKey !== "string" || chatKey === "") return void 0;
	return {
		workspaceKey: workspaceKeyOf(cwd),
		chatKey
	};
}
/**
* The session's working directory, read from the tool execution's agent.
* The tool's `file_path` argument is relative to THIS, not the host process
* cwd (launch-root) — resolving a relative path against the host cwd reads
* nothing (the file lives under the session workspace). Cast structurally so
* this does not depend on dsh-agent/dsh-session types being resolvable here.
*/
function sessionCwd(exec) {
	const cwd = exec.agent?.session?.header?.cwd;
	return typeof cwd === "string" && cwd !== "" ? cwd : void 0;
}
function mutationOf(exec) {
	const args = exec.arguments;
	if (args === void 0 || typeof args !== "object") return void 0;
	if ((exec.name === "write" || exec.name === "edit") && typeof args.file_path === "string" && args.file_path !== "") return {
		path: args.file_path,
		op: exec.name
	};
	if (exec.name === "str_replace_editor") {
		const cmd = args.command;
		if ((cmd === "create" || cmd === "str_replace" || cmd === "insert") && typeof args.path === "string" && args.path !== "") return {
			path: args.path,
			op: cmd
		};
	}
}
/** Capture the before-state of one mutating tool call; never throws. */
async function snapshotIfMutation(exec, fs) {
	const mutation = mutationOf(exec);
	if (mutation === void 0) return;
	const scope = agentScope(exec.agent);
	if (scope === void 0) return;
	activeScope = scope;
	try {
		const cwd = sessionCwd(exec);
		const target = await fs.resolve(mutation.path, cwd !== void 0 ? { cwd } : void 0);
		let before = null;
		try {
			before = await fs.readText(target);
		} catch {}
		const absolutePath = String(target.targetKey);
		const callId = typeof exec.callId === "string" ? exec.callId : void 0;
		const rootCallId = typeof exec.rootCallId === "string" && exec.rootCallId !== "" ? exec.rootCallId : void 0;
		const snapshot = {
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			filePath: absolutePath,
			command: exec.name,
			before,
			beforeHash: before === null ? null : sha256(before),
			after: null,
			afterHash: null,
			time: Date.now(),
			state: "recorded",
			...mutation.op !== exec.name ? { op: mutation.op } : {},
			...callId !== void 0 ? { callId } : {},
			...rootCallId !== void 0 ? { rootCallId } : {}
		};
		await appendSnapshot(scope, snapshot);
		recordArchive(scope, snapshot);
	} catch (error) {
		console.error("[file-undo] snapshot failed:", error);
	}
}
/** Backfill the after-state once the mutating tool settled; never throws. */
async function backfillIfMutation(exec, fs) {
	const mutation = mutationOf(exec);
	if (mutation === void 0) return;
	const scope = agentScope(exec.agent);
	if (scope === void 0) return;
	activeScope = scope;
	const callId = typeof exec.callId === "string" ? exec.callId : void 0;
	try {
		const cwd = sessionCwd(exec);
		const target = await fs.resolve(mutation.path, cwd !== void 0 ? { cwd } : void 0);
		let after = null;
		try {
			after = await fs.readText(target);
		} catch {}
		const absolutePath = String(target.targetKey);
		const rootCallId = typeof exec.rootCallId === "string" && exec.rootCallId !== "" ? exec.rootCallId : void 0;
		await backfillAfter(scope, absolutePath, after, callId, rootCallId);
	} catch (error) {
		console.error("[file-undo] backfill read failed:", error);
	}
}
/**
* sessionQueryRef 捕获 ctx.sessionQuery（v0.3.10）。
*
* P1 教训的对称应用：可选服务绝不加进顶层 inject（那是必需语义，headless /
* 无查询后端的 profile 会因此加载失败），而是 ctx.inject(['sessionQuery'], …)
* 响应式等待——回调在缝挂载时运行、服务变更时重跑；永不挂载则永不运行，
* history 条目自然退化为无轮次徽章，与 webServer 的挂载方式完全同构。
*/
const sessionQueryRef = { current: void 0 };
function watchSessionQuery(ctx) {
	ctx.inject(["sessionQuery"], (subCtx) => {
		sessionQueryRef.current = subCtx.get("sessionQuery");
	});
}
/**
* Mount POST /file-undo/api/<method> behind the Host-header trust fence.
*
* ctx.inject(['webServer'], …) is the documented wait-for-service form
* (docs/cordis-api/registry: "run a callback once the requested services are
* available"): the callback runs once webServer is active and re-runs if the
* service changes. A plain ctx.get() inside apply() races the web stack — it
* reads undefined and never retries, which is exactly how the 405 blank
* panel happened. On headless profiles (no webServer) the callback simply
* never runs and /undo keeps working.
*/
function mountWebApi(ctx) {
	ctx.inject(["webServer"], (subCtx) => {
		const webServer = subCtx.get("webServer");
		if (webServer === void 0) return;
		const api = buildApi(ctx, () => activeScope, () => sessionQueryRef.current);
		return webServer.register({
			kind: "prefix",
			path: "/file-undo/api",
			handler: async (reqRaw, resRaw) => {
				const req = reqRaw;
				const res = resRaw;
				const webRuntime = typeof ctx.get === "function" ? ctx.get("webRuntime") : void 0;
				if (!isTrustedApiRequest(req, webRuntime?.trustedHosts ?? [])) {
					finish(res, 403, {
						ok: false,
						error: {
							code: "forbidden",
							message: "forbidden"
						}
					});
					return;
				}
				if (req.method !== "POST") {
					finish(res, 405, {
						ok: false,
						error: {
							code: "method-error",
							message: "method not allowed"
						}
					});
					return;
				}
				const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
				const method = pathname.startsWith("/file-undo/api/") ? pathname.slice(15) : void 0;
				if (method === void 0 || method.includes("/")) {
					finish(res, 404, {
						ok: false,
						error: {
							code: "not-found",
							message: "unknown file-undo API method"
						}
					});
					return;
				}
				try {
					const payload = await readJsonBody(req);
					const handler = api[method];
					if (handler === void 0) throw new ApiError("not-found", `unknown file-undo API method "${method}"`, 404);
					finish(res, 200, {
						ok: true,
						value: await handler(payload)
					});
				} catch (error) {
					if (error instanceof ApiError) {
						finish(res, error.status, {
							ok: false,
							error: {
								code: error.code,
								message: error.message
							}
						});
						return;
					}
					finish(res, 500, {
						ok: false,
						error: {
							code: "internal",
							message: error instanceof Error ? error.message : String(error)
						}
					});
				}
			}
		});
	});
}
function finish(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}
function apply(ctx) {
	watchSessionQuery(ctx);
	const scopeReady = recoverActiveScope().then((scope) => {
		if (scope !== void 0) activeScope = scope;
	}).catch(() => {});
	ctx.on("tools/pre-execute", async (exec, next) => {
		const fs = ctx.fs;
		if (fs !== void 0) await snapshotIfMutation(exec, fs);
		return next();
	});
	ctx.on("tools/post-execute", async (exec, result, next) => {
		const fs = ctx.fs;
		if (fs !== void 0) {
			if (result?.isError === true && typeof exec.callId === "string") {
				const scope = agentScope(exec.agent);
				if (scope !== void 0) {
					const errObj = result.error;
					const reason = typeof errObj === "string" ? errObj : errObj instanceof Error ? errObj.message : typeof errObj?.message === "string" ? errObj.message : void 0;
					await markAbortedByCall(scope, exec.callId, reason !== void 0 ? reason.slice(0, 200) : void 0);
				}
			} else await backfillIfMutation(exec, fs);
		}
		return next();
	});
	mountWebApi(ctx);
	ctx.effect(function* () {
		scopeReady.then(() => {
			if (activeScope !== void 0) pruneSnapshots(activeScope, 7).catch((error) => {
				console.error("[file-undo] lazy prune failed:", error);
			});
		});
		yield ctx.commands.register({
			name: "undo",
			description: "Undo file write/edit operations. Usage: /undo (last), /undo list, /undo <n>, /undo sessions, /undo prune [days], /undo git [n], /undo git-status",
			input: { hint: "[list | sessions | <n> | prune [days] | git [n] | git-status]" },
			handler: async (invocation) => {
				const raw = invocation.rawInput.trim();
				const scope = agentScope(invocation.agent);
				if (scope === void 0) return {
					kind: "error",
					text: "No active session context; open a session and try again."
				};
				activeScope = scope;
				const session = invocation.agent.session;
				if (raw === "git-status") return {
					kind: "success",
					text: await archiveStatus(scope)
				};
				if (raw === "git" || raw.startsWith("git ")) {
					const arg = raw.split(/\s+/)[1];
					let index;
					if (arg !== void 0) {
						const parsed = Number(arg);
						if (!Number.isInteger(parsed) || parsed < 0) return {
							kind: "error",
							text: `Invalid archive index "${arg}". Usage: /undo git [n] (0 = newest commit).`
						};
						index = parsed;
					}
					return restoreFromArchive(ctx, scope, index, session);
				}
				if (raw === "sessions") return {
					kind: "success",
					text: await describeSessions(ctx, scope)
				};
				if (raw === "prune" || raw.startsWith("prune ")) {
					const arg = raw.split(/\s+/)[1];
					let days = 7;
					if (arg !== void 0) {
						const parsed = Number(arg);
						if (!Number.isFinite(parsed) || parsed <= 0) return {
							kind: "error",
							text: `Invalid prune retention "${arg}". Usage: /undo prune [days] (days > 0, default 7).`
						};
						days = parsed;
					}
					return {
						kind: "success",
						text: await pruneSnapshots(scope, days)
					};
				}
				if (raw === "list") {
					const all = await loadSnapshots(scope);
					if (all.length === 0) return {
						kind: "error",
						text: "No file operations recorded yet."
					};
					const lines = all.map((s, i) => {
						const badge = s.state === "reverted" ? " [undone]" : s.state === "reapplied" ? " [reapplied]" : s.state === "aborted" ? " [failed]" : s.state === "noop" ? " [no-op]" : "";
						return `[${i}] ${s.time > 0 ? new Date(s.time).toLocaleTimeString() : "?"} ${s.command} ${s.filePath}${badge}`;
					});
					return {
						kind: "success",
						text: `Undo history (${all.length}):\n${lines.join("\n")}`
					};
				}
				if (/^\d+$/.test(raw)) {
					const index = Number(raw);
					const all = await loadSnapshots(scope);
					const snapshot = all[index];
					if (snapshot === void 0) return {
						kind: "error",
						text: `No operation at index ${index} (0..${all.length - 1}).`
					};
					if (snapshot.state === "aborted") return {
						kind: "error",
						text: `Operation [${index}] failed and never changed the file (${snapshot.failReason ?? "unknown reason"}) — nothing to undo.`
					};
					if (snapshot.state === "noop") return {
						kind: "error",
						text: `Operation [${index}] did not change the file — nothing to undo.`
					};
					return restoreSnapshot(ctx, scope, snapshot, session);
				}
				const all = await loadSnapshots(scope);
				const last = all[all.length - 1];
				if (last === void 0) return {
					kind: "error",
					text: "Nothing to undo."
				};
				return restoreSnapshot(ctx, scope, last, session);
			}
		});
	}, "file-undo lifecycle");
}
/**
* List the sessions the switcher offers (会话跟随) — discovery and diagnostics
* in one line: it goes through the EXACT `sessions` API the panel uses, so
* whatever this prints is what the panel sees. Reports the title-seam state,
* which is the answer to "why does the switcher show ids instead of names?".
*/
async function describeSessions(ctx, scope) {
	const seam = sessionQueryRef.current;
	const result = await buildApi(ctx, () => scope, () => seam).sessions({});
	const surface = seam === void 0 ? "ctx.sessionQuery 未挂载" : [
		"listSessions",
		"readTitleSnapshots",
		"readTitle"
	].map((name) => `${name}:${typeof seam[name] === "function" ? "有" : "无"}`).join(" ");
	if (!result.available) return `会话目录不可用：当前 host 未提供 ctx.sessionQuery.listSessions（headless 或旧版 DSH）。面板会自动隐藏切换器。\n缝能力：${surface}`;
	const titled = result.items.filter((s) => s.title !== void 0).length;
	const lines = result.items.map((s) => {
		return `  ${s.title !== void 0 ? s.title : `${s.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).filter((part) => part !== "").slice(-1)[0] ?? s.cwd} · ${s.id.replace(/^session-/, "").slice(0, 8)}`}（${[
			s.current ? "当前" : null,
			s.live ? "活跃" : "仅存档",
			s.hasRecords ? "有记录" : "无记录"
		].filter((flag) => flag !== null).join(" · ")}）\n    ${s.cwd}`;
	});
	const titleNote = titled === result.items.length ? "标题：全部取自平台" : titled === 0 ? "标题：平台未提供（readTitleSnapshots / readTitle 均无）→ 回退为「目录名 · 短 id」" : `标题：${titled}/${result.items.length} 取自平台，其余回退为「目录名 · 短 id」`;
	return [
		`会话目录：${result.items.length} 个同项目树会话（当前 ${result.currentId}）；${titleNote}`,
		`缝能力：${surface}`,
		...lines
	].join("\n");
}
/** Restore one snapshot's before-state via the official fs service. */
async function restoreSnapshot(ctx, scope, snapshot, session) {
	if (snapshot.state === "aborted") return {
		kind: "error",
		text: `Operation on ${snapshot.filePath} failed and never changed the file (${snapshot.failReason ?? "unknown reason"}) — nothing to undo.`
	};
	if (snapshot.state === "noop") return {
		kind: "error",
		text: `Operation on ${snapshot.filePath} did not change the file — nothing to undo.`
	};
	if (snapshot.before === null) {
		if (snapshot.after === null) return {
			kind: "error",
			text: `Cannot undo a file creation (${snapshot.filePath}) — the created content was never captured, so a delete cannot be verified as safe.`
		};
		if (snapshot.state === "reverted") return {
			kind: "error",
			text: `Operation on ${snapshot.filePath} was already undone.`
		};
		return (async () => {
			try {
				const target = await ctx.fs.resolve(snapshot.filePath);
				let current = null;
				try {
					current = await ctx.fs.readText(target);
				} catch {}
				if (current !== null && snapshot.afterHash !== null && sha256(current) !== snapshot.afterHash) return {
					kind: "error",
					text: `File ${snapshot.filePath} changed after it was created — refusing to delete (the later edits would be lost).`
				};
				const { unlink } = await import("node:fs/promises");
				try {
					await unlink(String(target.targetKey));
				} catch (error) {
					if (error.code !== "ENOENT") throw error;
				}
				await markReverted(scope, snapshot.id);
				return {
					kind: "success",
					text: current === null ? `${snapshot.filePath} no longer exists — creation recorded as undone.` : `Deleted ${snapshot.filePath} (undo of creation).`
				};
			} catch (error) {
				return {
					kind: "error",
					text: `Undo failed: ${String(error)}`
				};
			}
		})();
	}
	if (snapshot.state === "reverted") return {
		kind: "error",
		text: `Operation on ${snapshot.filePath} was already undone.`
	};
	try {
		const target = await ctx.fs.resolve(snapshot.filePath);
		const policy = ctx.sandboxPolicy.resolve({ session });
		await ctx.fs.writeText(target, snapshot.before, void 0, void 0, policy);
		await markReverted(scope, snapshot.id);
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
const ARCHIVE_BRANCH = "refs/heads/file-undo-archive";
/** Resolved git binary, `false` once detection gave up, `undefined` while pending. */
let gitBin;
/** Serializes every archive mutation (git objects are not concurrency-safe here). */
let archiveChain = Promise.resolve();
function archiveRepoPath(scope) {
	return join(scopeDir(scope), "git-archive");
}
function pathToRef(filePath) {
	return Buffer.from(filePath, "utf8").toString("base64url");
}
function refToPath(ref) {
	try {
		return Buffer.from(ref, "base64url").toString("utf8");
	} catch {
		return;
	}
}
function runGit(args, input) {
	return new Promise((resolve, reject) => {
		if (typeof gitBin !== "string") return reject(/* @__PURE__ */ new Error("git unavailable"));
		const child = execFile(gitBin, args, {
			encoding: "buffer",
			maxBuffer: 67108864,
			timeout: 1e4,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "dsh-file-undo",
				GIT_AUTHOR_EMAIL: "file-undo@localhost",
				GIT_COMMITTER_NAME: "dsh-file-undo",
				GIT_COMMITTER_EMAIL: "file-undo@localhost"
			}
		}, (error, stdout, stderr) => {
			const errCode = error === null || error === void 0 ? 0 : error.code;
			if (typeof errCode !== "number") return reject(error);
			resolve({
				code: errCode,
				stdout,
				stderr: stderr.toString("utf8")
			});
		});
		if (input !== void 0 && child.stdin !== null) child.stdin.write(input);
		if (child.stdin !== null) child.stdin.end();
	});
}
/** Locate a git binary once; result cached for the process lifetime. */
async function detectGit() {
	if (gitBin !== void 0) return;
	const candidates = process.platform === "win32" ? ["git.exe", "git"] : ["git"];
	for (const candidate of candidates) try {
		await new Promise((resolve, reject) => {
			execFile(candidate, ["--version"], { timeout: 5e3 }, (error) => error ? reject(error) : resolve());
		});
		gitBin = candidate;
		return;
	} catch {}
	gitBin = false;
}
/** Create the archive repo on first use. Never throws. */
async function ensureArchiveRepo(scope) {
	await detectGit();
	if (gitBin === false) return;
	try {
		await mkdir(archiveRepoPath(scope), { recursive: true });
		if ((await runGit([
			"-C",
			archiveRepoPath(scope),
			"rev-parse",
			"--git-dir"
		])).code === 0) return;
		await runGit([
			"-C",
			archiveRepoPath(scope),
			"init",
			"--bare",
			"-b",
			"file-undo-archive"
		]);
	} catch {}
}
/** Queue one archive mutation behind any in-flight one. Never rejects. */
function queueArchive(task) {
	archiveChain = archiveChain.then(task).catch(() => void 0);
}
/** Test hook: forget cached git state so detection re-runs. */
function resetArchiveForTest() {
	gitBin = void 0;
	archiveChain = Promise.resolve();
}
/**
* Record one snapshot as an archive commit. `before === null` (file creation)
* commits a no-blob marker so commit order keeps matching snapshot indices.
*/
function recordArchive(scope, snapshot) {
	queueArchive(async () => {
		await ensureArchiveRepo(scope);
		if (gitBin === false) return;
		const repo = archiveRepoPath(scope);
		const ref = pathToRef(snapshot.filePath);
		const subject = `file-undo ${snapshot.command} ${ref}`;
		let parent;
		let blob;
		try {
			const head = await runGit([
				"-C",
				repo,
				"rev-parse",
				"--verify",
				"--quiet",
				ARCHIVE_BRANCH
			]);
			if (head.code === 0) parent = head.stdout.toString("utf8").trim();
		} catch {}
		if (snapshot.before !== null) blob = (await runGit([
			"-C",
			repo,
			"hash-object",
			"-w",
			"--stdin"
		], Buffer.from(snapshot.before, "utf8"))).stdout.toString("utf8").trim();
		const treeEntry = blob === void 0 ? "" : `100644 blob ${blob}\tfile\n`;
		const commitArgs = [
			"-C",
			repo,
			"commit-tree",
			(await runGit([
				"-C",
				repo,
				"mktree"
			], treeEntry)).stdout.toString("utf8").trim(),
			"-m",
			subject,
			"-m",
			`time: ${snapshot.time}`
		];
		if (parent !== void 0) commitArgs.splice(3, 0, "-p", parent);
		const commitSha = (await runGit(commitArgs)).stdout.toString("utf8").trim();
		await runGit([
			"-C",
			repo,
			"update-ref",
			ARCHIVE_BRANCH,
			commitSha
		]);
	});
}
/** Wait for queued archive work to settle (verification/tests only). */
function archiveSettled() {
	return archiveChain;
}
/** Human-readable archive state for /undo git-status. */
async function archiveStatus(scope) {
	await archiveSettled();
	await ensureArchiveRepo(scope);
	if (gitBin === false) return "git archive disabled: no git binary found. Snapshots remain local-only.";
	const repo = archiveRepoPath(scope);
	try {
		const count = await runGit([
			"-C",
			repo,
			"rev-list",
			"--count",
			ARCHIVE_BRANCH
		]);
		const head = await runGit([
			"-C",
			repo,
			"rev-parse",
			"--short",
			ARCHIVE_BRANCH
		]);
		return `git archive: ${count.stdout.toString("utf8").trim()} commit(s), head ${head.stdout.toString("utf8").trim()} (${repo})`;
	} catch {
		return `git archive: repository initialized, no commits yet (${repo})`;
	}
}
/**
* Restore snapshot index `index` from the git archive instead of the JSONL
* store. `index` defaults to the newest commit. The target's CURRENT content
* is not snapshotted first — this is an explicit archive restore, and /undo
* remains the safe path for live edits.
*/
async function restoreFromArchive(ctx, scope, index, session) {
	await archiveSettled();
	await ensureArchiveRepo(scope);
	if (gitBin === false) return {
		kind: "error",
		text: "git archive unavailable: no git binary found. Use /undo (local snapshots) instead."
	};
	const repo = archiveRepoPath(scope);
	try {
		const total = await runGit([
			"-C",
			repo,
			"rev-list",
			"--count",
			ARCHIVE_BRANCH
		]);
		const count = Number.parseInt(total.stdout.toString("utf8").trim(), 10);
		if (!Number.isFinite(count) || count <= 0) return {
			kind: "error",
			text: "git archive is empty."
		};
		const resolvedIndex = index ?? count - 1;
		if (resolvedIndex < 0 || resolvedIndex >= count) return {
			kind: "error",
			text: `No archive commit at index ${resolvedIndex} (0..${count - 1}).`
		};
		const commitSha = (await runGit([
			"-C",
			repo,
			"rev-list",
			ARCHIVE_BRANCH
		], void 0)).stdout.toString("utf8").split("\n").filter(Boolean)[resolvedIndex];
		const parts = (await runGit([
			"-C",
			repo,
			"log",
			"-1",
			"--format=%s",
			commitSha
		])).stdout.toString("utf8").trim().split(" ");
		if (parts.length < 3 || parts[0] !== "file-undo") return {
			kind: "error",
			text: `Archive commit ${commitSha} is not a file-undo record.`
		};
		const command = parts[1];
		const filePath = refToPath(parts.slice(2).join(" "));
		if (filePath === void 0) return {
			kind: "error",
			text: `Cannot decode file path from archive commit ${commitSha}.`
		};
		const entry = (await runGit([
			"-C",
			repo,
			"ls-tree",
			commitSha
		])).stdout.toString("utf8").split("\n").find((line) => line.includes("	file"));
		if (entry === void 0) return {
			kind: "error",
			text: `Snapshot ${resolvedIndex} is a file creation (${filePath}); the archive holds no before-state to restore.`
		};
		const blobSha = entry.split(/\s+/)[2];
		const blob = await runGit([
			"-C",
			repo,
			"cat-file",
			"blob",
			blobSha
		]);
		const target = await ctx.fs.resolve(filePath);
		const policy = ctx.sandboxPolicy.resolve({ session });
		await ctx.fs.writeText(target, blob.stdout.toString("utf8"), void 0, void 0, policy);
		return {
			kind: "success",
			text: `Restored ${filePath} from git archive commit ${resolvedIndex} (undo-equivalent of ${command}).`
		};
	} catch (error) {
		return {
			kind: "error",
			text: `git archive restore failed: ${String(error)}`
		};
	}
}
//#endregion
export { apply, archiveSettled, inject, name, resetArchiveForTest };
