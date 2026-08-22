# dsh-file-undo

[简体中文](README.md) | [English](README_EN.md)

DSH 插件：撤销 agent 对文件的 **`write` / `edit`** 操作，通过 `/undo` 恢复到操作前状态。

## 命令

| 命令 | 作用 |
|---|---|
| `/undo` | 撤销最近一次文件写入/编辑 |
| `/undo list` | 查看所有已记录的操作历史（索引 + 时间 + 工具 + 文件路径） |
| `/undo <n>` | 撤销指定索引的操作 |
| `/undo prune [days]` | 清理 N 天前的快照（默认 7 天），只缩短可回退深度，不动任何当前文件 |

## 原理

每次 `write` / `edit` 执行前，插件自动保存文件操作前的内容到本地快照；`/undo` 时用快照内容覆盖回文件。

## 安装

### 方式一：本地构建（link）

1. 构建插件：

   ```sh
   pnpm install
   pnpm build
   ```

2. 在 profile 的 `package.json` 里加依赖：

   ```json
   "dependencies": {
     "dsh-file-undo": "link:<本目录绝对路径>"
   }
   ```

3. 在 profile 的 `cordis.patch.yml` 里挂载：

   ```yaml
   - insert:
       - id: file-undo
         name: 'dsh-file-undo'
   ```

4. 安装依赖并重启：

   ```sh
   cd ~/.dsh/profiles/web
   pnpm install
   dsh web
   ```

### 方式二：发布到 npm 后

```sh
dsh plugin --profile web add dsh-file-undo
```

## 快照存储

- 位置：`~/.dsh/file-undo/snapshots.jsonl`
- 插件每次加载自动按 7 天惰性清理一次
- 手动清理：`/undo prune [days]`（默认 7 天）
- `time` 字段缺失的快照条目会保守保留，不会被清理

## 限制

- 只覆盖 `write` / `edit` 两个工具；shell 里直接改文件（如 `Set-Content`、重定向）不覆盖
- 删除回退不支持（官方 fs 无 delete 方法）
- 快照全局共享，不按会话隔离

## 开发

```sh
pnpm typecheck        # 类型检查
pnpm build            # 构建
node verify-prune.mjs # 隔离验证清理逻辑（临时 HOME，不碰真实快照）
```
