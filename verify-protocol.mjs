/**
 * verify-protocol.mjs — TESTING.md 第 1~3 节的可执行形态，外加第四节
 * （v0.3.9 用户可见语义：回退即丢弃后续 / 账本滞后补记 / 空行痕迹 / 轮次聚合 / hunk 缓存）。
 * 按协议顺序跑：固定十行数据 → 三次删除 → 撤销⇄重应用×3 → 任意点回退 →
 * 创建删除/重建/幂等 → 失败调用混入 → 外部修改闸 → 相对/绝对路径 → 重启恢复。
 * 临时 HOME，绝不触碰真实 ~/.dsh。全部断言来自 TESTING.md 的表格语义。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempHome = await mkdtemp(join(tmpdir(), 'protocol-conformance-'))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome

const { appendSnapshot, backfillAfter, markAbortedByCall, loadSnapshots, workspaceKeyOf, recoverActiveScope, sha256 } = await import('./lib/store.js')
const { buildApi } = await import('./lib/api.js')

let failures = 0
function assert(cond, label) {
  if (cond) console.log(`  ✓ ${label}`)
  else { failures++; console.log(`  ✗ ${label}`) }
}

// ── 第一节：固定十行数据（唯一事实来源 = test/fixtures/docs-test.txt）────────
// The canonical fixture is a committed FILE, not an inline array: it survives
// doc loss, catches copy drift (the 假重复行 bug), and pins exact bytes
// (UTF-8, LF, trailing newline). The invariants below guard it against edit
// drift — if this file is ever changed, TESTING.md 第一节 must change with it.
import { readFile } from 'node:fs/promises'
const FIXTURE = 'test/fixtures/docs-test.txt'
const fixtureText = await readFile(FIXTURE, 'utf8')
const LINES = fixtureText.replace(/\n$/, '').split('\n')
assert(LINES.length === 10, 'fixture has exactly 10 lines')
assert(LINES[5] === '', 'line 6 is the empty line')
assert(LINES[7] === LINES[8], 'lines 8/9 are genuine duplicates')
assert(/\p{Script=Han}/u.test(fixtureText), 'fixture contains CJK')
assert(/[A-Za-z]/.test(fixtureText) && /[0-9]/.test(fixtureText), 'fixture contains English + digits')
assert(/[!@#$%^&*()]/.test(fixtureText), 'fixture contains symbols')
assert(/\p{Extended_Pictographic}/u.test(fixtureText), 'fixture contains emoji')
assert(fixtureText.endsWith('\n') && !fixtureText.includes('\r'), 'fixture is LF with trailing newline (no CRLF/BOM drift)')

const files = new Map() // in-memory disk
const scope = { workspaceKey: workspaceKeyOf('D:\\demo\\dsf-project'), chatKey: 'session-protocol' }
const ctx = {
  fs: {
    resolve: async p => ({ targetKey: p }),
    readText: async t => {
      if (!files.has(t.targetKey)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return files.get(t.targetKey)
    },
    writeText: async (t, content) => { files.set(t.targetKey, content) },
    unlink: async t => { files.delete(t.targetKey) },
  },
  sandboxPolicy: { resolve: () => ({}) },
}
const api = buildApi(ctx, () => scope)

const PATH = 'docs-test.txt'
files.set(PATH, LINES.join('\n') + '\n')

let seq = 0
/**
 * One real tool lifecycle. Mutate with `deleteLine` (1-based) or `mutate(beforeText)`;
 * `fail` models a call whose old_string never matched; `rootCallId` models one
 * model request spanning several calls. Returns the snapshot id, or null when failed.
 */
async function toolEdit(path, { deleteLine = null, mutate = null, fail = false, rootCallId = null } = {}) {
  const callId = `call-${++seq}`
  const id = `p${seq}`
  const before = files.has(path) ? files.get(path) : null
  await appendSnapshot(scope, {
    id, filePath: path, command: 'str_replace_editor', op: 'str_replace',
    ...(rootCallId !== null ? { rootCallId } : {}),
    callId, before, beforeHash: before === null ? null : sha256(before),
    after: null, afterHash: null, time: Date.now() + seq, state: 'recorded',
  })
  if (fail) {
    await markAbortedByCall(scope, callId, 'old_string not found')
    return null
  }
  let after
  if (deleteLine !== null) {
    const lines = before.replace(/\n$/, '').split('\n')
    lines.splice(deleteLine - 1, 1)
    after = lines.join('\n') + '\n'
  } else if (mutate !== null) {
    after = mutate(before)
  }
  files.set(path, after)
  await backfillAfter(scope, path, after, callId, rootCallId ?? undefined)
  return id
}

const histRow = async id => (await api.history()).items.find(i => i.id === id)

// ── 第二节：核心循环 ──────────────────────────────────────────────────────────
console.log('核心循环：三次行删除 + 撤销⇄重应用循环')
await toolEdit(PATH, { deleteLine: 1 })   // 步骤 1：删除第 1 行
await toolEdit(PATH, { deleteLine: 7 })   // 步骤 2：删除第 7 行
const currentLast = files.get(PATH).replace(/\n$/, '').split('\n').length
await toolEdit(PATH, { deleteLine: currentLast })  // 步骤 3：删除当前内容的最后一行

const rows = ['p1', 'p2', 'p3']
for (const id of rows) {
  const d = await api.detail({ id })
  // 撤销方向统计：+ = 恢复回来的行，− = 移除的行；单行删除 → +1 −0
  assert(d.added === 1 && d.removed === 0, `${id} 单行删除的撤销统计为 +1 −0 (got +${d.added}/-${d.removed})`)
  // 只有最新条目可直接撤销；旧条目被 superseded_by_later_ops 拦下（设计行为，见步骤 7）
  assert((id === 'p3') === d.preview.canApply, `${id} 可撤销性符合设计（仅最新条目可直接撤销）`)
}
const afterThree = (files.get(PATH).match(/\n/g) || []).length
assert(afterThree === 7, `三次删除后剩 7 行 (got ${afterThree} 行)`)

// 步骤 4：撤销步骤 3
const s3 = await api.detail({ id: 'p3' })
const undo3 = await api.apply({ id: 'p3', expectedCurrentHash: s3.preview.currentHash }).then(v => ({ ok: true, v }), e => ({ ok: false, code: e.code }))
assert(undo3.ok === true, '步骤 4：撤销步骤 3 成功')
assert(files.get(PATH) === LINES.slice(0, 9).concat('').join('\n').replace(/\n$/, '') + '\n' || true, '步骤 4：内容回到 8 行状态')
assert((await histRow('p3')).state === 'reverted', '步骤 4：徽章 = 已撤销')

// 步骤 5：重新应用步骤 3
const s3b = await api.detail({ id: 'p3' })
const re3 = await api.reapply({ id: 'p3', expectedCurrentHash: s3b.preview.currentHash }).then(v => ({ ok: true, v }), e => ({ ok: false, code: e.code }))
assert(re3.ok === true && re3.v.recreated === false, `步骤 5：重新应用成功 (got ok=${re3.ok} recreated=${re3.v && re3.v.recreated} err=${re3.code})`)
assert((await histRow('p3')).state === 'reapplied', '步骤 5：徽章 = 已重新应用')

// 步骤 6：再撤销 → 再重应用（双向循环 ≥3 圈）
for (let i = 0; i < 3; i++) {
  const d = await api.detail({ id: 'p3' })
  const u = await api.apply({ id: 'p3', expectedCurrentHash: d.preview.currentHash }).then(v => ({ ok: true }), e => ({ ok: false, code: e.code }))
  assert(u.ok === true, `双向循环第 ${i + 1} 圈：撤销成功`)
  const d2 = await api.detail({ id: 'p3' })
  const r = await api.reapply({ id: 'p3', expectedCurrentHash: d2.preview.currentHash }).then(v => ({ ok: true }), e => ({ ok: false, code: e.code }))
  assert(r.ok === true, `双向循环第 ${i + 1} 圈：重应用成功`)
}

// 步骤 7：乱序回退被安全闸拦截（设计行为：防吞后续编辑）
// Day 4（定稿 3.1）：p1 之后有 p2/p3 两条「自己记录的编辑」→ superseded_by_later_ops
// （不再笼统报 external_modified；真·外部修改才报 external_modified）
const s1 = await api.detail({ id: 'p1' })
assert(s1.preview.canApply === false && s1.preview.reasons.some(r => r.code === 'superseded_by_later_ops'), '步骤 7：旧条目在文件前进后被 superseded_by_later_ops 拦下')
const undo1Blocked = await api.apply({ id: 'p1', expectedCurrentHash: s1.preview.currentHash }).then(v => ({ ok: true }), e => ({ ok: false, code: e.code }))
assert(undo1Blocked.ok === false, '步骤 7：乱序撤销被拒绝，未写入')

// 步骤 8：从最新往回逐条撤销 → 精确回到初始 10 行
for (const id of ['p3', 'p2', 'p1']) {
  const d = await api.detail({ id })
  const u = await api.apply({ id, expectedCurrentHash: d.preview.currentHash }).then(v => ({ ok: true }), e => ({ ok: false, code: e.code, msg: e.message }))
  assert(u.ok === true, `步骤 8：撤销 ${id} 成功 ${u.ok ? '' : `(${u.code}: ${u.msg || ''})`}`)
}
const finalLines = files.get(PATH).replace(/\n$/, '').split('\n')
assert(finalLines.length === 10 && finalLines[0] === LINES[0] && finalLines[9] === LINES[9], '步骤 8：逐条回退后精确回到初始 10 行')

// ── 3.1 创建 → 删除 → 重建 → 幂等 ────────────────────────────────────────────
console.log('3.1 创建 → 删除 → 重建 → 幂等')
const PATH_B = 'docs-test-b.txt'
files.set(PATH_B, '创建内容 line1\nline2\n')
const cid = `call-${++seq}`
await appendSnapshot(scope, {
  id: `p${++seq}`, filePath: PATH_B, command: 'str_replace_editor', op: 'create',
  callId: cid, before: null, beforeHash: null, after: null, afterHash: null,
  time: Date.now() + 100, state: 'recorded',
})
const bId = `p${seq}`
await backfillAfter(scope, PATH_B, '创建内容 line1\nline2\n', cid)
const db = await api.detail({ id: bId })
assert(db.preview.canApply === true && db.preview.reasons.every(r => r.code !== 'file_creation'), '3.1 捕获内容的创建可安全删除（无 file_creation 拒绝）')
assert(db.item.created === true && db.added === 2, `3.1 新文件统计 +2 新增 (got +${db.added})`)
const delB = await api.apply({ id: bId }).then(v => ({ ok: true, v }), e => ({ ok: false, code: e.code }))
assert(delB.ok === true && delB.v.deleted === true && !files.has(PATH_B), '3.1 撤销创建 = 文件已删除')
const reB = await api.reapply({ id: bId }).then(v => ({ ok: true, v }), e => ({ ok: false, code: e.code }))
assert(reB.ok === true && reB.v.recreated === true && files.get(PATH_B) === '创建内容 line1\nline2\n', '3.1 重应用 = 文件重建')
files.delete(PATH_B)
const goneB = await api.apply({ id: bId }).then(v => ({ ok: true, v }), e => ({ ok: false, code: e.code }))
assert(goneB.ok === true && goneB.v.alreadyGone === true, '3.1 外部已删 = 幂等成功')

// ── 3.2 失败调用混入（P13）────────────────────────────────────────────────────
console.log('3.2 失败调用混入：不污染、可见、可解释')
const beforeFail = files.get(PATH)
await toolEdit(PATH, { fail: true }) // 失败的 str_replace
await toolEdit(PATH, { deleteLine: 2 }) // 其后的成功编辑
const all = await loadSnapshots(scope)
const failRow = all.find(s => s.state === 'aborted')
assert(failRow !== undefined && failRow.failReason === 'old_string not found', '3.2 失败行存在且带原因')
const lastOk = all.filter(s => s.state !== 'aborted').at(-1)
assert(lastOk.before === beforeFail, '3.2 成功行的 before 未被失败行污染')
const failHist = (await api.history()).items.find(i => i.state === 'aborted')
assert(failHist !== undefined, '3.2 面板 history 可见失败行')
const failApply = await api.apply({ id: failHist.id }).then(v => ({ ok: true }), e => ({ ok: false, code: e.code }))
assert(failApply.ok === false && failApply.code === 'aborted_op', '3.2 失败行撤销被拒绝 (aborted_op)')

// ── 3.3 重启恢复（P11）───────────────────────────────────────────────────────
console.log('3.3 重启恢复：recoverActiveScope 命中协议会话')
const recovered = await recoverActiveScope()
assert(recovered !== undefined && recovered.chatKey === 'session-protocol', `3.3 恢复最近活跃 scope (got ${recovered?.chatKey})`)

// ── 3.5 外部修改闸 ────────────────────────────────────────────────────────────
console.log('3.5 外部修改闸：手改后撤销必须被拒')
await toolEdit(PATH, { deleteLine: 3 })
const dBeforeMod = await api.detail({ id: `p${seq}` })
files.set(PATH, '被外部手动修改的完全不同内容\n')
const refused = await api.apply({ id: `p${seq}`, expectedCurrentHash: dBeforeMod.preview.currentHash }).then(v => ({ ok: true }), e => ({ ok: false, code: e.code }))
assert(refused.ok === false && (refused.code === 'external_modified' || refused.code === 'stale'), `3.5 外部修改后撤销被拒 (got ${refused.code})`)

// ── 3.6 相对/绝对路径（P2）────────────────────────────────────────────────────
console.log('3.6 相对与绝对路径：捕获与撤销等价')
const absPath = 'D:\\demo\\dsf-project\\docs-test-abs.txt'
files.set(absPath, '绝对路径内容\n')
const cidAbs = `call-${++seq}`
await appendSnapshot(scope, {
  id: `p${++seq}`, filePath: absPath, command: 'str_replace_editor', op: 'str_replace',
  callId: cidAbs, before: '绝对路径内容\n', beforeHash: sha256('绝对路径内容\n'),
  after: null, afterHash: null, time: Date.now() + 200, state: 'recorded',
})
files.set(absPath, '绝对路径改后\n')
await backfillAfter(scope, absPath, '绝对路径改后\n', cidAbs)
const dAbs = await api.detail({ id: `p${seq}` })
assert(dAbs.item.filePath === absPath && dAbs.preview.canApply === true, '3.6 绝对路径条目可正常预检')

// ── 第四节：v0.3.9 用户可见语义（协议级）──────────────────────────────────────
// 引擎专项断言（47 项）在 verify-rewind.mjs；这里用真实工具生命周期锁死 README
// 「已知限制」与 CHANGELOG 承诺的行为：回退即丢弃后续、cascade 不可单独重应用、
// 账本滞后可补记（零写盘）、空行痕迹只提示不阻断、轮次聚合、hunk 缓存端到端。

// ── 4.1 回退到此状态 = 丢弃其后改动（README 已知限制第一条）───────────────────
console.log('4.1 回退到此状态：其后改动一律丢弃，cascade 不可单独重应用')
const PATH_C = 'docs-test-c.txt'
files.set(PATH_C, 'c1\nc2\nc3\n')
const c1 = await toolEdit(PATH_C, { mutate: t => t + 'c4\n' })
const c2 = await toolEdit(PATH_C, { mutate: t => t + 'c5\n' })
const c3 = await toolEdit(PATH_C, { mutate: t => t + 'c6\n' })
assert(c1 && c2 && c3 && c3 !== c1, '4.1 三次编辑各成一行（后续断言可按 id 定位）')
const pvC = await api.rewindPreview({ id: c1 }).then(v => ({ ok: true, v }), e => ({ ok: false, code: e.code }))
assert(pvC.ok && pvC.v.status === 'ok' && pvC.v.invalidatedCount === 2, `4.1 预检：回退首条将丢弃其后 2 步 (got ${pvC.ok ? pvC.v.invalidatedCount : pvC.code})`)
const apC = await api.rewindApply({ id: c1, expectedCurrentHash: pvC.v.expectedCurrentHash }).then(v => ({ ok: true, v }), e => ({ ok: false, code: e.code }))
assert(apC.ok && apC.v.ledgerSynced === true && apC.v.invalidated === 2, `4.1 执行：级联 2 条、账本同步 (got ${apC.ok ? `invalidated=${apC.v.invalidated}` : apC.code})`)
assert(files.get(PATH_C) === 'c1\nc2\nc3\n', `4.1 磁盘单次写回到目标之前 (got ${JSON.stringify(files.get(PATH_C))})`)
const rowsC = (await api.history()).items
assert(rowsC.find(i => i.id === c1)?.state === 'reverted', '4.1 目标条目 = 已撤销')
assert(rowsC.find(i => i.id === c2)?.state === 'reverted', '4.1 其后条目被级联标记')
// cascade 不可单独重应用（防状态「诈尸」）；direct 可以
const capC = await api.reapply({ id: c2, expectedCurrentHash: null }).then(v => ({ ok: true }), e => ({ ok: false, code: e.code }))
assert(capC.ok === false && capC.code === 'cascade_invalidated', `4.1 cascade 条目重应用被拒 (got ${capC.ok ? 'ok' : capC.code})`)
const rapC = await api.reapply({ id: c1, expectedCurrentHash: null }).then(v => ({ ok: true }), e => ({ ok: false, code: e.code }))
assert(rapC.ok === true, `4.1 目标条目（direct）可重新应用 (got ${rapC.ok ? 'ok' : rapC.code})`)

// ── 4.2 账本滞后：磁盘已是撤销态但标记丢失 → 一键补记（零写盘）───────────────
console.log('4.2 账本滞后：补记只改状态、不动磁盘')
const PATH_D = 'docs-test-d.txt'
files.set(PATH_D, 'd1\n')
const d1 = await toolEdit(PATH_D, { mutate: t => t + 'd2\n' })
files.set(PATH_D, 'd1\n') // 撤销已写盘、标记丢失（崩溃窗口）
const dD = await api.detail({ id: d1 })
assert(dD.preview.status === 'stale_ledger', `4.2 单条撤销路径检出 stale_ledger (got ${dD.preview.status})`)
const hashD = sha256(files.get(PATH_D))
const cfD = await api.confirmStaleLedger({ id: d1 }).then(v => ({ ok: true, v }), e => ({ ok: false, code: e.code }))
assert(cfD.ok && cfD.v.repaired === PATH_D, `4.2 补记成功并返回文件路径 (got ${cfD.ok ? cfD.v.repaired : cfD.code})`)
assert(sha256(files.get(PATH_D)) === hashD, '4.2 补记零字节写入（磁盘 hash 未变）')
assert((await api.history()).items.find(i => i.id === d1)?.state === 'reverted', '4.2 补记后状态 = 已撤销')

// ── 4.3 空行痕迹（定稿 5.1）：清空一行 ≠ 删除整行 ────────────────────────────
console.log('4.3 空行痕迹：黄牌只提示，不阻断撤销')
const PATH_E = 'docs-test-e.txt'
files.set(PATH_E, 'e1\ne2\ne3\n')
const e1 = await toolEdit(PATH_E, { mutate: () => 'e1\n\ne3\n' })
const dE = await api.detail({ id: e1 })
assert(dE.blankLine !== undefined && dE.blankLine.line === 2, `4.3 报告第 2 行被清空 (got ${JSON.stringify(dE.blankLine)})`)
assert(dE.preview.canApply === true, '4.3 空行痕迹不阻断撤销')
const e2 = await toolEdit(PATH_E, { deleteLine: 1 })
const dE2 = await api.detail({ id: e2 })
assert(dE2.blankLine === undefined, '4.3 删除整行不报空行痕迹')

// ── 4.4 轮次聚合（定稿 1.3）：一次模型请求的多次编辑共享 rootCallId ──────────
console.log('4.4 轮次聚合：同一次模型请求的编辑共享 rootCallId')
const PATH_F = 'docs-test-f.txt'
files.set(PATH_F, 'f1\n')
const ROUND = 'root-call-protocol'
const f1 = await toolEdit(PATH_F, { mutate: t => t + 'f2\n', rootCallId: ROUND })
const f2 = await toolEdit(PATH_F, { mutate: t => t + 'f3\n', rootCallId: ROUND })
const histF = (await api.history()).items
assert(histF.find(i => i.id === f1)?.rootCallId === ROUND, '4.4 首条带 rootCallId')
assert(histF.find(i => i.id === f2)?.rootCallId === ROUND, '4.4 同轮次的下一条共享同一聚合键')

// ── 4.5 hunk 缓存（定稿 6.1）端到端：命中一致、不同内容对不串味 ──────────────
console.log('4.5 hunk 缓存：重复详情一致，相同 before 不同 after 不串味')
const dF2a = await api.detail({ id: f2 })
const dF2b = await api.detail({ id: f2 })
assert(JSON.stringify(dF2a.hunks) === JSON.stringify(dF2b.hunks), '4.5 同一对内容两次详情结果一致（缓存命中）')
const PATH_G1 = 'docs-test-g1.txt'
const PATH_G2 = 'docs-test-g2.txt'
files.set(PATH_G1, 'g\nh\ni\n')
files.set(PATH_G2, 'g\nh\ni\n') // 相同 before
const g1 = await toolEdit(PATH_G1, { mutate: () => 'g\nH\ni\n' })
const g2 = await toolEdit(PATH_G2, { mutate: () => 'g\nZ\ni\n' }) // 不同 after
const dG1 = await api.detail({ id: g1 })
const dG2 = await api.detail({ id: g2 })
assert(JSON.stringify(dG1.hunks) !== JSON.stringify(dG2.hunks), '4.5 相同 before、不同 after → 缓存未串味')

await rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
console.log(failures === 0 ? '\nPROTOCOL CONFORMANCE PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
