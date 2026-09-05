/**
 * Isolated verification for the visual undo pipeline (v2.1 scoped):
 * - store v2.1: two-level scoping (workspace × chat), append → backfill →
 *   revert-mark → reapply-mark, self-invalidating stats
 * - diff engine: hunks/line-numbers/stats against hand-checked cases
 * - HTTP API: buildApi against a mock context with a scope accessor
 *   (preview classification, optimistic-concurrency apply, transactional
 *   revert mark, reapply state machine, scope isolation)
 *
 * HOME/USERPROFILE are overridden to a temp dir BEFORE importing lib — the
 * real user store at ~/.dsh/file-undo is never touched.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempHome = await mkdtemp(join(tmpdir(), 'dsh-file-undo-visual-test-'))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome

let failures = 0
function assert(cond, label) {
  if (cond) console.log(`  ✓ ${label}`)
  else { failures++; console.log(`  ✗ ${label}`) }
}

const { structuredDiff, diffStats, cachedStructuredDiff, hunkCache } = await import('./lib/diff.js')
const { appendSnapshot, backfillAfter, markReverted, markReapplied, markAbortedByCall, workspaceKeyOf, canonicalCwd, sameWorkspaceTree, selectWorkspaceMembers,
  loadSnapshots, recoverActiveScope } = await import('./lib/store.js')
const { detectBlankLineArtifact } = await import('./lib/api.js')

// ── 1. workspace key derivation ──────────────────────────────────────────────
console.log('workspace key derivation...')
{
  const k1 = workspaceKeyOf('D:\\demo\\proj')
  const k2 = workspaceKeyOf('D:\\demo\\proj\\')
  const k3 = workspaceKeyOf('/home/user/project')
  // v0.3.12：ONE directory ⇒ ONE key. This used to assert `k1 !== k2`
  // ("trailing separator yields a distinct key") — that assertion locked in
  // the very bug it described: one project's sessions scattering across
  // several store directories, with the panel bound to only one of them.
  assert(k1 === k2, `trailing separator normalised (got ${k1} vs ${k2})`)
  assert(k1 === workspaceKeyOf('D:/demo/proj'), 'forward slashes normalised')
  assert(k1 === workspaceKeyOf('d:\\demo\\proj'), 'drive-letter case normalised')
  assert(k1 === workspaceKeyOf('D:\\demo\\proj\\\\'), 'repeated separators collapsed')
  assert(k1 === workspaceKeyOf('D:\\demo\\.\\proj\\'), 'lexical "." resolved')
  assert(k1 === workspaceKeyOf('D:\\demo\\other\\..\\proj'), 'lexical ".." resolved')
  assert(k3.startsWith('home_user_project'), `posix path sanitized, leading separator stripped (got ${k3})`)
  assert(k1.includes('~'), 'hash suffix present')
  assert(!/[\\/:*?"<>|]/.test(k1), 'no filesystem-hostile characters')

  // No-migration regression: keys already on disk for canonical cwds MUST NOT
  // move, or this fix would orphan every existing store.
  if (process.platform === 'win32') {
    assert(k1 === 'D_demo_proj~f5b66f38', `key derivation golden (normalization regression) (got ${k1})`)
    assert(
      workspaceKeyOf('D:\\demo\\proj\\测试') === 'D_demo_proj~90b83bfe',
      `CJK subdir key golden (got ${workspaceKeyOf('D:\\demo\\proj\\测试')})`,
    )
  }

  // Truncation is by code point: a UTF-16 slice can cut a surrogate pair in
  // half and mint a lone surrogate, which is not a legal filename.
  const hasLoneSurrogate = s => /[\uD800-\uDFFF]/.test(s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))
  const longKey = workspaceKeyOf('D:\\' + '😀'.repeat(80))
  assert(!hasLoneSurrogate(longKey), `truncation never splits a surrogate pair (got ${longKey})`)

  // canonicalCwd: lexical only — no I/O, no symlink resolution.
  assert(canonicalCwd('D:\\a\\b\\..\\c') === (process.platform === 'win32' ? 'D:\\a\\c' : '\\a\\c'),
    `lexical ".." resolved (got ${canonicalCwd('D:\\a\\b\\..\\c')})`)
  assert(canonicalCwd('D:\\') === (process.platform === 'win32' ? 'D:\\' : '\\'),
    `filesystem root keeps its separator (got ${canonicalCwd('D:\\')})`)
  assert(canonicalCwd('  D:\\a  ') === canonicalCwd('D:\\a'), 'surrounding whitespace trimmed')
  assert(canonicalCwd('') === '', 'empty cwd stays empty (never a crash)')
}

// ── 1b. same project tree (query-time grouping for the session switcher) ─────
console.log('sameWorkspaceTree grouping...')
{
  assert(sameWorkspaceTree('D:\\proj', 'D:\\proj\\sub'), 'parent/child cwd = same project tree')
  assert(sameWorkspaceTree('D:\\proj\\sub\\', 'd:/proj'), 'reverse order + spelling noise = same tree')
  assert(sameWorkspaceTree('/srv/app', '/srv/app/lib'), 'posix parent/child = same tree')
  assert(!sameWorkspaceTree('D:\\projA', 'D:\\projB'), 'siblings are different trees')
  assert(!sameWorkspaceTree('D:\\proj', 'D:\\projabc'), 'prefix is not containment (path-boundary aware)')
  assert(!sameWorkspaceTree('D:\\', 'D:\\proj'), 'drive root never swallows projects')
  assert(!sameWorkspaceTree('', 'D:\\proj'), 'empty cwd never matches')
}

// ── 1c. anchored grouping (strategy A) ───────────────────────────────────────
console.log('selectWorkspaceMembers (anchored)...')
{
  const members = await selectWorkspaceMembers('D:\\proj', [
    'D:\\proj', 'D:\\proj\\sub', 'D:\\projA', 'D:\\other', 'd:/proj/lib\\',
  ])
  assert(members.length === 3, `anchor collects itself + descendants, spelling-normalised (got ${JSON.stringify(members)})`)
  assert(!members.includes('D:\\projA'), 'sibling project excluded (prefix is not containment)')
  assert(!members.includes('D:\\other'), 'unrelated tree excluded')

  // An anchor inside a sub-directory still sees its ancestor.
  const up = await selectWorkspaceMembers('D:\\proj\\sub', ['D:\\proj', 'D:\\projA'])
  assert(up.includes('D:\\proj') && !up.includes('D:\\projA'), `ancestor included, sibling excluded (got ${JSON.stringify(up)})`)

  // No transitive closure: siblings are never chained through a shared parent —
  // this is the whole point of anchoring instead of clustering pairwise.
  const chained = await selectWorkspaceMembers('D:\\work\\projA', ['D:\\work\\projB', 'D:\\work'])
  assert(chained.length === 1 && chained[0] === 'D:\\work', `projB not chained via D:\\work (got ${JSON.stringify(chained)})`)

  // Known strategy-A limit, pinned deliberately: an anchor that IS the
  // intermediate directory legitimately collects its sibling projects. Only a
  // project-root probe (strategy B) can tell them apart.
  const atRoot = await selectWorkspaceMembers('D:\\work', ['D:\\work\\projA', 'D:\\work\\projB'])
  assert(atRoot.length === 2, `intermediate anchor collects both — strategy-A limit (got ${JSON.stringify(atRoot)})`)

  assert((await selectWorkspaceMembers('', ['D:\\proj'])).length === 0, 'empty anchor collects nothing')
  assert((await selectWorkspaceMembers('D:\\proj', ['', '  '])).length === 0, 'blank candidates skipped')
  assert((await selectWorkspaceMembers('D:\\', ['D:\\proj'])).length === 0, 'filesystem-root anchor collects nothing')
  const dupes = await selectWorkspaceMembers('D:\\proj', ['D:\\proj\\a', 'd:/proj/a\\'])
  assert(dupes.length === 1, `canonical duplicates de-duplicated (got ${JSON.stringify(dupes)})`)
}

// ── 2. diff engine (built as its own lib/diff.js artifact) ──────────────────
console.log('diff engine: hunks, line numbers, stats...')
{
  // Case A: single middle change with context
  const before = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n')
  const after = ['l1', 'l2', 'X', 'l4', 'l5'].join('\n')
  const hunks = structuredDiff(after, before) // undo orientation: old=after, new=before
  assert(hunks.length === 1, `one hunk (got ${hunks.length})`)
  const h = hunks[0]
  assert(h.lines.includes('-X') && h.lines.includes('+l3'), 'deletion of after-side, addition of before-side')
  assert(h.lines.some(l => l.startsWith(' l2')), 'context line present')
  const stats = diffStats(hunks)
  assert(stats.added === 1 && stats.removed === 1, `stats +1/-1 (got +${stats.added}/-${stats.removed})`)

  // Case B: pure addition (new file content vs empty)
  const created = structuredDiff('', 'a\nb\nc')
  const cstats = diffStats(created)
  assert(cstats.added === 3 && cstats.removed === 0, `creation diff +3/-0 (got +${cstats.added}/-${cstats.removed})`)

  // Case C: identical texts produce no hunks
  assert(structuredDiff('same\nsame', 'same\nsame').length === 0, 'identical texts → zero hunks')

  // Case D: multi-hunk separation (changes far apart)
  const big = []
  for (let i = 1; i <= 30; i++) big.push(`line${i}`)
  const bigA = big.join('\n')
  const bigB = big.map((l, i) => (i === 2 || i === 27 ? `CHANGED${i}` : l)).join('\n')
  const multi = structuredDiff(bigA, bigB)
  assert(multi.length === 2, `far-apart changes split into 2 hunks (got ${multi.length})`)
  assert(multi.every(hk => hk.lines.length <= 13), 'hunk context does not bridge the gap')
}

// ── 2.5. hunk cache (定稿 6.1): content-keyed, FIFO-bounded, null never cached ─
console.log('hunk cache: hit path, miss path, FIFO eviction, null guard...')
{
  hunkCache.clear()
  const p1 = 'a\nb\nc\nd\ne'
  const p2 = 'a\nB\nc\nd\ne'
  const first = cachedStructuredDiff(p1, p2)
  assert(first.length >= 1, 'first call computes hunks')
  const second = cachedStructuredDiff(p1, p2)
  assert(second === first, 'same content pair returns the cached array (hit)')
  const other = cachedStructuredDiff(p1, 'a\nb\nc\nd\nX')
  assert(other !== first, 'different content computes a fresh result (miss)')

  // FIFO: 201 distinct pairs → size caps at 200, the oldest key is evicted
  hunkCache.clear()
  for (let i = 0; i < 201; i++) {
    cachedStructuredDiff(`seed-${i}`, `seed-${i}-v2`)
  }
  assert(hunkCache.size === 200, `cache caps at HUNK_CACHE_MAX=200 (got ${hunkCache.size})`)
  const hasOldest = [...hunkCache.keys()].some(k => k.includes(shaOf(`seed-0`)))
  assert(!hasOldest, 'oldest entry evicted (FIFO)')
  const hasNewest = [...hunkCache.keys()].some(k => k.includes(shaOf('seed-200')))
  assert(hasNewest, 'newest entry survives')

  // null sides are never cached (creation/deletion go through structuredDiff directly)
  hunkCache.clear()
  cachedStructuredDiff(null, 'created content')
  assert(hunkCache.size === 0, 'null side skips the cache entirely')

  // Cache key = sha256(before):sha256(after) — shaOf reproduces the before-side
  // fragment so the eviction probes can look for a specific key.
  function shaOf(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex')
  }
}

// ── 2.6. blank-line artifact (定稿 5.1): non-empty → empty at the same line ──
console.log('blank-line artifact detection: clear-to-empty, plain replace, line-count change...')
{
  assert(
    detectBlankLineArtifact('alpha\nbeta\ngamma', 'alpha\n\ngamma')?.line === 2,
    'clear-to-empty flags the emptied line (1-based)',
  )
  assert(
    detectBlankLineArtifact('alpha\nbeta\ngamma', 'alpha\nX\ngamma') === null,
    'a plain replace is not an artifact',
  )
  assert(
    detectBlankLineArtifact('alpha\nbeta\ngamma', 'alpha\ngamma') === null,
    'a line-count change is not an artifact',
  )
  assert(
    detectBlankLineArtifact('a\nb', 'a\nb\n') === null,
    'trailing-newline difference is not an artifact',
  )
  assert(
    detectBlankLineArtifact(null, 'a\n\ngamma') === null && detectBlankLineArtifact('a\n\ngamma', null) === null,
    'null sides never flag',
  )
  // trailing newline must not shift line numbering (splitLines parity with diff.ts)
  assert(
    detectBlankLineArtifact('alpha\nbeta\ngamma\n', 'alpha\n\ngamma\n')?.line === 2,
    'line number stable when both texts carry a trailing newline',
  )
}


// ── 3. scoped store lifecycle ────────────────────────────────────────────────
console.log('store v2.1: scoped append → backfill → revert → reapply...')
{
  const scopeA = { workspaceKey: 'ws-a~deadbeef', chatKey: 'chat-1' }
  const scopeB = { workspaceKey: 'ws-a~deadbeef', chatKey: 'chat-2' }

  await appendSnapshot(scopeA, {
    id: 's1', filePath: 'demo.txt', command: 'write',
    before: 'old line 1\nold line 2', beforeHash: null,
    after: null, afterHash: null,
    time: Date.now() - 60_000, state: 'recorded',
  })
  await appendSnapshot(scopeB, {
    id: 's1', filePath: 'demo.txt', command: 'write',
    before: 'OTHER CHAT', beforeHash: null,
    after: null, afterHash: null,
    time: Date.now() - 50_000, state: 'recorded',
  })

  const inA = await loadSnapshots(scopeA)
  const inB = await loadSnapshots(scopeB)
  assert(inA.length === 1 && inA[0].before === 'old line 1\nold line 2', 'scope A sees only its own snapshot')
  assert(inB.length === 1 && inB[0].before === 'OTHER CHAT', 'scope B sees only its own snapshot (same id, different store)')

  await backfillAfter(scopeA, 'demo.txt', 'old line 1\nNEW line 2\nNEW line 3')
  const inA2 = await loadSnapshots(scopeA)
  assert(inA2[0].after === 'old line 1\nNEW line 2\nNEW line 3', 'backfill lands in scope A only')
  const inB2 = await loadSnapshots(scopeB)
  assert(inB2[0].after === null, 'scope B untouched by A\'s backfill')

  await markReverted(scopeA, 's1')
  await markReapplied(scopeA, 's1')
  const inA3 = await loadSnapshots(scopeA)
  assert(inA3[0].state === 'reapplied', 'revert → reapply state machine works')
}

// ── 3.5. restart recovery: most recent scope wins ────────────────────────────
console.log('restart recovery: recoverActiveScope picks the most recent scope...')
{
  const { utimes } = await import('node:fs/promises')
  const oldScope = { workspaceKey: 'ws-old~aaaabbbb', chatKey: 'chat-old' }
  const newScope = { workspaceKey: 'ws-new~ccccdddd', chatKey: 'chat-new' }
  await appendSnapshot(oldScope, { id: 'o1', filePath: 'o.txt', command: 'edit', before: 'o', beforeHash: null, after: null, afterHash: null, time: Date.now() - 5 * 86_400_000, state: 'recorded' })
  await appendSnapshot(newScope, { id: 'n1', filePath: 'n.txt', command: 'edit', before: 'n', beforeHash: null, after: null, afterHash: null, time: Date.now(), state: 'recorded' })
  // Force distinct mtimes so the "most recent" is deterministic regardless of
  // the other scopes created earlier in this run (all ≈ now).
  const oldPath = join(tempHome, '.dsh', 'file-undo', oldScope.workspaceKey, oldScope.chatKey, 'snapshots.jsonl')
  const newPath = join(tempHome, '.dsh', 'file-undo', newScope.workspaceKey, newScope.chatKey, 'snapshots.jsonl')
  const t = Date.now() / 1000
  await utimes(oldPath, t - 3600, t - 3600) // 1h ago
  await utimes(newPath, t + 3600, t + 3600) // 1h in the future → newest
  const recovered = await recoverActiveScope()
  assert(recovered !== undefined, 'recoverActiveScope returns a scope when stores exist')
  assert(recovered.chatKey === 'chat-new', `recovers the most recent scope (got ${recovered?.chatKey})`)
}

// ── 4. HTTP API against a mock context ──────────────────────────────────────
console.log('api: scope routing / history / detail / preview / apply / reapply pipeline...')
{
  const { buildApi } = await import('./lib/api.js')

  // Mock context: fs backed by an in-memory map, sandbox policy no-op.
  const files = new Map()
  const written = []
  const mockCtx = {
    fs: {
      resolve: async p => ({ targetKey: p }),
      readText: async t => {
        if (!files.has(t.targetKey)) throw new Error('ENOENT')
        return files.get(t.targetKey)
      },
      writeText: async (t, content) => {
        files.set(t.targetKey, content)
        written.push({ path: t.targetKey, content })
      },
      // official fs has no delete — the api falls back to node fs in the host;
      // the mock provides one so the fallback branch stays unexercised here.
      unlink: async t => {
        files.delete(t.targetKey)
      },
    },
    sandboxPolicy: { resolve: () => ({}) },
  }

  // Mutable scope accessor: start unbound, bind on first capture.
  let activeScope = undefined
  const api = buildApi(mockCtx, () => activeScope)

  // ── unbound store: every method reports the reason ────────────────────────
  const unbound = await api.history().then(v => ({ ok: true }), e => ({ ok: false, code: e.code }))
  assert(unbound.ok === false && unbound.code === 'no-active-scope', 'unbound scope surfaces no-active-scope')

  // ── bind and seed one workspace/chat ──────────────────────────────────────
  activeScope = { workspaceKey: 'ws-x~11111111', chatKey: 'chat-main' }
  await appendSnapshot(activeScope, {
    id: 's1', filePath: 'demo.txt', command: 'write',
    before: 'old line 1\nold line 2', beforeHash: null,
    after: null, afterHash: null,
    time: Date.now() - 60_000, state: 'recorded',
  })
  files.set('demo.txt', 'old line 1\nNEW line 2\nNEW line 3')
  await backfillAfter(activeScope, 'demo.txt', 'old line 1\nNEW line 2\nNEW line 3')

  // context endpoint reports the binding
  const ctxInfo = await api.context()
  assert(ctxInfo.active === true && ctxInfo.scope.chatKey === 'chat-main', 'context reports the active scope')

  // history (undo orientation: green = restored before-side lines)
  const hist = await api.history()
  assert(Array.isArray(hist.items) && hist.items.length === 1, `history lists 1 (got ${hist.items?.length})`)
  const item = hist.items[0]
  assert(item.command === 'write' && item.state === 'recorded' && item.created === false, 'history row carries command + state + created')
  assert(item.added === 1 && item.removed === 2, `history stats +1 restored / -2 removed (got +${item.added}/-${item.removed})`)

  // detail: auto-precheck + diff
  const detail = await api.detail({ id: item.id })
  assert(detail.hunks.length >= 1, 'detail computes hunks')
  assert(detail.preview.canApply === true, 'clean state previews canApply')
  assert(typeof detail.preview.currentHash === 'string' && detail.preview.currentHash.length === 64, 'preview exposes currentHash')

  // clean apply: optimistic-concurrency token matches → full-text restore
  const ok = await api.apply({ id: item.id, expectedCurrentHash: detail.preview.currentHash })
  assert(ok.restored === 'demo.txt', 'apply restores the file')
  assert(files.get('demo.txt') === 'old line 1\nold line 2', 'file content restored to before-state')
  const after = await api.history()
  assert(after.items[0].state === 'reverted', 'history row shows reverted badge')

  // reverted entry: preview short-circuits (no external_modified noise), reapply offered
  const revertedDetail = await api.detail({ id: item.id })
  assert(revertedDetail.preview.canApply === false, 'reverted entry cannot apply again')
  assert(revertedDetail.preview.canReapply === true, 'reverted entry offers reapply')
  assert(revertedDetail.preview.reasons.length === 1 && revertedDetail.preview.reasons[0].code === 'already_reverted', 'reverted entry shows ONLY already_reverted (no external_modified noise)')

  // apply while REVERTED is refused
  const twice = await api.apply({ id: item.id }).then(v => ({ ok: true }), e => ({ ok: false, code: e.code }))
  assert(twice.ok === false && twice.code === 'already_reverted', 'apply on reverted refused with already_reverted')

  // reapply: write the after-state back
  const re = await api.reapply({ id: item.id, expectedCurrentHash: revertedDetail.preview.currentHash })
  assert(re.reapplied === 'demo.txt', 'reapply succeeds')
  assert(files.get('demo.txt') === 'old line 1\nNEW line 2\nNEW line 3', 'after-state written back by reapply')
  const afterRe = await api.history()
  assert(afterRe.items[0].state === 'reapplied', 'history row shows reapplied badge')

  // the state machine cycles: REAPPLIED can be undone again (file = after-state)
  const reapplyDetail = await api.detail({ id: item.id })
  assert(reapplyDetail.preview.canApply === true, 'reapplied entry previews canApply (cycle continues)')
  const third = await api.apply({ id: item.id, expectedCurrentHash: reapplyDetail.preview.currentHash })
  assert(third.restored === 'demo.txt', 'apply after reapply cycles back to reverted (state machine loops)')
  const afterThird = await api.history()
  assert(afterThird.items[0].state === 'reverted', 're-undo after reapply shows reverted again')

  // ── tamper scenario: a second snapshot whose file is modified afterwards ──
  await appendSnapshot(activeScope, {
    id: 's2', filePath: 'victim.txt', command: 'edit',
    before: 'victim before', beforeHash: null,
    after: null, afterHash: null,
    time: Date.now() - 30_000, state: 'recorded',
  })
  files.set('victim.txt', 'victim after')
  await backfillAfter(activeScope, 'victim.txt', 'victim after')

  const clean2 = await api.detail({ id: 's2' })
  assert(clean2.preview.canApply === true, 'second snapshot previews clean')

  files.set('victim.txt', 'tampered externally')
  const tampered = await api.detail({ id: 's2' })
  assert(tampered.preview.canApply === false, 'tampered file previews canApply=false')
  assert(tampered.preview.reasons.some(r => r.code === 'external_modified'), 'reason code external_modified')

  const writesBefore = written.length

  // stale token refused outright
  const stale = await api.apply({ id: 's2', expectedCurrentHash: clean2.preview.currentHash }).then(
    v => ({ ok: true }),
    e => ({ ok: false, code: e.code }),
  )
  assert(stale.ok === false && stale.code === 'stale', `stale expectedCurrentHash refused with code=stale (got ${JSON.stringify(stale.code)})`)

  // even a fresh token cannot jump the integrity gate after tampering
  const forced = await api.apply({ id: 's2', expectedCurrentHash: tampered.preview.currentHash }).then(
    v => ({ ok: true }),
    e => ({ ok: false, code: e.code }),
  )
  assert(forced.ok === false && forced.code === 'external_modified', 'tampered file refused with external_modified')
  assert(written.length === writesBefore, 'refused applies wrote nothing (transactional)')

  // ── P13: callId pairing — a failed sibling call must not steal backfills ──
  // c-fail: pre captured, tool then failed (post marks aborted, never backfills)
  await appendSnapshot(activeScope, {
    id: 'sf', filePath: 'demo.txt', command: 'str_replace_editor', op: 'str_replace',
    callId: 'call-fail',
    before: 'demo before', beforeHash: null,
    after: null, afterHash: null,
    time: Date.now() - 1_000, state: 'recorded',
  })
  await markAbortedByCall(activeScope, 'call-fail')
  // c-ok: the next real call pairs EXACTLY by callId, not by FIFO path match
  await appendSnapshot(activeScope, {
    id: 'sok', filePath: 'demo.txt', command: 'str_replace_editor', op: 'str_replace',
    callId: 'call-ok',
    before: 'demo before', beforeHash: null,
    after: null, afterHash: null,
    time: Date.now(), state: 'recorded',
  })
  files.set('demo.txt', 'demo after')
  await backfillAfter(activeScope, 'demo.txt', 'demo after', 'call-ok')
  const allNow = await loadSnapshots(activeScope)
  const failRow = allNow.find(s => s.id === 'sf')
  const okRow = allNow.find(s => s.id === 'sok')
  assert(okRow !== undefined && okRow.after === 'demo after', `callId backfill lands on its own row (got ${JSON.stringify(okRow?.after)})`)
  assert(failRow !== undefined && failRow.after === null && failRow.state === 'aborted', 'failed sibling stays untouched and aborted')
  const histNow = await api.history()
  const failItem = histNow.items.find(i => i.id === 'sf')
  assert(failItem !== undefined && failItem.state === 'aborted', 'aborted row stays in history as a failure-log entry')
  const abortedDetail = await api.detail({ id: 'sf' })
  assert(abortedDetail.item.state === 'aborted', 'aborted row is addressable (failure-log detail)')
  const abortedApply = await api.apply({ id: 'sf' }).then(v => ({ ok: true }), e => ({ ok: false, code: e.code }))
  assert(abortedApply.ok === false && abortedApply.code === 'aborted_op', 'apply on aborted refused with aborted_op')
  // a callId with no pre snapshot backfills nothing and must NOT fall back to FIFO
  const beforeNoFifo = allNow.find(s => s.id === 's1').after
  await backfillAfter(activeScope, 'demo.txt', 'STRAY WRITE', 'call-unknown')
  const afterNoFifo = (await loadSnapshots(activeScope)).find(s => s.id === 's1').after
  assert(afterNoFifo === beforeNoFifo, 'unknown callId does not fall back to FIFO pairing')

  // ── scope switch: the api follows the accessor, isolating stores ──────────
  activeScope = { workspaceKey: 'ws-x~11111111', chatKey: 'chat-other' }
  const otherHist = await api.history()
  assert(otherHist.items.length === 0, 'switched scope reads an empty store (isolation)')
  const missing = await api.detail({ id: 's1' }).then(v => ({ ok: true }), e => ({ ok: false, code: e.code }))
  assert(missing.ok === false && missing.code === 'snapshot_missing', 'snapshot from another scope not found')

  // ── legacy edit with no recorded before-state ──────────────────────────────
  activeScope = { workspaceKey: 'ws-x~11111111', chatKey: 'chat-main' }
  await appendSnapshot(activeScope, {
    id: 's3', filePath: 'legacy.txt', command: 'edit',
    before: null, beforeHash: null,
    after: null, afterHash: null,
    time: Date.now() - 10_000, state: 'recorded',
  })
  files.set('legacy.txt', 'current legacy content')
  const legacy = await api.detail({ id: 's3' })
  assert(legacy.preview.canApply === false, 'legacy no-before previews canApply=false')
  assert(legacy.preview.reasons.some(r => r.code === 'no_before'), 'reason code no_before (not file_creation)')
  assert(!legacy.preview.reasons.some(r => r.code === 'file_creation'), 'no false file_creation for an edit')
  assert(legacy.hunks.length === 0, 'no misleading diff for a no-before snapshot')
  const legacyApply = await api.apply({ id: 's3' }).then(v => ({ ok: true }), e => ({ ok: false, code: e.code }))
  assert(legacyApply.ok === false && legacyApply.code === 'no_before', 'apply refused with no_before')

  // a write with before === null IS a genuine creation — undoing it DELETES
  // the file (hash-gated), and re-applying re-creates it from the after-state
  await appendSnapshot(activeScope, {
    id: 's4', filePath: 'created.txt', command: 'write',
    callId: 'call-s4',
    before: null, beforeHash: null,
    after: null, afterHash: null,
    time: Date.now() - 5_000, state: 'recorded',
  })
  files.set('created.txt', 'alpha\nbeta\ngamma\n')
  await backfillAfter(activeScope, 'created.txt', 'alpha\nbeta\ngamma\n', 'call-s4')
  const createdSnap = await api.detail({ id: 's4' })
  assert(createdSnap.preview.reasons.every(r => r.code !== 'file_creation'), 'captured creation previews without file_creation refusal')
  assert(createdSnap.preview.canApply === true, 'captured creation previews canApply (delete path)')
  assert(createdSnap.added === 3 && createdSnap.removed === 0, `creation detail stats +3/-0 (got +${createdSnap.added}/-${createdSnap.removed})`)
  assert(createdSnap.hunks.length === 1 && createdSnap.hunks[0].lines.every(l => l.startsWith('+')), 'creation detail renders all-addition hunks')
  const createdHist = (await api.history()).items.find(i => i.id === 's4')
  assert(createdHist !== undefined && createdHist.added === 3 && createdHist.removed === 0, `creation history row stats +3/-0 (got ${JSON.stringify(createdHist && [createdHist.added, createdHist.removed])})`)

  // hash gate: a post-creation edit refuses the delete
  files.set('created.txt', 'tampered\n')
  const tamperedDel = await api.apply({ id: 's4' }).then(v => ({ ok: true }), e => ({ ok: false, code: e.code }))
  assert(tamperedDel.ok === false && tamperedDel.code === 'external_modified', 'creation delete refused after external modification')

  // matching content → delete succeeds and the file is really gone
  files.set('created.txt', 'alpha\nbeta\ngamma\n')
  const delOk = await api.apply({ id: 's4' }).then(v => ({ ok: true, v }), e => ({ ok: false, code: e.code }))
  assert(delOk.ok === true && delOk.v.deleted === true, 'creation undo deletes the file')
  assert(!files.has('created.txt'), 'creation undo really removed the file from disk')
  const afterDel = (await api.history()).items.find(i => i.id === 's4')
  assert(afterDel !== undefined && afterDel.state === 'reverted', 'deleted creation shows reverted')

  // re-apply re-creates the file from the captured after-content
  const recreated = await api.reapply({ id: 's4' }).then(v => ({ ok: true, v }), e => ({ ok: false, code: e.code }))
  assert(recreated.ok === true && recreated.v.recreated === true, 'reapply of a deleted creation re-creates the file')
  assert(files.get('created.txt') === 'alpha\nbeta\ngamma\n', 'recreated content matches the captured after-state')

  // idempotent: an externally-deleted creation undoes as a no-op record
  await appendSnapshot(activeScope, {
    id: 's5', filePath: 'gone.txt', command: 'write',
    callId: 'call-s5',
    before: null, beforeHash: null,
    after: null, afterHash: null,
    time: Date.now() - 2_000, state: 'recorded',
  })
  await backfillAfter(activeScope, 'gone.txt', 'was here\n', 'call-s5')
  files.delete('gone.txt') // externally removed before the user clicks undo
  const gonePrev = await api.detail({ id: 's5' })
  assert(gonePrev.preview.canApply === true, 'externally-deleted creation previews canApply (idempotent)')
  const goneDel = await api.apply({ id: 's5' }).then(v => ({ ok: true, v }), e => ({ ok: false, code: e.code }))
  assert(goneDel.ok === true && goneDel.v.alreadyGone === true, 'already-gone creation undoes idempotently (alreadyGone)')

  // legacy: a creation with NO captured after-content still refuses deletion
  await appendSnapshot(activeScope, {
    id: 's6', filePath: 'opaque.txt', command: 'write',
    before: null, beforeHash: null,
    after: null, afterHash: null,
    time: Date.now() - 1_000, state: 'recorded',
  })
  files.set('opaque.txt', 'unknown content')
  const opaquePrev = await api.detail({ id: 's6' })
  assert(opaquePrev.preview.reasons.some(r => r.code === 'file_creation'), 'uncaptured creation still previews file_creation refusal')
  assert(opaquePrev.preview.canApply === false, 'uncaptured creation cannot apply (unsafe delete)')
  const opaqueApply = await api.apply({ id: 's6' }).then(v => ({ ok: true }), e => ({ ok: false, code: e.code }))
  assert(opaqueApply.ok === false && opaqueApply.code === 'no_before', 'uncaptured creation apply refused with no_before')

  // ── no-change calls (after === before) become 无变化 log rows, never undoable ──
  await appendSnapshot(activeScope, {
    id: 's7', filePath: 'demo.txt', command: 'str_replace_editor', op: 'str_replace',
    callId: 'call-noop',
    before: 'demo after', beforeHash: null,
    after: null, afterHash: null,
    time: Date.now() + 500, state: 'recorded',
  })
  // demo.txt currently holds 'demo after' (cycled earlier) — backfill sees identical content
  await backfillAfter(activeScope, 'demo.txt', 'demo after', 'call-noop')
  const noopRow = (await loadSnapshots(activeScope)).find(s => s.id === 's7')
  assert(noopRow !== undefined && noopRow.state === 'noop' && noopRow.after === 'demo after', 'no-change call marked noop with after preserved')
  const noopDetail = await api.detail({ id: 's7' })
  assert(noopDetail.preview.canApply === false, 'noop previews canApply=false')
  const noopApply = await api.apply({ id: 's7' }).then(v => ({ ok: true }), e => ({ ok: false, code: e.code }))
  assert(noopApply.ok === false && noopApply.code === 'noop_op', 'apply on noop refused with noop_op')
  const hist7 = (await api.history()).items.find(i => i.id === 's7')
  assert(hist7 !== undefined && hist7.state === 'noop', 'noop row stays visible in history as 无变化 log')
  // and it does not disturb the sibling row's own after-state
  const sokRow = (await loadSnapshots(activeScope)).find(s => s.id === 'sok')
  assert(sokRow !== undefined && sokRow.after === 'demo after', 'noop backfill did not disturb the paired sibling')

  // ── 5.1 (v7.0): blank-line artifact surfaces through detail (端到端) ──────
  await appendSnapshot(activeScope, {
    id: 's8', filePath: 'blank.txt', command: 'str_replace_editor', op: 'str_replace',
    callId: 'call-s8',
    before: 'alpha\nbeta\ngamma', beforeHash: null,
    after: null, afterHash: null,
    time: Date.now() + 600, state: 'recorded',
  })
  files.set('blank.txt', 'alpha\n\ngamma') // beta cleared to an empty line
  await backfillAfter(activeScope, 'blank.txt', 'alpha\n\ngamma', 'call-s8')
  const blankDetail = await api.detail({ id: 's8' })
  assert(
    blankDetail.blankLine !== undefined && blankDetail.blankLine.line === 2,
    `blank-line artifact reported at line 2 (got ${JSON.stringify(blankDetail.blankLine)})`,
  )
  assert(blankDetail.preview.canApply === true, 'blank-line entry still previews clean (artifact is a hint, not a block)')

  await appendSnapshot(activeScope, {
    id: 's9', filePath: 'no-blank.txt', command: 'str_replace_editor', op: 'str_replace',
    callId: 'call-s9',
    before: 'alpha\nbeta\ngamma', beforeHash: null,
    after: null, afterHash: null,
    time: Date.now() + 700, state: 'recorded',
  })
  files.set('no-blank.txt', 'alpha\nX\ngamma') // plain replace, same line count
  await backfillAfter(activeScope, 'no-blank.txt', 'alpha\nX\ngamma', 'call-s9')
  const noBlankDetail = await api.detail({ id: 's9' })
  assert(noBlankDetail.blankLine === undefined, 'plain replace carries no blank-line artifact')

  await appendSnapshot(activeScope, {
    id: 's10', filePath: 'shrink.txt', command: 'str_replace_editor', op: 'str_replace',
    callId: 'call-s10',
    before: 'alpha\nbeta\ngamma', beforeHash: null,
    after: null, afterHash: null,
    time: Date.now() + 800, state: 'recorded',
  })
  files.set('shrink.txt', 'alpha\ngamma') // a whole line deleted → line count changed
  await backfillAfter(activeScope, 'shrink.txt', 'alpha\ngamma', 'call-s10')
  const shrinkDetail = await api.detail({ id: 's10' })
  assert(shrinkDetail.blankLine === undefined, 'line-count change carries no blank-line artifact')
}

// ── 4b. Turn enrichment（v0.3.10）: badges read the authoritative session log ──
console.log('api: turn enrichment via the sessionQuery seam...')
{
  const { buildApi } = await import('./lib/api.js')

  const files2 = new Map()
  const mockCtx2 = {
    fs: {
      resolve: async p => ({ targetKey: p }),
      readText: async t => {
        if (!files2.has(t.targetKey)) throw new Error('ENOENT')
        return files2.get(t.targetKey)
      },
      writeText: async (t, content) => {
        files2.set(t.targetKey, content)
      },
      unlink: async t => {
        files2.delete(t.targetKey)
      },
    },
    sandboxPolicy: { resolve: () => ({}) },
  }

  // In-memory session log shaped like the platform's SessionEvent stream.
  // tool/call payloads carry {turn, step, callId, name, arguments} — the
  // authoritative round mapping (docs/subsystems/session.md).
  const sessionLog = [
    { seq: 1, type: 'turn/start', time: 1, data: { turn: 1 } },
    { seq: 2, type: 'step/start', time: 2, data: { turn: 1, step: 1 } },
    { seq: 3, type: 'tool/call', time: 3, data: { turn: 1, step: 1, callId: 'c-a', name: 'write', arguments: '{}' } },
    { seq: 4, type: 'tool/call', time: 4, data: { turn: 1, step: 1, callId: 'c-b', name: 'todo/write', arguments: '{}' } },
    { seq: 5, type: 'tool/result', time: 5, data: { turn: 1, step: 1, message: {} } },
    { seq: 6, type: 'turn/end', time: 6, data: { turn: 1, reason: 'end_turn' } },
    { seq: 7, type: 'turn/start', time: 7, data: { turn: 2 } },
    { seq: 8, type: 'step/start', time: 8, data: { turn: 2, step: 1 } },
    { seq: 9, type: 'tool/call', time: 9, data: { turn: 2, step: 1, callId: 'c-c', name: 'str_replace_editor', arguments: '{}' } },
  ]
  const sessionQuery = {
    readSession: async sessionId => {
      if (sessionId !== 'chat-turn') return undefined
      return { session: { id: sessionId }, events: sessionLog.map(e => ({ ...e, data: { ...e.data } })) }
    },
    listEvents: async sessionId => {
      if (sessionId !== 'chat-turn') return undefined
      return sessionLog.map(e => ({ seq: e.seq, type: e.type }))
    },
    readEvent: async ({ sessionId, seq }) => {
      if (sessionId !== 'chat-turn') return undefined
      const target = sessionLog.find(e => e.seq === seq)
      return target === undefined ? undefined : { session: { id: sessionId }, target: { ...target, data: { ...target.data } } }
    },
  }

  const scope2 = { workspaceKey: 'ws-y~22222222', chatKey: 'chat-turn' }
  // turn 1: one file op (c-a) + one non-file op (c-b — still counts in turnOps)
  await appendSnapshot(scope2, {
    id: 't1', filePath: 'a.txt', command: 'write', callId: 'c-a',
    before: null, beforeHash: null, after: null, afterHash: null,
    time: 3, state: 'recorded',
  })
  files2.set('a.txt', 'a')
  await backfillAfter(scope2, 'a.txt', 'a', 'c-a')
  // turn 2: one file op (c-c) plus a legacy row with NO callId (t3)
  await appendSnapshot(scope2, {
    id: 't2', filePath: 'b.txt', command: 'edit', callId: 'c-c',
    before: 'x', beforeHash: null, after: null, afterHash: null,
    time: 9, state: 'recorded',
  })
  files2.set('b.txt', 'y')
  await backfillAfter(scope2, 'b.txt', 'y', 'c-c')
  await appendSnapshot(scope2, {
    id: 't3', filePath: 'c.txt', command: 'write',
    before: null, beforeHash: null, after: null, afterHash: null,
    time: 10, state: 'recorded',
  })
  files2.set('c.txt', 'z')
  await backfillAfter(scope2, 'c.txt', 'z')

  const api2 = buildApi(mockCtx2, () => scope2, () => sessionQuery)
  const hist2 = await api2.history()
  const row1 = hist2.items.find(i => i.id === 't1')
  const row2 = hist2.items.find(i => i.id === 't2')
  const row3 = hist2.items.find(i => i.id === 't3')
  assert(row1 !== undefined && row1.turn === 1 && row1.step === 1, `c-a maps to turn 1 step 1 (got ${JSON.stringify(row1 && [row1.turn, row1.step])})`)
  assert(row1 !== undefined && row1.turnOps === 2, `turn 1 counts ALL tool calls incl. non-file (got ${JSON.stringify(row1?.turnOps)})`)
  assert(row2 !== undefined && row2.turn === 2 && row2.step === 1 && row2.turnOps === 1, `c-c maps to turn 2 step 1 (got ${JSON.stringify(row2 && [row2.turn, row2.step, row2.turnOps])})`)
  assert(row3 !== undefined && row3.turn === undefined, 'legacy row without callId carries no turn')
  const det2 = await api2.detail({ id: 't2' })
  assert(det2.item.turn === 2 && det2.item.step === 1, 'detail payload also carries the turn mapping')

  // Incremental: a NEW tool/call appended after the cache warmed up must be
  // picked up via listEvents + readEvent (no full re-read).
  await appendSnapshot(scope2, {
    id: 't4', filePath: 'd.txt', command: 'write', callId: 'c-d',
    before: null, beforeHash: null, after: null, afterHash: null,
    time: 11, state: 'recorded',
  })
  files2.set('d.txt', 'd')
  await backfillAfter(scope2, 'd.txt', 'd', 'c-d')
  sessionLog.push(
    { seq: 10, type: 'tool/call', time: 10, data: { turn: 2, step: 2, callId: 'c-d', name: 'write', arguments: '{}' } },
    { seq: 11, type: 'tool/result', time: 10.5, data: { turn: 2, step: 2, message: {} } },
  )
  const hist3 = await api2.history()
  const row4 = hist3.items.find(i => i.id === 't4')
  assert(row4 !== undefined && row4.turn === 2 && row4.step === 2, `new call ingested incrementally (got ${JSON.stringify(row4 && [row4.turn, row4.step])})`)
  const row2b = hist3.items.find(i => i.id === 't2')
  assert(row2b !== undefined && row2b.turnOps === 2, 'per-turn count grows with the new call')

  // Seam absent → no turn fields at all (badge-less degradation).
  const api3 = buildApi(mockCtx2, () => scope2)
  const hist4 = await api3.history()
  assert(
    hist4.items.every(i => i.turn === undefined && i.step === undefined && i.turnOps === undefined),
    'without the seam rows carry no turn fields',
  )

  // A misbehaving seam must never fail history: a FRESH session whose index
  // build throws degrades to badge-less rows, history still succeeds.
  const scope4 = { workspaceKey: 'ws-y~22222222', chatKey: 'chat-broken' }
  await appendSnapshot(scope4, {
    id: 'tb', filePath: 'b.txt', command: 'edit', callId: 'c-x',
    before: 'x', beforeHash: null, after: null, afterHash: null,
    time: 1, state: 'recorded',
  })
  files2.set('b.txt', 'y')
  await backfillAfter(scope4, 'b.txt', 'y', 'c-x')
  const api4 = buildApi(mockCtx2, () => scope4, () => ({ readSession: async () => { throw new Error('boom') } }))
  const hist5 = await api4.history()
  assert(Array.isArray(hist5.items) && hist5.items.length === 1, 'a throwing seam still serves history')
  assert(hist5.items[0].turn === undefined, 'throwing seam degrades to badge-less rows')
}

// ── 6. 会话跟随 v0.4.0：sessionId 路由 + 切换器目录 ─────────────────────────
console.log('session follow: sessionId routing + switcher directory...')
{
  const { buildApi } = await import('./lib/api.js')
  const { workspaceKeyOf } = await import('./lib/store.js')

  const files3 = new Map()
  const mockCtx3 = {
    fs: {
      resolve: async p => ({ targetKey: p }),
      readText: async t => {
        if (!files3.has(t.targetKey)) throw new Error('ENOENT')
        return files3.get(t.targetKey)
      },
      writeText: async (t, content) => {
        files3.set(t.targetKey, content)
      },
      unlink: async t => {
        files3.delete(t.targetKey)
      },
    },
    sandboxPolicy: { resolve: () => ({}) },
  }

  // Two sessions of ONE project tree (parent + child cwd) — the exact on-disk
  // shape that made one session's history invisible to the other.
  const parentCwd = 'D:\\ProjectTree'
  const childCwd = 'D:\\ProjectTree\\sub'
  const scopeA = { workspaceKey: workspaceKeyOf(parentCwd), chatKey: 'session-parent' }
  const scopeB = { workspaceKey: workspaceKeyOf(childCwd), chatKey: 'session-child' }
  await appendSnapshot(scopeA, {
    id: 'sa', filePath: join(parentCwd, 'a.txt'), command: 'write',
    before: 'A1', beforeHash: null, after: null, afterHash: null,
    time: Date.now() - 10_000, state: 'recorded',
  })
  await appendSnapshot(scopeB, {
    id: 'sb', filePath: join(childCwd, 'b.txt'), command: 'write',
    before: 'B1', beforeHash: null, after: null, afterHash: null,
    time: Date.now() - 5_000, state: 'recorded',
  })
  await backfillAfter(scopeA, join(parentCwd, 'a.txt'), 'A2')
  await backfillAfter(scopeB, join(childCwd, 'b.txt'), 'B2')

  // What `ctx.sessionQuery.listSessions` returns: the platform's session
  // directory. The unrelated project must never leak into the switcher.
  const seam = {
    listSessions: async () => [
      { header: { id: scopeA.chatKey, cwd: parentCwd }, live: true, persisted: true },
      { header: { id: scopeB.chatKey, cwd: childCwd }, live: false, persisted: true },
      { header: { id: 'session-other', cwd: 'D:\\Elsewhere' }, live: true, persisted: false },
    ],
    // Shape per docs/subsystems/session-query.md: one ordered
    // SessionTitleObservationResult per id — { sessionId, status, value|reason }.
    readTitleSnapshots: async (ids) => ids.map(id => ({
      sessionId: id,
      status: 'fulfilled',
      value: {
        session: { id },
        title: id === scopeA.chatKey
          ? { title: '重写 README 重试' }
          : id === scopeB.chatKey
            ? { title: '在 docs 文件 写入截图' }
            : undefined,
      },
    })),
  }

  let active = scopeA
  const api5 = buildApi(mockCtx3, () => active, () => seam)

  // No sessionId → the host's active scope (backward compatible).
  const hA = await api5.history()
  assert(hA.items.length === 1 && hA.items[0].id === 'sa', `no sessionId serves the active scope (got ${hA.items.map(i => i.id).join(',')})`)

  // sessionId routes to THAT session's store — the switcher's whole point.
  const hB = await api5.history({ sessionId: scopeB.chatKey })
  assert(hB.items.length === 1 && hB.items[0].id === 'sb', `sessionId routes to that session's store (got ${hB.items.map(i => i.id).join(',')})`)
  assert(active.chatKey === 'session-parent', 'routing does not move the host active scope')

  // detail routes by sessionId too (spot check).
  const dB = await api5.detail({ id: 'sb', sessionId: scopeB.chatKey })
  assert(dB.item.id === 'sb', 'detail routes by sessionId too')

  // A crafted claim for a session the seam does not know → refused.
  const forged = await api5.history({ sessionId: 'session-forged' }).then(v => ({ ok: true }), e => ({ ok: false, code: e.code }))
  assert(forged.ok === false && forged.code === 'unknown-session', `unknown session refused (got ${String(forged.code)})`)

  // Switcher: same-tree members only, current marked, unrelated project out.
  const dir = await api5.sessions({})
  assert(dir.available === true, 'directory available with the seam')
  assert(dir.currentId === 'session-parent', 'directory reports the bound session')
  const ids = dir.items.map(s => s.id).sort()
  assert(ids.join(',') === 'session-child,session-parent', `same-tree members only (got ${ids.join(',')})`)
  assert(dir.items.find(s => s.id === 'session-parent')?.current === true, 'current session marked')
  assert(dir.items.every(s => s.hasRecords === true), 'members report record presence')
  assert(!ids.includes('session-other'), 'unrelated project never leaks in')

  // Titles come from the seam; same-cwd sessions need titles to be tellable apart.
  const titleOf = id => dir.items.find(s => s.id === id)?.title
  assert(titleOf('session-parent') === '重写 README 重试', `title propagated for parent (got ${JSON.stringify(titleOf('session-parent'))})`)
  assert(titleOf('session-child') === '在 docs 文件 写入截图', `title propagated for child (got ${JSON.stringify(titleOf('session-child'))})`)

  // Title seam absent → entries have no title, label falls back at the client side.
  const seamNoTitle = { listSessions: seam.listSessions }
  const apiNoTitle = buildApi(mockCtx3, () => scopeA, () => seamNoTitle)
  const dirNT = await apiNoTitle.sessions({})
  assert(dirNT.items.every(s => s.title === undefined), 'no title seam → items carry no title field')
  // The seam throwing for titles is also tolerated (skip enrichment, keep directory).
  const seamThrowing = {
    listSessions: seam.listSessions,
    readTitleSnapshots: async () => { throw new Error('boom') },
  }
  const apiThrowingTitles = buildApi(mockCtx3, () => scopeA, () => seamThrowing)
  const dirTT = await apiThrowingTitles.sessions({})
  assert(dirTT.available === true && dirTT.items.length === 2, 'throwing title seam still serves the directory')

  // Seam absent → switcher unavailable, and a claimed sessionId is IGNORED
  // (there is no way to verify it), so behaviour never regresses below today.
  const api6 = buildApi(mockCtx3, () => scopeB)
  const dir6 = await api6.sessions({})
  assert(dir6.available === false && dir6.items.length === 0, 'directory unavailable without the seam')
  const h6 = await api6.history({ sessionId: 'session-forged' })
  assert(h6.items.length === 1 && h6.items[0].id === 'sb', 'without the seam a sessionId claim is ignored (active scope served)')

  // Throwing seam → same degradation, history never breaks.
  const api7 = buildApi(mockCtx3, () => scopeB, () => ({ listSessions: async () => { throw new Error('boom') } }))
  const dir7 = await api7.sessions({})
  assert(dir7.available === false, 'throwing seam degrades to unavailable')
  const h7 = await api7.history({ sessionId: scopeB.chatKey })
  assert(h7.items.length === 1 && h7.items[0].id === 'sb', 'throwing seam still serves history')

  // Older backend: only `readTitle` (singular). The panel still picks up titles,
  // one round-trip per id — the only proj surface variant we expect in practice.
  const seamTitleOnly = {
    listSessions: seam.listSessions,
    readTitle: async id => id === scopeA.chatKey ? { title: '重写 README 重试' }
      : id === scopeB.chatKey ? { title: '在 docs 文件 写入截图' }
      : undefined,
  }
  const apiTitleOnly = buildApi(mockCtx3, () => scopeA, () => seamTitleOnly)
  const dirTO = await apiTitleOnly.sessions({})
  assert(dirTO.items.find(s => s.id === 'session-parent')?.title === '重写 README 重试', `readTitle fallback propagates title (got ${JSON.stringify(dirTO.items.find(s => s.id === 'session-parent')?.title)})`)
  assert(dirTO.items.find(s => s.id === 'session-child')?.title === '在 docs 文件 写入截图', 'readTitle fallback propagates child title')

  // A 'rejected' observation carries `reason`, not a title: it must be skipped
  // per-id without dropping the member or breaking the directory.
  const seamRejected = {
    listSessions: seam.listSessions,
    readTitleSnapshots: async (ids) => ids.map((id, i) => i === 0
      ? { sessionId: id, status: 'rejected', reason: new Error('nope') }
      : { sessionId: id, status: 'fulfilled', value: { session: { id }, title: { title: '兜底标题' } } }),
  }
  const apiRejected = buildApi(mockCtx3, () => scopeA, () => seamRejected)
  const dirRej = await apiRejected.sessions({})
  assert(dirRej.items.length === 2, `rejected observation does not drop members (got ${dirRej.items.length})`)
  assert(dirRej.items.some(s => s.title === '兜底标题'), 'fulfilled observations still propagate')
  assert(dirRej.items.some(s => s.title === undefined), 'rejected observation yields no title')
}

await rm(tempHome, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL VISUAL CHECKS PASSED' : `\n${failures} CHECKS FAILED`)
process.exit(failures === 0 ? 0 : 1)
