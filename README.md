# dsh-file-undo

[简体中文](README.md) | [English](README_EN.md)

DSH 插件：撤销 agent 对文件的 **`write` / `edit`** 操作。每一次文件改动落盘前自动进时间线，侧栏面板红绿 diff 逐条审查，两阶段撤销 + 重做双向循环，多会话自动跟随。当前版本 **0.2.0**。

## 可视化面板

侧栏底部「撤销」图标（带未撤销计数徽章）→ 审查面板：

- **历史列表**：时间、工具徽章（write / edit / create）、文件名、`+恢复 / −移除` 行数、轮次徽章（该操作发生在模型的第几轮）；失败的调用同样留痕
- **撤销视角红绿 diff**：绿行 = 撤销将恢复的内容，红行 = 撤销将移除的当前内容，hunk 头 + 双行号，超长截断（800 行后「显示全部」）
- **自动预检**：打开条目即执行，能否安全撤销逐条给原因（见「安全模型」）
- **两阶段确认**：第一次点击武装按钮（3 秒自动解除），再点才真正执行
- **会话切换器**：列出同一项目树（当前目录及其父子目录）下的全部会话（平台标题 + 活跃/存档状态），选中即钉住；默认自动跟随当前查看的会话

## 安全模型（两阶段 + 事务 + 乐观并发）

| 阶段 | 行为 |
|---|---|
| 预检 preview | 只读分类，逐条给原因：`file_creation`（创建类撤销 = 删除文件，内容/hash 双闸 + 确认）/ `external_modified`（快照后文件被手动改过，拒绝吞掉手工编辑）/ `superseded_by_later_ops`（其后还有 N 条自己的编辑，引导「回退到此状态」）/ `already_reverted` / `file_missing` / `stale` 等 |
| 提交 apply | 携带预检时的 `expectedCurrentHash` 乐观锁——文件在预览后又变化则拒绝（`stale`）；通过后整文件写回 before 全文，成功标记 `reverted` |
| 回退 RewindTo | 选中任意历史条目单次原子写回，链条咬合校验 + 明示将丢弃的后续步数，其后条目批量标记 cascade |
| 级联恢复 | 重新应用上游条目时整批复活被连带作废的行（确认框明示「连带恢复 N 条」），撤销/重做双向幂等 |

聊天里的 `/undo` 不做 `external_modified` 拦截（保留强制语义）。

## 会话跟随

面板自动跟随当前查看的会话：client 半订阅 `betterSidebar` 服务（主源）与 `sessions.list`（兜底），会话切换后面板所有请求携带该会话标识；host 侧逐请求过平台会话目录核验，cwd 一律从平台读取——伪造的会话 id 一律 404 `unknown-session`。两源全缺席（headless 等）时静默降级为旧有行为。

## 命令

| 命令 | 作用 |
|---|---|
| `/undo` | 撤销最近一次文件写入/编辑 |
| `/undo list` | 查看当前会话已记录的操作历史 |
| `/undo <n>` | 撤销指定索引的操作 |
| `/undo sessions` | 列出同项目树会话（与面板切换器同一条 API） |
| `/undo prune [days]` | 清理 N 天前的快照（默认 7），只缩回退深度，不动当前文件 |
| `/undo git [n]` | 从 git 归档恢复第 n 个快照（0 = 最新） |
| `/undo git-status` | git 归档健康状态 |

## 原理

1. **全文快照，不存反向补丁**：`tools/pre-execute` 在 write/edit 落盘前捕获 before 全文；`tools/post-execute` 回填 after 全文 + sha256（外部修改检测的期望哈希）。diff 渲染现场计算，撤销整文件写回，两者解耦。
2. **diff 计算与渲染分离**：host 侧行级 LCS（前缀/后缀裁剪 + 整数行 ID + Uint32 DP，超大中段降级为整块替换）产出 hunk；客户端按行首字符分类 + 纯 CSS 上色（与主题令牌混色）。
3. **引擎裁决、UI 只展示**：能否动文件全部在 host 侧判定（预检分类 + 事务 + 乐观锁），客户端只渲染分类结果。
4. **状态机闭环**：`recorded → reverted → reapplied`，重做后可再撤销。
5. **相对路径按会话解析**：工具的 `file_path` 相对会话工作区，捕获时用会话 cwd 作为解析基准并存稳定标识复用。
6. **HTTP API**：`POST /file-undo/api/*`（context / history / detail / preview / apply / reapply / rewind 等），带 Host 头信任围栏（loopback / trustedHosts + sec-fetch-site + Origin 校验）。

## 快照存储

```text
~/.dsh/file-undo/
  <workspace-key>/          # 由会话 cwd 规范化派生（消毒 + 8 位哈希后缀防撞）
    <chat-key>/             # 会话 id
      snapshots.jsonl       # append-only，单飞写锁 + 原子改名
      git-archive/          # 第二层归档：每条快照一个 commit，静默降级
```

- 同一目录无论 `D:\proj` / `d:/proj/` 哪种写法，恒为同一个键（路径规范化后派生，存量目录零迁移）
- 插件加载时按 7 天惰性清理；`/undo prune` 手动清理，`time` 缺失的条目保守保留

## 安装

### 方式一：本地构建（link）

```sh
git clone https://github.com/QinLuza/dsh-file-undo.git
cd dsh-file-undo && pnpm install && pnpm build
```

在 profile 的 `package.json` 里加依赖：

```json
"dsh-file-undo": "link:<本目录绝对路径>"
```

在 profile 目录执行 `pnpm install`，重启 DSH 生效。之后的纯 client 半改动只需浏览器硬刷新。

### 方式二：npm（发布后）

```sh
dsh plugin --profile web add dsh-file-undo
```

## 限制

- 只覆盖 `write` / `edit` 两个工具；shell 里直接改文件（如 `Set-Content`、重定向）不进时间线
- 「回退到此状态」丢弃其后的改动（预检明示数量），不做旧基线重放
- 面板与自动跟随需要 web 界面；headless 下聊天命令仍可用（会话缝缺席时自动降级）

## 开发

```sh
pnpm typecheck
pnpm build
node verify-prune.mjs    # 清理逻辑隔离验证（临时 HOME，不碰真实快照）
node verify-rewind.mjs   # 回退语义回归
node smoke-test.mjs      # 冒烟测试
node verify-follow.mjs   # 会话跟随数据源回归
```

## License

MIT
