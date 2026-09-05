# 贡献指南

谢谢愿意贡献！这个插件改的是「文件安全」，门槛比一般插件严格一档：**PR 前本地门禁全绿是硬性要求**——CI 会在 Windows runner 上跑同一套，两边都绿才算过。

## 环境

- Node.js ≥ 20、pnpm ≥ 10、git
- `git clone https://github.com/QinLuza/dsh-file-undo.git && cd dsh-file-undo && pnpm install`

## 项目地图

| 路径 | 内容 |
|---|---|
| `src/index.ts` | host 半入口：工具链钩子捕获、HTTP API |
| `src/store.ts` | 快照账本（状态机、工作区/会话两层隔离） |
| `src/diff.ts` | 行级 LCS（整数行 ID + Uint32 DP） |
| `src/api.ts` | 预检/撤销/回退/重应用的 API 契约 |
| `src/client/*` | 侧栏入口 + 审查面板（React） |
| `lib/` | 构建产物，随源码提交 |

## PR 门禁（提交前本地全跑）

```sh
pnpm typecheck
pnpm build
node smoke-test.mjs
node verify-visual.mjs
node verify-protocol.mjs
node verify-prune.mjs
node verify-rewind.mjs
node verify-follow.mjs
```

全部 `PASSED` 才允许 commit。脚本都是临时 HOME 隔离，不会碰你真实的 `~/.dsh`。

CI 会在 `windows-latest` 上跑同一套；本地跑不了的部分（真实 DSH 里的面板行为）在 PR 里说明即可。

## 语义红线（是设计，不是 bug）

- **引擎裁决、UI 只展示**：预检/事务/乐观锁的判定都在 host 半，不要搬进 client
- **`external_modified` fail-closed**：外部修改过的文件宁可拒绝，不放宽
- **状态机不可绕过**：`recorded → reverted → reapplied`；cascade 不能被单独复活，只能由上游连带
- **快照 JSONL 向后兼容**：旧格式条目标注 `unknown_state`，不做破坏性迁移
- **存储键规范化**：同一目录恒为同一个键，存量零迁移
- **相对路径一律经会话 cwd 解析**，不从进程 cwd 推

## 测试要求

- 新行为/修复必须配 `verify-*.mjs` 断言（临时 HOME 隔离）
- 改函数签名必须同步所有测试 mock——mock 过期会崩在加载而非断言，假绿真红
- 涉及面板的改动在真实 DSH 里过一遍，PR 里说明

## 隐私

- Issue / PR 里**不要粘贴** `~/.dsh/file-undo/` 下的快照原文（含文件内容）——贴文件名、状态分类、行数统计就够
- 截图/日志注意打码工作区路径

## 提交

- 提交信息：`feat:` / `fix:` / `docs:` 前缀 + 一句话讲清语义
- PR 面向 `master`，模板清单逐项勾
