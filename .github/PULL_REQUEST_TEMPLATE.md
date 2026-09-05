## 改动类型

- [ ] feat
- [ ] fix
- [ ] docs
- [ ] refactor
- [ ] 测试/回归

## 动机

<!-- 为什么改：用户可感知的行为变化是什么 -->

## 门禁（本地全绿后勾选）

- [ ] pnpm typecheck
- [ ] pnpm build
- [ ] node smoke-test.mjs
- [ ] node verify-visual.mjs
- [ ] node verify-protocol.mjs
- [ ] node verify-prune.mjs
- [ ] node verify-rewind.mjs
- [ ] node verify-follow.mjs

## 语义红线自检

- [ ] 未把预检/裁决逻辑搬进 client 半
- [ ] external_modified / cascade 语义未放宽
- [ ] 快照 JSONL 字段保持向后兼容
- [ ] 存储键派生未变（存量零迁移）
- [ ] 新行为/修复已配 verify 断言

## 相关 issue
