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
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'   // ctx.tools + tools/* Events 类型合并
import type {} from '@deepseek-ai/dsh-fs'      // ctx.fs 类型合并
import type {} from '@deepseek-ai/dsh-commands' // ctx.commands 类型合并
import type {} from '@deepseek-ai/dsh-sandbox-policy' // ctx.sandboxPolicy 类型合并
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  appendSnapshot,
  backfillAfter,
  DEFAULT_PRUNE_DAYS,
  loadSnapshots,
  markAbortedByCall,
  markReverted,
  pruneSnapshots,
  recoverActiveScope,
  sha256,
  scopeDir,
  workspaceKeyOf,
  type FileUndoSnapshot,
  type StoreScope,
} from './store.js'
import { buildApi, isTrustedApiRequest, readJsonBody, ApiError, type SessionQueryLike, type SessionsResult } from './api.js'

export const name = 'file-undo'
export const inject = ['commands', 'tools', 'fs', 'sandboxPolicy']

// ── Active-scope tracking ────────────────────────────────────────────────────

/**
 * The most recently active store scope (updated on every mutating tool call).
 * The HTTP API is browser-driven and carries no session of its own, so it
 * reads this to decide which store to serve. First tool call in a fresh
 * process wins until a newer one arrives; `/undo` commands also refresh it.
 */
let activeScope: StoreScope | undefined

/** Read the session identity (cwd + session id) off an agent-shaped object. */
function agentScope(agent: unknown): StoreScope | undefined {
  const a = agent as { id?: unknown; session?: { header?: { cwd?: unknown } } } | undefined
  if (a === undefined) return undefined
  const cwd = a.session?.header?.cwd
  const chatKey = a.id
  if (typeof cwd !== 'string' || cwd === '' || typeof chatKey !== 'string' || chatKey === '') return undefined
  return { workspaceKey: workspaceKeyOf(cwd), chatKey }
}

// ── Snapshot capture (pre) + after backfill (post) ───────────────────────────

/**
 * The session's working directory, read from the tool execution's agent.
 * The tool's `file_path` argument is relative to THIS, not the host process
 * cwd (launch-root) — resolving a relative path against the host cwd reads
 * nothing (the file lives under the session workspace). Cast structurally so
 * this does not depend on dsh-agent/dsh-session types being resolvable here.
 */
function sessionCwd(exec: ToolExecutionInput): string | undefined {
  const agent = exec.agent as unknown as { session?: { header?: { cwd?: string } } } | undefined
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * Extract the file mutation out of one tool call, per docs/tool-catalog.md
 * (GENERATED + verified against the running tools, so this is the
 * authoritative name/argument surface):
 * - `@deepseek-ai/dsh-tool-fs`: `write` | `edit`, target in `file_path`;
 *   every call mutates.
 * - `@deepseek-ai/dsh-tool-str-replace-editor`: `str_replace_editor` with
 *   target in `path` and a sub-`command`: only `create` | `str_replace` |
 *   `insert` mutate (`view` is read-only and must NOT snapshot).
 * Shell tools (bash/pwsh/run_code) mutate outside the fs seam and stay out of
 * scope — the known shell blind spot (TROUBLESHOOTING bash_ignored).
 */
interface FileMutation {
  path: string
  /** Sub-command for multi-command tools; equals the tool name otherwise. */
  op: string
}

function mutationOf(exec: ToolExecutionInput): FileMutation | undefined {
  const args = exec.arguments as { file_path?: unknown; path?: unknown; command?: unknown } | undefined
  if (args === undefined || typeof args !== 'object') return undefined
  if ((exec.name === 'write' || exec.name === 'edit') && typeof args.file_path === 'string' && args.file_path !== '') {
    return { path: args.file_path, op: exec.name }
  }
  if (exec.name === 'str_replace_editor') {
    const cmd = args.command
    if (
      (cmd === 'create' || cmd === 'str_replace' || cmd === 'insert') &&
      typeof args.path === 'string' && args.path !== ''
    ) {
      return { path: args.path, op: cmd }
    }
  }
  return undefined
}

/** Capture the before-state of one mutating tool call; never throws. */
async function snapshotIfMutation(exec: ToolExecutionInput, fs: FileSystem): Promise<void> {
  const mutation = mutationOf(exec)
  if (mutation === undefined) return
  const scope = agentScope(exec.agent)
  if (scope === undefined) return
  activeScope = scope
  try {
    const cwd = sessionCwd(exec)
    const target = await fs.resolve(mutation.path, cwd !== undefined ? { cwd } : undefined)
    let before: string | null = null
    try {
      before = await fs.readText(target)
    } catch {
      // write of a new file: target absent; before stays null.
    }
    // Store the RESOLVED stable identity (targetKey: a realpath on the local
    // backend) instead of the tool's raw argument: detail/apply later re-resolve
    // in the host process, whose cwd (launch-root) differs from the session's,
    // so a relative path would resolve against the wrong base and read nothing.
    const absolutePath = String(target.targetKey)
    const callId = typeof exec.callId === 'string' ? exec.callId : undefined
    // 1.3（v7.1）：pre-execute 的 ToolExecutionInput.rootCallId 类型上可选 ——
    // append 时尽力存；backfill 时强制补写（保底落盘点）。
    const rootCallId = typeof exec.rootCallId === 'string' && exec.rootCallId !== '' ? exec.rootCallId : undefined
    const snapshot: FileUndoSnapshot = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      filePath: absolutePath,
      command: exec.name,
      before,
      beforeHash: before === null ? null : sha256(before),
      after: null,
      afterHash: null,
      time: Date.now(),
      state: 'recorded',
      ...(mutation.op !== exec.name ? { op: mutation.op } : {}),
      ...(callId !== undefined ? { callId } : {}),
      ...(rootCallId !== undefined ? { rootCallId } : {}),
    }
    await appendSnapshot(scope, snapshot)
    recordArchive(scope, snapshot) // layer B: best-effort, degrades silently
  } catch (error) {
    console.error('[file-undo] snapshot failed:', error)
  }
}

/** Backfill the after-state once the mutating tool settled; never throws. */
async function backfillIfMutation(exec: ToolExecutionInput, fs: FileSystem): Promise<void> {
  const mutation = mutationOf(exec)
  if (mutation === undefined) return
  const scope = agentScope(exec.agent)
  if (scope === undefined) return
  activeScope = scope
  const callId = typeof exec.callId === 'string' ? exec.callId : undefined
  try {
    const cwd = sessionCwd(exec)
    const target = await fs.resolve(mutation.path, cwd !== undefined ? { cwd } : undefined)
    let after: string | null = null
    try {
      after = await fs.readText(target)
    } catch {
      // the op (or something else) removed the file; record the absence.
    }
    // Pair EXACTLY by call identity (see backfillAfter) — the legacy
    // path+oldest heuristic mis-aligned one entry per failed sibling call.
    const absolutePath = String(target.targetKey)
    // 1.3（v7.1）：post-execute 的 ToolExecution.rootCallId 必填 —— 保底补写。
    const rootCallId = typeof exec.rootCallId === 'string' && exec.rootCallId !== '' ? exec.rootCallId : undefined
    await backfillAfter(scope, absolutePath, after, callId, rootCallId)
  } catch (error) {
    console.error('[file-undo] backfill read failed:', error)
  }
}

// ── Optional ctx.sessionQuery seam (turn badges read the authoritative log) ──

/**
 * sessionQueryRef 捕获 ctx.sessionQuery（v0.3.10）。
 *
 * P1 教训的对称应用：可选服务绝不加进顶层 inject（那是必需语义，headless /
 * 无查询后端的 profile 会因此加载失败），而是 ctx.inject(['sessionQuery'], …)
 * 响应式等待——回调在缝挂载时运行、服务变更时重跑；永不挂载则永不运行，
 * history 条目自然退化为无轮次徽章，与 webServer 的挂载方式完全同构。
 */
const sessionQueryRef: { current: SessionQueryLike | undefined } = { current: undefined }

function watchSessionQuery(ctx: Context): void {
  ctx.inject(['sessionQuery'], subCtx => {
    sessionQueryRef.current = subCtx.get('sessionQuery') as SessionQueryLike | undefined
  })
}

// ── Web API mounting (reactive: headless profiles simply skip it) ────────────

interface WebServerLike {
  register(route: { kind: 'prefix' | 'exact'; path: string; handler: (req: unknown, res: unknown) => Promise<void> }): () => void
}

interface WebRuntimeLike {
  trustedHosts?: readonly string[]
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
function mountWebApi(ctx: Context): void {
  ctx.inject(['webServer'], (subCtx) => {
    const webServer = subCtx.get('webServer') as WebServerLike | undefined
    if (webServer === undefined) return
    const api = buildApi(ctx, () => activeScope, () => sessionQueryRef.current)
    const disposeRoute = webServer.register({
      kind: 'prefix',
      path: '/file-undo/api',
      handler: async (reqRaw: unknown, resRaw: unknown) => {
        const req = reqRaw as {
          method?: string
          url?: string
          headers: Record<string, unknown>
          [Symbol.asyncIterator](): AsyncIterableIterator<unknown>
        }
        const res = resRaw as {
          writeHead(status: number, headers?: Record<string, string>): void
          end(body?: string): void
        }
        // Read per-request: webRuntime (trusted hosts) may appear or restart
        // independently of webServer.
        const webRuntime = (typeof ctx.get === 'function' ? ctx.get('webRuntime') : undefined) as WebRuntimeLike | undefined
        if (!isTrustedApiRequest(req, webRuntime?.trustedHosts ?? [])) {
          finish(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
        if (req.method !== 'POST') {
          finish(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const method = pathname.startsWith('/file-undo/api/') ? pathname.slice('/file-undo/api/'.length) : undefined
        if (method === undefined || method.includes('/')) {
          finish(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown file-undo API method' } })
          return
        }
        try {
          const payload = await readJsonBody(req)
          const handler = api[method]
          if (handler === undefined) throw new ApiError('not-found', `unknown file-undo API method "${method}"`, 404)
          const value = await handler(payload)
          finish(res, 200, { ok: true, value })
        } catch (error) {
          if (error instanceof ApiError) {
            finish(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
            return
          }
          finish(res, 500, {
            ok: false,
            error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
          })
        }
      },
    })
    return disposeRoute
  })
}

function finish(
  res: { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void },
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export function apply(ctx: Context): void {
  // Watch for the optional sessionQuery seam (turn enrichment, v0.3.10).
  watchSessionQuery(ctx)
  // Recover the last active scope from disk so the panel re-binds after a
  // restart. `activeScope` is module-level and resets to undefined on every
  // host start, so without this the panel would show "no records" even though
  // the scoped stores persist on disk. The recovery is a fast readdir+stat;
  // by the time the user opens the panel it has long settled.
  const scopeReady = recoverActiveScope()
    .then(scope => {
      if (scope !== undefined) activeScope = scope
    })
    .catch(() => {})

  // ── Intercept: capture before-state, backfill after-state ────────────────
  ctx.on('tools/pre-execute', async (exec: ToolExecutionInput, next: () => Promise<PreToolDecision>) => {
    const fs = ctx.fs
    if (fs !== undefined) await snapshotIfMutation(exec, fs)
    return next()
  })
  ctx.on('tools/post-execute', async (exec: ToolExecution, result: unknown, next: () => Promise<PostToolDecision>): Promise<PostToolDecision> => {
    const fs = ctx.fs
    if (fs !== undefined) {
      // A failed call never wrote anything: its pre snapshot becomes a
      // failure-log row (aborted, carries the error reason) — visible in the
      // panel for timeline fidelity, never undoable. Exact callId pairing
      // means it can't poison siblings.
      const failed = (result as { isError?: unknown } | undefined)?.isError === true
      if (failed && typeof exec.callId === 'string') {
        const scope = agentScope(exec.agent)
        if (scope !== undefined) {
          const errObj = (result as { error?: unknown }).error
          const reason =
            typeof errObj === 'string' ? errObj
            : errObj instanceof Error ? errObj.message
            : typeof (errObj as { message?: unknown } | undefined)?.message === 'string' ? (errObj as { message: string }).message
            : undefined
          await markAbortedByCall(scope, exec.callId, reason !== undefined ? reason.slice(0, 200) : undefined)
        }
      } else {
        await backfillIfMutation(exec, fs)
      }
    }
    return next()
  })

  // ── Visual surface: JSON API behind the web server (reactive mount) ──────
  mountWebApi(ctx)

  // ── Undo entry point (chat command family) ────────────────────────────────
  ctx.effect(function* () {
    // Lazy retention sweep: wait for the recovery to settle first so it
    // targets the recovered scope, then prune. Failure must never block
    // command registration.
    void scopeReady.then(() => {
      if (activeScope !== undefined) {
        pruneSnapshots(activeScope, DEFAULT_PRUNE_DAYS).catch(error => {
          console.error('[file-undo] lazy prune failed:', error)
        })
      }
    })

    yield ctx.commands.register({
      name: 'undo',
      description:
        'Undo file write/edit operations. Usage: /undo (last), /undo list, /undo <n>, /undo sessions, /undo prune [days], /undo git [n], /undo git-status',
      input: { hint: '[list | sessions | <n> | prune [days] | git [n] | git-status]' },
      handler: async (invocation): Promise<CommandResult> => {
        const raw = invocation.rawInput.trim()
        const scope = agentScope(invocation.agent)
        if (scope === undefined) {
          return { kind: 'error', text: 'No active session context; open a session and try again.' }
        }
        activeScope = scope
        const session: Session = invocation.agent.session

        // ── /undo git-status: archive health ──────────────────────────────────
        if (raw === 'git-status') {
          return { kind: 'success', text: await archiveStatus(scope) }
        }
        // ── /undo git [n]: restore from the git archive ──────────────────────
        if (raw === 'git' || raw.startsWith('git ')) {
          const arg = raw.split(/\s+/)[1]
          let index: number | undefined
          if (arg !== undefined) {
            const parsed = Number(arg)
            if (!Number.isInteger(parsed) || parsed < 0) {
              return { kind: 'error', text: `Invalid archive index "${arg}". Usage: /undo git [n] (0 = newest commit).` }
            }
            index = parsed
          }
          return restoreFromArchive(ctx, scope, index, session)
        }
        // ── /undo sessions: the switcher directory (会话跟随) + diagnostics ──
        if (raw === 'sessions') {
          return { kind: 'success', text: await describeSessions(ctx, scope) }
        }
        // ── /undo prune [days]: drop snapshots older than N days (default 7) ─
        if (raw === 'prune' || raw.startsWith('prune ')) {
          const arg = raw.split(/\s+/)[1]
          let days = DEFAULT_PRUNE_DAYS
          if (arg !== undefined) {
            const parsed = Number(arg)
            if (!Number.isFinite(parsed) || parsed <= 0) {
              return { kind: 'error', text: `Invalid prune retention "${arg}". Usage: /undo prune [days] (days > 0, default ${DEFAULT_PRUNE_DAYS}).` }
            }
            days = parsed
          }
          return { kind: 'success', text: await pruneSnapshots(scope, days) }
        }
        // ── /undo list: show the recorded operation history ──────────────────
        if (raw === 'list') {
          const all = await loadSnapshots(scope)
          if (all.length === 0) return { kind: 'error', text: 'No file operations recorded yet.' }
          const lines = all.map((s, i) => {
            const badge =
              s.state === 'reverted' ? ' [undone]'
              : s.state === 'reapplied' ? ' [reapplied]'
              : s.state === 'aborted' ? ' [failed]'
              : s.state === 'noop' ? ' [no-op]'
              : ''
            const time = s.time > 0 ? new Date(s.time).toLocaleTimeString() : '?'
            return `[${i}] ${time} ${s.command} ${s.filePath}${badge}`
          })
          return { kind: 'success', text: `Undo history (${all.length}):\n${lines.join('\n')}` }
        }
        // ── /undo <n>: pick a specific operation point ───────────────────────
        if (/^\d+$/.test(raw)) {
          const index = Number(raw)
          const all = await loadSnapshots(scope)
          const snapshot = all[index]
          if (snapshot === undefined) return { kind: 'error', text: `No operation at index ${index} (0..${all.length - 1}).` }
          if (snapshot.state === 'aborted') {
            return { kind: 'error', text: `Operation [${index}] failed and never changed the file (${snapshot.failReason ?? 'unknown reason'}) — nothing to undo.` }
          }
          if (snapshot.state === 'noop') {
            return { kind: 'error', text: `Operation [${index}] did not change the file — nothing to undo.` }
          }
          return restoreSnapshot(ctx, scope, snapshot, session)
        }
        // ── /undo: the most recent operation ─────────────────────────────────
        const all = await loadSnapshots(scope)
        const last = all[all.length - 1]
        if (last === undefined) return { kind: 'error', text: 'Nothing to undo.' }
        return restoreSnapshot(ctx, scope, last, session)
      },
    })
  }, 'file-undo lifecycle')
}

/**
 * List the sessions the switcher offers (会话跟随) — discovery and diagnostics
 * in one line: it goes through the EXACT `sessions` API the panel uses, so
 * whatever this prints is what the panel sees. Reports the title-seam state,
 * which is the answer to "why does the switcher show ids instead of names?".
 */
async function describeSessions(ctx: Context, scope: StoreScope): Promise<string> {
  const seam = sessionQueryRef.current
  const api = buildApi(ctx, () => scope, () => seam)
  const result = (await api.sessions({})) as SessionsResult
  // Report the seam's actual surface: "no titles" has two very different causes
  // (the host exposes no title method vs the sessions carry no title event),
  // and this line is what tells them apart for someone reading the output.
  const surface = seam === undefined
    ? 'ctx.sessionQuery 未挂载'
    : ['listSessions', 'readTitleSnapshots', 'readTitle']
      .map(name => `${name}:${typeof (seam as Record<string, unknown>)[name] === 'function' ? '有' : '无'}`)
      .join(' ')
  if (!result.available) {
    return `会话目录不可用：当前 host 未提供 ctx.sessionQuery.listSessions（headless 或旧版 DSH）。面板会自动隐藏切换器。\n缝能力：${surface}`
  }
  const titled = result.items.filter(s => s.title !== undefined).length
  const lines = result.items.map(s => {
    const label =
      s.title !== undefined
        ? s.title
        : `${s.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(part => part !== '').slice(-1)[0] ?? s.cwd} · ${s.id.replace(/^session-/, '').slice(0, 8)}`
    const flags = [s.current ? '当前' : null, s.live ? '活跃' : '仅存档', s.hasRecords ? '有记录' : '无记录']
      .filter((flag): flag is string => flag !== null)
      .join(' · ')
    return `  ${label}（${flags}）\n    ${s.cwd}`
  })
  const titleNote =
    titled === result.items.length
      ? '标题：全部取自平台'
      : titled === 0
        ? '标题：平台未提供（readTitleSnapshots / readTitle 均无）→ 回退为「目录名 · 短 id」'
        : `标题：${titled}/${result.items.length} 取自平台，其余回退为「目录名 · 短 id」`
  return [`会话目录：${result.items.length} 个同项目树会话（当前 ${result.currentId}）；${titleNote}`, `缝能力：${surface}`, ...lines].join('\n')
}

/** Restore one snapshot's before-state via the official fs service. */
async function restoreSnapshot(ctx: Context, scope: StoreScope, snapshot: FileUndoSnapshot, session: Session): Promise<CommandResult> {
  if (snapshot.state === 'aborted') {
    return { kind: 'error', text: `Operation on ${snapshot.filePath} failed and never changed the file (${snapshot.failReason ?? 'unknown reason'}) — nothing to undo.` }
  }
  if (snapshot.state === 'noop') {
    return { kind: 'error', text: `Operation on ${snapshot.filePath} did not change the file — nothing to undo.` }
  }
  if (snapshot.before === null) {
    // File creation undo = delete the file. The official fs seam has no
    // delete, so this goes through node fs directly in the host process —
    // the same explicit-escape rationale as danger-full-access writes (P3):
    // a two-phase user-confirmed action. Safety gates mirror the HTTP API:
    // refuse when content was never captured, and refuse when the file
    // changed since creation (hash gate) so later edits are never destroyed.
    if (snapshot.after === null) {
      return { kind: 'error', text: `Cannot undo a file creation (${snapshot.filePath}) — the created content was never captured, so a delete cannot be verified as safe.` }
    }
    if (snapshot.state === 'reverted') {
      return { kind: 'error', text: `Operation on ${snapshot.filePath} was already undone.` }
    }
    return (async () => {
      try {
        const target = await ctx.fs.resolve(snapshot.filePath)
        let current: string | null = null
        try {
          current = await ctx.fs.readText(target)
        } catch {
          // already gone — the undo is effectively done; record it.
        }
        if (current !== null && snapshot.afterHash !== null && sha256(current) !== snapshot.afterHash) {
          return { kind: 'error', text: `File ${snapshot.filePath} changed after it was created — refusing to delete (the later edits would be lost).` }
        }
        const { unlink } = await import('node:fs/promises')
        try {
          await unlink(String(target.targetKey))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await markReverted(scope, snapshot.id)
        return {
          kind: 'success',
          text: current === null
            ? `${snapshot.filePath} no longer exists — creation recorded as undone.`
            : `Deleted ${snapshot.filePath} (undo of creation).`,
        }
      } catch (error) {
        return { kind: 'error', text: `Undo failed: ${String(error)}` }
      }
    })()
  }
  if (snapshot.state === 'reverted') {
    return { kind: 'error', text: `Operation on ${snapshot.filePath} was already undone.` }
  }
  try {
    const target = await ctx.fs.resolve(snapshot.filePath)
    // Carry the caller session's sandbox policy so the restore writes under
    // the same workspace boundary the original mutation ran under.
    const policy = ctx.sandboxPolicy.resolve({ session })
    await ctx.fs.writeText(target, snapshot.before, undefined, undefined, policy)
    await markReverted(scope, snapshot.id)
    return { kind: 'success', text: `Restored ${snapshot.filePath} (undo of ${snapshot.command}).` }
  } catch (error) {
    return { kind: 'error', text: `Undo failed: ${String(error)}` }
  }
}

// ── Git archive (layer B): mirror every snapshot's before-state as one commit ──
//
// Each snapshot line gets one commit in a dedicated archive repo
// (<scope>/git-archive). Commit order 1:1 matches snapshot order, so
// /undo git [n] restores the same point /undo <n> would. The original file is
// never touched — rollback stays /undo's job; git only extends how far back
// pruned snapshots can still be recovered.
//
// Paths live base64url-encoded in the commit subject because Windows paths
// (C:\, ':') are not valid git tree paths. Any failure degrades silently to
// the pure-local snapshot store (the layer-B contract).

const ARCHIVE_BRANCH = 'refs/heads/file-undo-archive'

/** Resolved git binary, `false` once detection gave up, `undefined` while pending. */
let gitBin: string | false | undefined

/** Serializes every archive mutation (git objects are not concurrency-safe here). */
let archiveChain: Promise<void> = Promise.resolve()

function archiveRepoPath(scope: StoreScope): string {
  return join(scopeDir(scope), 'git-archive')
}

function pathToRef(filePath: string): string {
  return Buffer.from(filePath, 'utf8').toString('base64url')
}

function refToPath(ref: string): string | undefined {
  try {
    return Buffer.from(ref, 'base64url').toString('utf8')
  } catch {
    return undefined
  }
}

function runGit(args: string[], input?: string | Buffer): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (typeof gitBin !== 'string') return reject(new Error('git unavailable'))
    const child = execFile(gitBin, args, {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10_000,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'dsh-file-undo',
        GIT_AUTHOR_EMAIL: 'file-undo@localhost',
        GIT_COMMITTER_NAME: 'dsh-file-undo',
        GIT_COMMITTER_EMAIL: 'file-undo@localhost',
      },
    }, (error, stdout, stderr) => {
      const errCode = error === null || error === undefined ? 0 : (error as { code?: unknown }).code
      if (typeof errCode !== 'number') {
        // spawn-level failure (ENOENT etc.) — git itself is unusable.
        return reject(error)
      }
      resolve({ code: errCode, stdout, stderr: (stderr as Buffer).toString('utf8') })
    })
    if (input !== undefined && child.stdin !== null) child.stdin.write(input)
    if (child.stdin !== null) child.stdin.end()
  })
}

/** Locate a git binary once; result cached for the process lifetime. */
async function detectGit(): Promise<void> {
  if (gitBin !== undefined) return
  const candidates = process.platform === 'win32' ? ['git.exe', 'git'] : ['git']
  for (const candidate of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(candidate, ['--version'], { timeout: 5_000 }, error => (error ? reject(error) : resolve()))
      })
      gitBin = candidate
      return
    } catch {
      // try the next candidate
    }
  }
  gitBin = false
}

/** Create the archive repo on first use. Never throws. */
async function ensureArchiveRepo(scope: StoreScope): Promise<void> {
  await detectGit()
  if (gitBin === false) return
  try {
    await mkdir(archiveRepoPath(scope), { recursive: true })
    const probe = await runGit(['-C', archiveRepoPath(scope), 'rev-parse', '--git-dir'])
    if (probe.code === 0) return
    await runGit(['-C', archiveRepoPath(scope), 'init', '--bare', '-b', 'file-undo-archive'])
  } catch {
    // Degradation contract: the snapshot store stays the source of truth.
  }
}

/** Queue one archive mutation behind any in-flight one. Never rejects. */
function queueArchive(task: () => Promise<void>): void {
  archiveChain = archiveChain.then(task).catch(() => undefined)
}

/** Test hook: forget cached git state so detection re-runs. */
export function resetArchiveForTest(): void {
  gitBin = undefined
  archiveChain = Promise.resolve()
}

/**
 * Record one snapshot as an archive commit. `before === null` (file creation)
 * commits a no-blob marker so commit order keeps matching snapshot indices.
 */
function recordArchive(scope: StoreScope, snapshot: FileUndoSnapshot): void {
  queueArchive(async () => {
    await ensureArchiveRepo(scope)
    if (gitBin === false) return
    const repo = archiveRepoPath(scope)
    const ref = pathToRef(snapshot.filePath)
    const subject = `file-undo ${snapshot.command} ${ref}`
    let parent: string | undefined
    let blob: string | undefined
    try {
      const head = await runGit(['-C', repo, 'rev-parse', '--verify', '--quiet', ARCHIVE_BRANCH])
      if (head.code === 0) parent = head.stdout.toString('utf8').trim()
    } catch { /* first commit has no parent */ }
    if (snapshot.before !== null) {
      const hashed = await runGit(['-C', repo, 'hash-object', '-w', '--stdin'], Buffer.from(snapshot.before, 'utf8'))
      blob = hashed.stdout.toString('utf8').trim()
    }
    const treeEntry = blob === undefined ? '' : `100644 blob ${blob}\tfile\n`
    const tree = await runGit(['-C', repo, 'mktree'], treeEntry)
    const treeSha = tree.stdout.toString('utf8').trim()
    const commitArgs = ['-C', repo, 'commit-tree', treeSha, '-m', subject, '-m', `time: ${snapshot.time}`]
    if (parent !== undefined) commitArgs.splice(3, 0, '-p', parent)
    const commit = await runGit(commitArgs)
    const commitSha = commit.stdout.toString('utf8').trim()
    await runGit(['-C', repo, 'update-ref', ARCHIVE_BRANCH, commitSha])
  })
}

/** Wait for queued archive work to settle (verification/tests only). */
export function archiveSettled(): Promise<void> {
  return archiveChain
}

/** Human-readable archive state for /undo git-status. */
async function archiveStatus(scope: StoreScope): Promise<string> {
  await archiveSettled()
  await ensureArchiveRepo(scope)
  if (gitBin === false) return 'git archive disabled: no git binary found. Snapshots remain local-only.'
  const repo = archiveRepoPath(scope)
  try {
    const count = await runGit(['-C', repo, 'rev-list', '--count', ARCHIVE_BRANCH])
    const head = await runGit(['-C', repo, 'rev-parse', '--short', ARCHIVE_BRANCH])
    return `git archive: ${count.stdout.toString('utf8').trim()} commit(s), head ${head.stdout.toString('utf8').trim()} (${repo})`
  } catch {
    return `git archive: repository initialized, no commits yet (${repo})`
  }
}

/**
 * Restore snapshot index `index` from the git archive instead of the JSONL
 * store. `index` defaults to the newest commit. The target's CURRENT content
 * is not snapshotted first — this is an explicit archive restore, and /undo
 * remains the safe path for live edits.
 */
async function restoreFromArchive(ctx: Context, scope: StoreScope, index: number | undefined, session: Session): Promise<CommandResult> {
  await archiveSettled()
  await ensureArchiveRepo(scope)
  if (gitBin === false) {
    return { kind: 'error', text: 'git archive unavailable: no git binary found. Use /undo (local snapshots) instead.' }
  }
  const repo = archiveRepoPath(scope)
  try {
    const total = await runGit(['-C', repo, 'rev-list', '--count', ARCHIVE_BRANCH])
    const count = Number.parseInt(total.stdout.toString('utf8').trim(), 10)
    if (!Number.isFinite(count) || count <= 0) return { kind: 'error', text: 'git archive is empty.' }
    const resolvedIndex = index ?? count - 1
    if (resolvedIndex < 0 || resolvedIndex >= count) {
      return { kind: 'error', text: `No archive commit at index ${resolvedIndex} (0..${count - 1}).` }
    }
    // rev-list is newest-first, so index 0 = most recent commit.
    const sha = await runGit(['-C', repo, 'rev-list', ARCHIVE_BRANCH], undefined)
    const commits = sha.stdout.toString('utf8').split('\n').filter(Boolean)
    const commitSha = commits[resolvedIndex]
    const subject = await runGit(['-C', repo, 'log', '-1', '--format=%s', commitSha])
    const parts = subject.stdout.toString('utf8').trim().split(' ')
    if (parts.length < 3 || parts[0] !== 'file-undo') return { kind: 'error', text: `Archive commit ${commitSha} is not a file-undo record.` }
    const command = parts[1]
    const filePath = refToPath(parts.slice(2).join(' '))
    if (filePath === undefined) return { kind: 'error', text: `Cannot decode file path from archive commit ${commitSha}.` }
    const files = await runGit(['-C', repo, 'ls-tree', commitSha])
    const entry = files.stdout.toString('utf8').split('\n').find(line => line.includes('\tfile'))
    if (entry === undefined) {
      return { kind: 'error', text: `Snapshot ${resolvedIndex} is a file creation (${filePath}); the archive holds no before-state to restore.` }
    }
    const blobSha = entry.split(/\s+/)[2]
    const blob = await runGit(['-C', repo, 'cat-file', 'blob', blobSha])
    const target = await ctx.fs.resolve(filePath)
    const policy = ctx.sandboxPolicy.resolve({ session })
    await ctx.fs.writeText(target, blob.stdout.toString('utf8'), undefined, undefined, policy)
    return { kind: 'success', text: `Restored ${filePath} from git archive commit ${resolvedIndex} (undo-equivalent of ${command}).` }
  } catch (error) {
    return { kind: 'error', text: `git archive restore failed: ${String(error)}` }
  }
}
