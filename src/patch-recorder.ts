/** Capture guarded native patch deletions without changing the tool's decision. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  buildPatchDeletions, matchesPatchDeletionBefore, PATCH_SNAPSHOT_MAX_BYTES,
} from './patch-capture.js'
import { sha256, workspaceKeyOf, type FileUndoSnapshot, type StoreScope } from './store.js'

// The event is absent from the older supported DSH types. Its current public
// declaration is kept here so older hosts can still load the write/edit plugin.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'fs/delete-intent'(
      target: FsTarget, actor: object | undefined,
      next: () => { version: FsVersion } | undefined | Promise<{ version: FsVersion } | undefined>,
    ): Promise<{ version: FsVersion } | undefined>
  }
}

interface CapturedDeletion {
  readonly before: string
  readonly path: string
}

function patchExecution(actor: object | undefined): ToolExecution | undefined {
  if (actor === undefined) return undefined
  const candidate = actor as Partial<ToolExecution>
  return candidate.name === 'apply_patch' && typeof candidate.callId === 'string'
    && candidate.agent !== undefined && candidate.signal instanceof AbortSignal
    ? candidate as ToolExecution : undefined
}

/** A compound patch needs its own transaction history, not isolated deletes. */
async function repeatedTargets(ctx: Context, result: unknown, cwd: string): Promise<Set<string>> {
  // Called only after buildPatchDeletions validates the canonical envelope.
  const { operations } = (result as { value: { operations: unknown[] } }).value
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const operation of operations) {
    if (operation === null || typeof operation !== 'object') throw new Error('Invalid patch operation')
    const op = operation as { path?: unknown; destination?: unknown; changes?: { path?: unknown }[] }
    const paths = [op.path, op.destination, ...(op.changes ?? []).map(change => change.path)]
    const targets = new Set<string>()
    for (const path of paths) {
      if (path === undefined) continue
      if (typeof path !== 'string' || path === '') throw new Error('Invalid patch path')
      const target = await ctx.fs.resolve(path, { cwd })
      targets.add(String(target.targetKey))
    }
    for (const target of targets) {
      if (seen.has(target)) repeated.add(target)
      seen.add(target)
    }
  }
  return repeated
}

/**
 * Register capture at the resolved delete intent and commit only deletions the
 * real tool reports as completed. Unguarded deletes cannot prove which raw
 * bytes were removed, so they are deliberately not added to the undo history.
 */
export function installPatchRecorder(
  ctx: Context,
  save: (scope: StoreScope, snapshot: FileUndoSnapshot) => Promise<void>,
): void {
  let pending = new WeakMap<object, Map<string, CapturedDeletion>>()
  ctx.effect(function* () {
    yield () => { pending = new WeakMap() }
  })
  ctx.on('fs/delete-intent', async (target, actor, next) => {
    const intent = await next()
    const exec = patchExecution(actor)
    if (exec === undefined) return intent
    // A commit intent supersedes the preflight observation, even when its
    // fresh capture fails. Never reuse older bytes from a different version.
    pending.get(exec)?.delete(String(target.targetKey))
    if (intent === undefined) return intent
    try {
      const fs = ctx.fs
      const before = await fs.stat(target, exec.signal)
      if (before?.type !== 'file' || before.version !== intent.version) return intent
      const bytes = await fs.readBytes(target, exec.signal, PATCH_SNAPSHOT_MAX_BYTES)
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      if (text.includes('\0')) return intent
      const after = await fs.stat(target, exec.signal)
      if (after?.type !== 'file' || after.version !== before.version) return intent
      let captured = pending.get(exec)
      if (captured === undefined) pending.set(exec, captured = new Map())
      captured.set(String(target.targetKey), { before: text, path: fs.processPath(target) })
    } catch (error) {
      // Capture is optional; a failed read must not turn an admitted deletion
      // into a fabricated empty-file snapshot or change its original guard.
      console.error('[file-undo] patch deletion capture unavailable:', error)
    }
    return intent
  }, { prepend: true })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const captured = pending.get(exec)
    pending.delete(exec)
    if (captured !== undefined && exec.agent !== undefined) {
      const cwd = exec.agent.session.header.cwd
      if (typeof cwd === 'string' && cwd !== '') {
        const scope = { workspaceKey: workspaceKeyOf(cwd), chatKey: exec.agent.id }
        const deletions = buildPatchDeletions(exec, result)
        let repeated: Set<string>
        try {
          repeated = deletions.length > 0 ? await repeatedTargets(ctx, result, cwd) : new Set()
        } catch (error) {
          console.error('[file-undo] patch paths unavailable:', error)
          return next()
        }
        for (const deletion of deletions) {
          try {
            const target = await ctx.fs.resolve(deletion.path, { cwd })
            const targetKey = String(target.targetKey)
            if (repeated.has(targetKey)) continue
            const original = captured.get(targetKey)
            if (original === undefined || !matchesPatchDeletionBefore(original.before, deletion)) continue
            captured.delete(targetKey)
            await save(scope, {
              id: randomUUID(), filePath: original.path, command: 'apply_patch', op: 'delete',
              callId: deletion.callId, before: original.before, beforeHash: sha256(original.before),
              after: null, afterHash: null, afterAbsent: true, time: Date.now(), state: 'recorded',
              ...(deletion.rootCallId === undefined ? {} : { rootCallId: deletion.rootCallId }),
            })
          } catch (error) {
            // The filesystem effect already happened. Report a missing undo
            // record without converting it into a retryable tool failure.
            console.error('[file-undo] patch deletion record failed:', error)
          }
        }
      }
    }
    return next()
  }, { prepend: true })
}
