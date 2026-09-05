/**
 * verify-rewind.mjs — Day 3（测试：穷尽边界）的可执行形态。
 *
 * 覆盖定稿排期 Day 3 全部用例：
 *   ① 完整链条（单次写入 + direct/cascade 标记）
 *   ② 跳过与阻断（aborted/noop 混入、创建类 target、链条 after===null、target.after===null）
 *   ③ 链条咬合专项（2.2.1 / v7.1）：中间被外部修改、级联后再编辑不误报、
 *      级联后再外部修改+编辑则阻断、旧数据迁移走 beforeHash、apply 阶段重跑校验
 *   ④ 空链条边界（target 就是链尾）
 *   ⑤ 并发与滞后：preview 后文件被改（stale）、磁盘已撤销未标记（stale_ledger）
 *   ⑥ confirmStaleLedger 专项：编辑类补记成功、创建类拒绝、磁盘被改拒绝、
 *      已标记拒绝（already_marked）、零字节写入
 *   ⑦ Lineage 断点：创建撤销 → 重建 → 编辑 → 对旧创建条目 already_reverted /
 *      对重建条目 creation_rewind_unsupported
 *   ⑧ 连续级联（回退后立刻再回退更早条目）
 *   ⑨ Reapply 白名单：direct 放行、cascade_invalidated、unknown_revert（fail-closed）
 *   ⑩ 漏标检测：并发改动成员 → ledgerSynced=false 降级
 *   ⑪ 物理边界：preview 后文件被删 → file_missing
 *   ⑫ rootCallId 三层 fallback（Day 4）
 *   ⑬ 级联恢复（v0.3.11）：回退 → 重应用 连带复活 cascade 行，undo/redo 幂等
 *
 * 临时 HOME，绝不触碰真实 ~/.dsh。所有断言来自定稿 Day 3 用例的语义。
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempHome = await mkdtemp(join(tmpdir(), 'rewind-conformance-'))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome

const { appendSnapshot, backfillAfter, markAbortedByCall, loadSnapshots, workspaceKeyOf, snapshotPath, sha256 } = await import('./lib/store.js')
const { buildApi } = await import('./lib/api.js')

let failures = 0
function assert(cond, label) {
  if (cond) console.log(`  ✓ ${label}`)
  else { failures++; console.log(`  ✗ ${label}`) }
}

const files = new Map() // in-memory disk
const scope = { workspaceKey: workspaceKeyOf('D:\\RewindWorkspace'), chatKey: 'session-rewind' }
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

const PATH = 'rewind-file.txt'
let seq = 0

/** Run a handler, normalizing errors into {ok, v|code|msg}. */
const guard = fn => fn().then(v => ({ ok: true, v }), e => ({ ok: false, code: e.code, msg: e.message }))

/** One real tool lifecycle: delete a line (1-based), overwrite content (create), or fail. */
async function toolEdit(path, { content = null, fail = false, rootCallId } = {}) {
  const callId = `call-${++seq}`
  const before = files.has(path) ? files.get(path) : null
  // Append a distinct line so after !== before always (delete-line on a
  // single-line file produced before === after → accidental noop rows).
  const after = content !== null ? content : (before === null ? `l${seq}\n` : before + `l${seq}\n`)
  await appendSnapshot(scope, {
    id: `r${seq}`, filePath: path, command: 'str_replace_editor', op: before === null ? 'create' : 'str_replace',
    callId, before, beforeHash: before === null ? null : sha256(before),
    after: null, afterHash: null, time: Date.now() + seq, state: 'recorded',
    ...(rootCallId !== undefined ? { rootCallId } : {}),
  })
  if (fail) {
    await markAbortedByCall(scope, callId, 'boom')
    return `r${seq}`
  }
  files.set(path, after)
  await backfillAfter(scope, path, after, callId, rootCallId)
  return `r${seq}`
}

const row = async id => (await loadSnapshots(scope)).find(s => s.id === id)

/** Direct JSONL surgery on one row (simulates corruption / legacy data / ledger loss). */
async function rewriteRow(id, patch) {
  const path = snapshotPath(scope)
  const text = await readFile(path, 'utf8')
  const out = text.split('\n').filter(Boolean).map(line => {
    const o = JSON.parse(line)
    return o.id === id ? JSON.stringify({ ...o, ...patch }) : line
  })
  await writeFile(path, out.join('\n') + '\n')
}

// ── ① 完整链条：单次写入 + direct/cascade 标记 ────────────────────────────────
console.log('① 完整链条：单次写入 + direct/cascade 标记')
files.set(PATH, 'v1\n')
await toolEdit(PATH)   // r1: v1→v2
await toolEdit(PATH)   // r2: v2→v3
await toolEdit(PATH)   // r3: v3→v4
const pv1 = await guard(() => api.rewindPreview({ id: 'r1' }))
assert(pv1.ok && pv1.v.status === 'ok' && pv1.v.contentToWrite === 'v1\n' && pv1.v.invalidatedCount === 2, '① preview：回写 v1、级联 2 条')
const ap1 = await guard(() => api.rewindApply({ id: 'r1', expectedCurrentHash: pv1.v.expectedCurrentHash }))
assert(ap1.ok && ap1.v.ledgerSynced === true && ap1.v.invalidated === 2, '① apply：ledgerSynced=true、invalidated=2')
assert(files.get(PATH) === 'v1\n', '① 磁盘单次写入回到 v1')
assert((await row('r1')).state === 'reverted' && (await row('r1')).revertReason === 'direct', '① r1 标记 direct')
assert((await row('r2')).state === 'reverted' && (await row('r2')).revertReason === 'cascade', '① r2 标记 cascade')
assert((await row('r3')).state === 'reverted' && (await row('r3')).revertReason === 'cascade', '① r3 标记 cascade')

// ── ② 跳过与阻断 ──────────────────────────────────────────────────────────────
console.log('② 跳过与阻断')
files.set(PATH, 'a1\n')
await toolEdit(PATH)                    // r4: a1→a2
await toolEdit(PATH, { fail: true })        // r5: aborted（磁盘不动）
const noopCall = `call-${++seq}`                           // r6: noop（磁盘不动）
const noopBefore = files.get(PATH)
await appendSnapshot(scope, {
  id: `r${seq}`, filePath: PATH, command: 'str_replace_editor', op: 'str_replace',
  callId: noopCall, before: noopBefore, beforeHash: sha256(noopBefore),
  after: null, afterHash: null, time: Date.now() + seq, state: 'noop',
})
await toolEdit(PATH)                    // r7: a2→a3
const pv2 = await guard(() => api.rewindPreview({ id: 'r4' }))
assert(pv2.ok && pv2.v.invalidatedCount === 1, '② 夹 aborted/noop：级联只算有效链（1 条）')
const ap2 = await guard(() => api.rewindApply({ id: 'r4', expectedCurrentHash: pv2.v.expectedCurrentHash }))
assert(ap2.ok && ap2.v.invalidated === 1 && files.get(PATH) === 'a1\n', '② 回退成功且只标 1 条')
assert((await row('r5')).state === 'aborted', '② aborted 行保持原状')
assert((await row('r6')).state === 'noop', '② noop 行保持原状')
assert((await row('r7')).state === 'reverted' && (await row('r7')).revertReason === 'cascade', '② 有效链被级联标记')

// ② 创建类 target → creation_rewind_unsupported
files.set(PATH, 'c1\n')
const cid = `call-${++seq}`
await appendSnapshot(scope, {
  id: `r${seq}`, filePath: PATH, command: 'write', op: 'create',
  callId: cid, before: null, beforeHash: null, after: null, afterHash: null,
  time: Date.now() + seq, state: 'recorded',
})
const createdId = `r${seq}`
await backfillAfter(scope, PATH, 'c1\n', cid)
const pb2 = await guard(() => api.rewindPreview({ id: createdId }))
assert(!pb2.ok && pb2.code === 'creation_rewind_unsupported', '② 创建类 target → creation_rewind_unsupported')

// ② 链条含 after===null → unsupported_checkpoint
await toolEdit(PATH)   // r9: c1→c2
await toolEdit(PATH)   // r10: c2→c3
await rewriteRow('r10', { after: null, afterHash: null })
const pc2 = await guard(() => api.rewindPreview({ id: 'r9' }))
assert(!pc2.ok && pc2.code === 'unsupported_checkpoint', '② 链条含 after===null → unsupported_checkpoint')
const pd2 = await guard(() => api.rewindPreview({ id: 'r10' }))
assert(!pd2.ok && pd2.code === 'unsupported_checkpoint', '② target.after===null → unsupported_checkpoint')

// ── ③ 链条咬合专项（2.2.1 / v7.1）──────────────────────────────────────────────
console.log('③ 链条咬合专项（2.2.1 / v7.1）')
files.set(PATH, 'm1\n')
await toolEdit(PATH)   // r11: m1→m2
await toolEdit(PATH)   // r12: m2→m3
await toolEdit(PATH)   // r13: m3→m4

// ③a 链条中间被外部修改（数据损坏）→ 阻断 external_modified
const r12BeforeHash = (await row('r12')).beforeHash
await rewriteRow('r12', { beforeHash: sha256('MALICIOUS') })
const pa3 = await guard(() => api.rewindPreview({ id: 'r11' }))
assert(!pa3.ok && pa3.code === 'external_modified', '③a 链条中间不一致 → external_modified')
await rewriteRow('r12', { beforeHash: r12BeforeHash })

// ③b 级联回退后再编辑 → 不误报（v7.1：基准 = tail 最近 direct 行的 beforeHash）
const r12before = (await row('r12')).before
const pv3b = await guard(() => api.rewindPreview({ id: 'r12' }))
const ap3b = await guard(() => api.rewindApply({ id: 'r12', expectedCurrentHash: pv3b.v.expectedCurrentHash }))
assert(ap3b.ok && files.get(PATH) === r12before, '③b 先级联回退 r12（r13 cascade，磁盘回到 r12.before）')
await toolEdit(PATH)   // r14：建立在级联后的磁盘上
const pv3c = await guard(() => api.rewindPreview({ id: 'r11' }))
assert(pv3c.ok && pv3c.v.invalidatedCount === 1 && pv3c.v.idsToMark?.[1] === 'r14', '③b 再回退 r11：只级联 r14，不误报旧链条')

// ③c 级联回退后又外部修改 + 新编辑 → 阻断
files.set(PATH, 'M\n')                    // 外部修改（不在账本里）
await toolEdit(PATH)   // r15: M→M2
const pv3d = await guard(() => api.rewindPreview({ id: 'r11' }))
assert(!pv3d.ok && pv3d.code === 'external_modified', '③c 级联后外部修改再编辑 → 阻断')

// ③d 旧数据迁移：单条撤销产生的 reverted 行字段缺失 → normalize 补 direct →
// 走 beforeHash 不误报；且可 Reapply。
// （注意：真实旧数据里 reverted 只可能来自单条撤销 —— cascade 是 v0.3.9 才引入的，
//  所以迁移为 direct 是唯一正确解，不能用级联行来伪装。）
files.set(PATH, 'n1\n')
await toolEdit(PATH)   // r16: n1→n1l16
await toolEdit(PATH)   // r17: →n1l16l17
await toolEdit(PATH)   // r18: →n1l16l17l18
const ap3d = await guard(() => api.apply({ id: 'r18' }))   // 单条撤销 r18（磁盘停在 r18.before）
assert(ap3d.ok && files.get(PATH) === 'n1\nl16\nl17\n', '③d 先单条撤销 r18（磁盘停在 r18.before）')
await rewriteRow('r18', { revertReason: undefined }) // 模拟旧数据（字段缺失）
assert((await row('r18')).revertReason === 'direct', '③d 缺失字段被迁移为 direct')
await toolEdit(PATH)   // r19: →+l19
const pv3f = await guard(() => api.rewindPreview({ id: 'r16' }))
assert(pv3f.ok && pv3f.v.status === 'ok', '③d 迁移后走 beforeHash → 不误报')
const re3g = await guard(() => api.reapply({ id: 'r18' }))
assert(re3g.ok && files.get(PATH) === 'n1\nl16\nl17\nl18\n' && (await row('r18')).state === 'reapplied', '③d 迁移为 direct 的旧数据可正常 Reapply')

// ③e apply 阶段重跑咬合（TOCTOU）：preview 通过后链条被改 → apply 拦截
files.set(PATH, 'o1\n')
await toolEdit(PATH)   // r20: o1→o2
await toolEdit(PATH)   // r21: o2→o3
await toolEdit(PATH)   // r22: o3→o4
const pv3h = await guard(() => api.rewindPreview({ id: 'r20' }))
assert(pv3h.ok, '③e preview 阶段通过')
await rewriteRow('r21', { beforeHash: sha256('CORRUPTED') })
const ap3i = await guard(() => api.rewindApply({ id: 'r20', expectedCurrentHash: pv3h.v.expectedCurrentHash }))
assert(!ap3i.ok && ap3i.code === 'external_modified', '③e apply 阶段重跑校验拦截损坏链条')

// ── ④ 空链条边界：target 就是链尾 ──────────────────────────────────────────────
console.log('④ 空链条边界：target 就是链尾')
files.set(PATH, 'e1\n')
await toolEdit(PATH)   // r23: e1→e2
await toolEdit(PATH)   // r24: e2→e3
const r24b = (await row('r24')).before
const pv4 = await guard(() => api.rewindPreview({ id: 'r24' }))
assert(pv4.ok && pv4.v.invalidatedCount === 0 && pv4.v.contentToWrite === r24b, '④ preview：invalidatedCount=0、回写 r24.before')
const ap4 = await guard(() => api.rewindApply({ id: 'r24', expectedCurrentHash: pv4.v.expectedCurrentHash }))
assert(ap4.ok && ap4.v.invalidated === 0 && files.get(PATH) === r24b && (await row('r24')).revertReason === 'direct', '④ 链尾回退成功，仅 direct 标记')

// ── ⑤ 并发与滞后：stale / stale_ledger ─────────────────────────────────────────
console.log('⑤ 并发与滞后：stale / stale_ledger')
files.set(PATH, 's1\n')
await toolEdit(PATH)   // r25: s1→s2
await toolEdit(PATH)   // r26: s2→s3
const pv5 = await guard(() => api.rewindPreview({ id: 'r25' }))
assert(pv5.ok, '⑤a preview 通过')
files.set(PATH, 'RACER\n')                // preview 后文件被并发改动
const ap5 = await guard(() => api.rewindApply({ id: 'r25', expectedCurrentHash: pv5.v.expectedCurrentHash }))
assert(!ap5.ok && ap5.code === 'stale', '⑤a preview 后文件被改 → apply 抛 stale')

// ⑤b 磁盘已撤销未标记 → stale_ledger（可修复，非失效）
files.set(PATH, 's1\n')                   // 模拟撤销写盘成功、但标记丢失（崩溃窗口）
const d5b = await guard(() => api.detail({ id: 'r25' }))
assert(d5b.ok && d5b.v.preview.status === 'stale_ledger', '⑤b 单条撤销路径检测到 stale_ledger')
const rw5b = await guard(() => api.rewindPreview({ id: 'r25' }))
assert(rw5b.ok && rw5b.v.status === 'stale_ledger', '⑤b RewindTo 路径同样检测到 stale_ledger')

// ── ⑥ confirmStaleLedger 专项 ──────────────────────────────────────────────────
console.log('⑥ confirmStaleLedger 专项')
// ⑥a 编辑类补记成功 + 零字节写入（磁盘 hash 不变）
const beforeHash6 = sha256(files.get(PATH))
const cf6a = await guard(() => api.confirmStaleLedger({ id: 'r25' }))
assert(cf6a.ok && cf6a.v.repaired === PATH, '⑥a 补记成功并返回文件路径')
assert((await row('r25')).state === 'reverted' && (await row('r25')).revertReason === 'direct', '⑥a r25 被标记 direct')
assert(sha256(files.get(PATH)) === beforeHash6, '⑥a 零字节写入：目标文件 hash 未变')
// ⑥b 创建类 → unsupported_operation
files.set(PATH, 'g1\n')
const gid = `call-${++seq}`
await appendSnapshot(scope, {
  id: `r${seq}`, filePath: PATH, command: 'write', op: 'create',
  callId: gid, before: null, beforeHash: null, after: null, afterHash: null,
  time: Date.now() + seq, state: 'recorded',
})
const gId = `r${seq}`
await backfillAfter(scope, PATH, 'g1\n', gid)
const cf6b = await guard(() => api.confirmStaleLedger({ id: gId }))
assert(!cf6b.ok && cf6b.code === 'unsupported_operation', '⑥b 创建类 → unsupported_operation')
// ⑥c 补记时磁盘被改 → not_undone
// （注意：id 不能硬编码 —— ⑥b 的创建行已占用 r27，此处 toolEdit 实际生成 r28）
files.set(PATH, 's1\n')
const editId = await toolEdit(PATH)       // s1→s2
files.set(PATH, 's1\n')                   // 模拟撤销写盘未标记
files.set(PATH, 'SNEAKY\n')               // 补记前磁盘又被动过
const cf6c = await guard(() => api.confirmStaleLedger({ id: editId }))
assert(!cf6c.ok && cf6c.code === 'not_undone', '⑥c 磁盘已离开撤销态 → not_undone')
// ⑥d 目标已是终态 → already_marked
files.set(PATH, 's1\n')                   // 回到撤销态
const cf6d1 = await guard(() => api.confirmStaleLedger({ id: editId }))
assert(cf6d1.ok, '⑥d 第一次补记成功')
const cf6d2 = await guard(() => api.confirmStaleLedger({ id: editId }))
assert(!cf6d2.ok && cf6d2.code === 'already_marked', '⑥d 已标记 → already_marked')

// ── ⑦ Lineage 断点：创建撤销 → 重建 → 编辑 ────────────────────────────────────
console.log('⑦ Lineage 断点：创建撤销 → 重建 → 编辑')
const g2id = `call-${++seq}`
files.set(PATH, 'h1\n')
await appendSnapshot(scope, {
  id: `r${seq}`, filePath: PATH, command: 'write', op: 'create',
  callId: g2id, before: null, beforeHash: null, after: null, afterHash: null,
  time: Date.now() + seq, state: 'recorded',
})
const hCreateId = `r${seq}`
await backfillAfter(scope, PATH, 'h1\n', g2id)
const ap7a = await guard(() => api.apply({ id: hCreateId }))
assert(ap7a.ok && ap7a.v.deleted === true && !files.has(PATH), '⑦ 撤销创建（文件删除）')
files.set(PATH, 'h2\n')                   // 重新创建
const g3id = `call-${++seq}`
await appendSnapshot(scope, {
  id: `r${seq}`, filePath: PATH, command: 'write', op: 'create',
  callId: g3id, before: null, beforeHash: null, after: null, afterHash: null,
  time: Date.now() + seq, state: 'recorded',
})
const h2CreateId = `r${seq}`
await backfillAfter(scope, PATH, 'h2\n', g3id)
await toolEdit(PATH)   // 编辑 h2→h3（id 随 seq 递增，不参与后续断言）
const rw7a = await guard(() => api.rewindPreview({ id: hCreateId }))
assert(!rw7a.ok && rw7a.code === 'already_reverted', '⑦ 对已撤销的旧创建条目 → already_reverted')
const rw7b = await guard(() => api.rewindPreview({ id: h2CreateId }))
assert(!rw7b.ok && rw7b.code === 'creation_rewind_unsupported', '⑦ 对重建创建条目 → creation_rewind_unsupported')

// ── ⑧ 连续级联：回退后立刻再回退更早条目 ──────────────────────────────────────
console.log('⑧ 连续级联')
files.set(PATH, 'k1\n')
const r29 = await toolEdit(PATH)   // k1→k2
const r30 = await toolEdit(PATH)   // k2→k3
const r31 = await toolEdit(PATH)   // k3→k4
const r32 = await toolEdit(PATH)   // k4→k5
const pv8a = await guard(() => api.rewindPreview({ id: r30 }))
assert(pv8a.ok && pv8a.v.status === 'ok', '⑧ 第一级 preview 通过')
const ap8a = await guard(() => api.rewindApply({ id: r30, expectedCurrentHash: pv8a.v.expectedCurrentHash }))
assert(ap8a.ok && files.get(PATH) === (await row(r30)).before, '⑧ 第一级：回退 r30（r31/r32 cascade，磁盘回到 r30.before）')
const pv8b = await guard(() => api.rewindPreview({ id: r29 }))
assert(pv8b.ok && pv8b.v.status === 'ok' && pv8b.v.invalidatedCount === 0, '⑧ 第二级：回退 r29（旧链全跳过，无需级联）')
const ap8b = await guard(() => api.rewindApply({ id: r29, expectedCurrentHash: pv8b.v.expectedCurrentHash }))
assert(ap8b.ok && files.get(PATH) === (await row(r29)).before && (await row(r29)).revertReason === 'direct', '⑧ 连续级联到 r29.before，r29 标记 direct')

// ── ⑨ Reapply 白名单（4.1 / fail-closed + v0.3.11 连带复活）──────────────────
// 顺序敏感：9a 会把 r31/r32 连带复活，fail-closed 断言必须在它之前跑。
console.log('⑨ Reapply 白名单（4.1 / fail-closed）')
// 9b cascade → cascade_invalidated（上游源头未被重应用时，单独复活仍被拒）
const re9b = await guard(() => api.reapply({ id: r31 }))
assert(!re9b.ok && re9b.code === 'cascade_invalidated', '⑨b cascade 条目 → cascade_invalidated')
// 9c 未知 revertReason → unknown_revert（normalize 只迁移「缺失」，不吞未知值）
await rewriteRow(r31, { revertReason: 'weird' })
assert((await row(r31)).revertReason === undefined, '⑨c 未知值不被迁移（保持 undefined）')
const re9c = await guard(() => api.reapply({ id: r31 }))
assert(!re9c.ok && re9c.code === 'unknown_revert', '⑨c 未知撤销来源 → unknown_revert')
// 9a direct → 放行，并连带复活被它 cascade 的 r31/r32（v0.3.11）。
// 注意 9c 之后 r31.revertReason 已是 undefined，但 cascadeOf=r30 仍在 ——
// 恰好验证复活只认 cascadeOf，不依赖 revertReason 残留。
const re9a = await guard(() => api.reapply({ id: r30 }))
assert(
  re9a.ok && re9a.v.revived === 2 && files.get(PATH) === (await row(r32)).after && (await row(r30)).state === 'reapplied',
  '⑨a direct 条目 Reapply 连带复活 2 条（磁盘回到链条尾 r32.after）',
)

// ── ⑩ 漏标检测：并发改动链条成员 → ledgerSynced=false ─────────────────────────
console.log('⑩ 漏标检测')
files.set(PATH, 'L1\n')
const r33 = await toolEdit(PATH)   // L1→L2
const r34 = await toolEdit(PATH)   // L2→L3
const r35 = await toolEdit(PATH)   // L3→L4
const pv10 = await guard(() => api.rewindPreview({ id: r33 }))
assert(pv10.ok, '⑩ preview 通过')
// 并发撤销必须落在「apply 重建链条之后、markRevertedBatch 重新加载之前」的
// TOCTOU 窗口才会造成部分标记 —— 若在 apply 前改，buildRewindChain 会直接跳过
// 该行，账本依旧干净。这里挂起 writeText：单次原子写落地后、记账前注入并发撤销。
const origWriteText = ctx.fs.writeText
ctx.fs.writeText = async (t, content, ...rest) => {
  await origWriteText(t, content, ...rest)
  await rewriteRow(r35, { state: 'reverted', revertReason: 'direct' })
}
let ap10
try {
  ap10 = await guard(() => api.rewindApply({ id: r33, expectedCurrentHash: pv10.v.expectedCurrentHash }))
} finally {
  ctx.fs.writeText = origWriteText
}
assert(ap10.ok && ap10.v.ledgerSynced === false && typeof ap10.v.warning === 'string', '⑩ 部分标记成功 → ledgerSynced=false + warning')
assert((await row(r35)).state === 'reverted', '⑩ 并发行保持原状（跳过而非覆盖）')

// ── ⑪ 物理边界：preview 后文件被删 → file_missing ─────────────────────────────
console.log('⑪ 物理边界：preview 后文件被删')
files.set(PATH, 'q1\n')
const r36 = await toolEdit(PATH)   // q1→q2
await toolEdit(PATH)               // q2→q3（不参与断言）
const pv11 = await guard(() => api.rewindPreview({ id: r36 }))
assert(pv11.ok, '⑪ preview 通过')
files.delete(PATH)                        // preview 后文件被删除
const ap11 = await guard(() => api.rewindApply({ id: r36, expectedCurrentHash: pv11.v.expectedCurrentHash }))
assert(!ap11.ok && ap11.code === 'file_missing', '⑪ 文件被删 → file_missing')

// ── ⑫ 单条撤销语义拆分 + rootCallId 注入（Day 4 / 定稿 3.1 + 1.3）─────────────────
console.log('⑫ 语义拆分 + rootCallId 注入（Day 4）')
files.set(PATH, 's1\n')
const sA = await toolEdit(PATH, { rootCallId: 'root-1' })      // s1→s2
const sB = await toolEdit(PATH, { rootCallId: 'root-1' })      // s2→s3（同文件后续编辑，同一轮）
const sC = await toolEdit(PATH, { rootCallId: 'root-2' })      // s3→s4（同文件后续编辑，另一轮）
await toolEdit('rewind-file-2.txt', { rootCallId: 'root-2' })  // 另一文件 —— 不计入 N

// ⑫a 后续有编辑 → superseded_by_later_ops（N=2，跨文件不计入）
const dA = await guard(() => api.detail({ id: sA }))
assert(
  dA.ok &&
    dA.v.preview.reasons.some(r => r.code === 'superseded_by_later_ops') &&
    dA.v.preview.reasons.some(r => r.message.includes('2 次编辑')),
  '⑫a 同文件后续 2 次编辑 → superseded_by_later_ops（N=2，跨文件不计入）',
)

// ⑫b 后续条目已被撤销 → 不计入 → 退回 external_modified
await rewriteRow(sB, { state: 'reverted', revertReason: 'direct' })
await rewriteRow(sC, { state: 'reverted', revertReason: 'cascade' })
const dB = await guard(() => api.detail({ id: sA }))
assert(
  dB.ok &&
    dB.v.preview.reasons.some(r => r.code === 'external_modified') &&
    !dB.v.preview.reasons.some(r => r.code === 'superseded_by_later_ops'),
  '⑫b 后续已撤销 → 不计入，退回 external_modified',
)

// ⑫c 真外部修改（磁盘被改、无后续快照证据）→ external_modified
const sD = await toolEdit(PATH)   // s4→s5
files.set(PATH, 'EXT\n')          // 外部修改（不进账本）
const dC = await guard(() => api.detail({ id: sD }))
assert(
  dC.ok &&
    dC.v.preview.reasons.some(r => r.code === 'external_modified') &&
    !dC.v.preview.reasons.some(r => r.code === 'superseded_by_later_ops'),
  '⑫c 真外部修改 → external_modified',
)

// ⑫e apply 阶段同样拆分（防御：跳过 preview 直接 apply）
const apEx = await guard(() => api.apply({ id: sD }))
assert(!apEx.ok && apEx.code === 'external_modified', '⑫e apply：无后续 → external_modified')
await toolEdit(PATH)              // sE：EXT→EXT+l —— sD 的后续编辑
const apSup = await guard(() => api.apply({ id: sD }))
assert(!apSup.ok && apSup.code === 'superseded_by_later_ops', '⑫e apply：后续有编辑 → superseded_by_later_ops')

// ⑫d rootCallId：append 尽力存 + backfill 保底补写 + normalize 三层 fallback
assert((await row(sA)).rootCallId === 'root-1', '⑫d rootCallId 随 append 落盘（同轮共享 root-1）')
assert((await row(sC)).rootCallId === 'root-2', '⑫d rootCallId 随 append 落盘（另一轮 root-2）')
const fbCall = `call-${++seq}`
const fbBefore = files.get(PATH)  // 'EXT+l..'
const fbAfter = fbBefore + `l${seq}\n`
await appendSnapshot(scope, {
  id: `r${seq}`, filePath: PATH, command: 'str_replace_editor', op: 'str_replace',
  callId: fbCall, before: fbBefore, beforeHash: sha256(fbBefore),
  after: null, afterHash: null, time: Date.now() + seq, state: 'recorded',
})
const fbId = `r${seq}`
files.set(PATH, fbAfter)
await backfillAfter(scope, PATH, fbAfter, fbCall, 'root-fallback')
assert((await row(fbId)).rootCallId === 'root-fallback', '⑫d backfill 保底补写 rootCallId（noop 分支之前）')
const legId = `legacy-${++seq}`
await appendSnapshot(scope, {
  id: legId, filePath: PATH, command: 'str_replace_editor', op: 'str_replace',
  before: 'x\n', beforeHash: sha256('x\n'), after: null, afterHash: null,
  time: Date.now() + seq, state: 'recorded',
})
assert((await row(legId)).rootCallId === legId, '⑫d normalize 三层 fallback：rootCallId → callId → id')

// ⑫f backfill target 匹配不到（legacy FIFO 退化）→ 允许缺失，绝不阻断
await backfillAfter(scope, PATH, 'x\n', 'call-no-such', 'root-x')
assert(true, '⑫f backfill target 匹配不到 → 不阻断')

// ── ⑬ 级联恢复（v0.3.11）：让「回退 → 重应用」恢复幂等 ──────────────────────
//
// 此前的行为（用户实测）：回退中间一条 → 后续行被标 cascade → 重应用该条
// 只复活自己，cascade 行变成既不能回退、也不能重应用的砖头，undo/redo 循环
// 因此有副作用。本段断言：重应用上游源头时，整批 cascade 行一并复活。
console.log('⑬ 级联恢复（v0.3.11）')
files.set(PATH, 'c1\n')
const r40 = await toolEdit(PATH)   // c1 → c2
const r41 = await toolEdit(PATH)   // c2 → c3
const r42 = await toolEdit(PATH)   // c3 → c4
const diskBeforeRewind = files.get(PATH)

const pv13 = await guard(() => api.rewindPreview({ id: r41 }))
assert(pv13.ok && pv13.v.invalidatedCount === 1, '⑬ preview：回退 r41 将连带作废 1 条')
const ap13 = await guard(() => api.rewindApply({ id: r41, expectedCurrentHash: pv13.v.expectedCurrentHash }))
assert(ap13.ok && files.get(PATH) === (await row(r41)).before, '⑬ 回退落地：磁盘回到 r41.before')

// ⑬a 账本记录级联来源（rewindApply 与 state/revertReason 同一事务写入）
assert((await row(r42)).cascadeOf === r41, '⑬a cascade 行记录 cascadeOf（指向回退目标）')
assert((await row(r41)).cascadeOf === undefined, '⑬a direct 行不带 cascadeOf')

// ⑬b fail-closed 必须保持：单独重应用 cascade 行依然被拒（复活只能由上游触发）
const re13b = await guard(() => api.reapply({ id: r42 }))
assert(!re13b.ok && re13b.code === 'cascade_invalidated', '⑬b 单独重应用 cascade 行 → 仍被 cascade_invalidated 拦截')

// ⑬c detail 提示连带恢复条数（避免"静默改写历史"）
const det13 = await guard(() => api.detail({ id: r41 }))
assert(det13.ok && det13.v.revivable === 1, '⑬c detail 提示 revivable=1')

// ⑬d 重应用上游 → 连带复活，磁盘回到回退前（= r42.after，而非停在 r41.after）
const re13 = await guard(() => api.reapply({ id: r41 }))
assert(re13.ok && re13.v.revived === 1 && re13.v.ledgerSynced === true, '⑬d 重应用连带复活 1 条且账本整批同步')
assert(files.get(PATH) === diskBeforeRewind, '⑬d 磁盘回到回退前状态（连带应用了 r42，不是停在 r41.after）')

// ⑬e 状态与字段清理：不留上一次回退的痕迹
assert((await row(r41)).state === 'reapplied' && (await row(r42)).state === 'reapplied', '⑬e 两行都复活为 reapplied')
assert(
  (await row(r42)).revertReason === undefined && (await row(r42)).cascadeOf === undefined,
  '⑬e 复活清除 revertReason/cascadeOf（半残留会让下次回退的 reason 串味）',
)

// ⑬f 砖头消失：复活后的 r42 重新可撤销（此前它两种操作都会被拒）
const und13 = await guard(() => api.apply({ id: r42 }))
assert(und13.ok && files.get(PATH) === (await row(r42)).before, '⑬f 复活后的 r42 可正常撤销（不再是砖头）')

// ⑬g 旧数据/无级联兼容：单条撤销的行重应用 revived=0
files.set(PATH, 'd1\n')
const r43 = await toolEdit(PATH)   // d1 → d2
const ap13g = await guard(() => api.apply({ id: r43 }))
assert(ap13g.ok, '⑬g 单条撤销成功')
const re13g = await guard(() => api.reapply({ id: r43 }))
assert(re13g.ok && (re13g.v.revived ?? 0) === 0, '⑬g 无级联来源 → revived=0（旧数据与单条撤销不受影响）')

const total = failures === 0
console.log(`\nverify-rewind.mjs: ${total ? 'OK' : 'FAILED'}（失败 ${failures} 项）`)
if (failures > 0) process.exit(1)
