# dsh-file-undo

DSH 插件：撤销 agent 的**文件写入/编辑操作**（`str_replace_editor` 的 `str_replace` / `insert`），通过 `/undo` 恢复到操作前状态。

> 不做的事（明确边界）：**删除回退不支持**——官方 fs 无 delete/unlink 方法，等官方支持后再做；文件创建（`create`）的撤销也因此不可用（还原 = 删除文件，超出官方 API 能力），命令会明确提示，不绕开官方 API。

## 机制（走官方服务 API）

```
拦截：tools/pre-execute waterfall（官方工具执行管道）
  └─ 匹配 str_replace_editor（create/str_replace/insert）
      └─ ctx.fs.resolve(path) + ctx.fs.readText(target) 读操作前内容
          └─ 追加到 ~/.dsh/file-undo/snapshots.jsonl（append-only JSONL）

回退：/undo 命令（ctx.commands.register）
  └─ ctx.fs.writeText(target, before) 还原
```

**为什么不用官方 result 的 `before`**：`str_replace_editor` 工具丢弃了 fs outcome 的 `before`（只返回成功文案），所以必须在 `tools/pre-execute` 里自己读原文件——这是查证源码后的结论（`dsh-tool-str-replace-editor/lib/index.js` L219 只 return 字符串）。

## 使用

| 命令 | 行为 |
|---|---|
| `/undo` | 撤销最近一次文件写入/编辑 |
| `/undo list` | 列出所有已记录的操作（index + 时间 + 命令 + 文件） |
| `/undo <n>` | 按索引撤销指定操作点 |
| `/undo prune [days]` | 清理 N 天前的快照（默认 7 天）；只缩短可回退深度，不动任何当前文件 |

**保留策略**：插件每次加载时自动执行一次默认 7 天的惰性清理；`time` 字段缺失的条目一律保留（未知年龄的数据不删）。

## 安装

```sh
cd ~/.dsh/profiles/web
pnpm install   # 或 dsh plugin --profile web add dsh-file-undo
```

或从源码构建：

```sh
pnpm install && pnpm build
# profile/package.json dependencies 加 "dsh-file-undo": "link:<本目录>"
# profile/cordis.patch.yml 追加：
#   - insert:
#       - id: file-undo
#         name: 'dsh-file-undo'
```

改完**硬刷新浏览器**（client 改动热加载；host 半改动需重启 `dsh web`）。

## 验证

```sh
node verify.mjs   # mock ctx + 真实临时文件的端到端验证（不碰运行中的 dsh）
pnpm typecheck
pnpm build
```

## 已知限制

- 只覆盖 `str_replace_editor` 工具；`bash`/`pwsh` 里的 `Set-Content`/重定向写文件不覆盖
- 快照是全局的（不分会话）；清理策略 = 加载时惰性清理 + `/undo prune [days]`（默认 7 天）
- 快照文件位置：`~/.dsh/file-undo/snapshots.jsonl`
