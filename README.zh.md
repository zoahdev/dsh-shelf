# dsh-shelf

> DeepSeek Harness 的会话生命周期管理：**导出、归档、恢复、回收站、搜索、统计**。零依赖，默认只读。

每个 dsh 用户都会攒下几百个会话，却没有任何管理手段（#1990、#1991）。dsh-shelf 就是缺的那层书架。

## 快速开始

```sh
npx dsh-shelf list                          # 列出全部会话（id + 路径）
npx dsh-shelf stats                         # 数量、压缩/明文、体积
npx dsh-shelf search "parser bug"           # 头 + 正文搜索（明文会话）
npx dsh-shelf export <id> --format md       # 导出 Markdown 对话记录
npx dsh-shelf export --all --format jsonl --out all-sessions.jsonl
npx dsh-shelf archive <id>                  # 移入 sessions-archive（绝不删除）
npx dsh-shelf restore <id>                  # 移回来
npx dsh-shelf trash <id>                    # 移入回收站（可恢复）
npx dsh-shelf restore-trash <id>
npx dsh-shelf report                        # 周报 digest（Markdown）
npx dsh-shelf report 30 --format json       # 30 天 digest（JSON）
npx dsh-shelf report 14 --format html --out shelf-report.html   # 离线看板
npx dsh-shelf archive-old 30                # 预演：30 天前的会话
npx dsh-shelf verify                        # 会话健康检查（孤儿 tool call/未完成/空文件）
npx dsh-shelf rescue <id>                   # 抢救不可恢复会话的内容
npx dsh-shelf archive-old 30 --yes          # 移入 sessions-archive
npx dsh-shelf tree                          # 会话 fork 谱系
npx dsh-shelf tree <id>                     # 消息树（pi /tree）
npx dsh-shelf web                           # 本地 Web 面板 http://127.0.0.1:4174
```

DSH 插件模式（面板绑定当前 profile）：

```sh
dsh plugin --profile web add github:zoahdev/dsh-shelf
# 面板 http://127.0.0.1:4174（lib/ 已提交，安装免构建）
```

根目录：`--root` 指定；默认 `$DSH_SESSIONS` 或 `~/.dsh/sessions`。归档/回收站默认在根目录旁 `sessions-archive` / `sessions-trash`。

## 消息导航（`/tree`）

[pi](https://github.com/earendil-works/pi) `/tree`（连按 Esc）的精简移植。DSH 的分支存在于会话之间（`parentSession` + `seedLength`），所以树是从 fork 谱系重建的，不是文件内 entry 图。标签、折叠、分支摘要没有抄过来。

过滤（默认 `no-tool`；面板里按 `o` 循环，或 `--filter` / `/nav user`）：`no-tool`（用户 + 助手正文）、`user`、`all`（含 tool call）。

| 入口 | 用法 |
| --- | --- |
| CLI | `dsh-shelf tree`（会话谱系）/ `dsh-shelf tree <id>`（消息） |
| Web 面板 | **连按 Esc** 或 Tree 按钮。↑/↓ 移动，Enter 预览/打开，Esc 关闭 |
| 宿主插件 | `/nav` 选一条消息，在该轮次边界 fork |

选用户消息会 fork 到上一轮结束（方便改写重发）；选助手消息会 fork 到该轮结束（从这里继续）。命令只打印 `/resume` 提示，不会切换 TUI。

## 安全模型

- 列表、统计、导出、搜索**严格只读**；
- 归档/回收站是**移动**会话目录，引擎从不删除任何东西；
- 导出不碰源文件；
- Zstandard 压缩会话会被识别并提示（v0.1 支持明文导出，raw jsonl 保留）。

## 为什么这是蓝海

- 官方讨论 #1990（无法删除会话）、#1991（存档会话无法查看/恢复）都是无人接的 feature request；
- session 类插件有 229 个——记忆、召回、进化——但几乎没人做**生命周期**；
- dsh-shelf 是安全、可脚本化的第一步：先做导出/归档/回收站/搜索，再上 Web UI。

## Roadmap

- [x] list / stats / export（md/json/jsonl）/ archive / restore / trash / search
- [x] 周报 digest（report）+ 自动归档（archive-old，默认预演）
- [x] 本地 Web 面板（dsh-shelf web）——浏览器里列表/搜索/导出/归档/回收站 + 每日图表
- [x] 离线 HTML 看板（report --format html）——可分享的每日柱状图 + 最大会话
- [x] 中文搜索（CJK bigram 分词，零依赖；对齐 #1999）
- [x] DSH 插件包装（`dsh plugin add github:zoahdev/dsh-shelf` 打开面板）

- [x] 会话健康检查（verify）+ 不可恢复会话抢救导出（#1959/#2034 家族）
- [ ] FTS5 搜索（宿主提供 SQLite FTS5 时）
- [x] Zstandard 导出（Node ≥ 22.19 node:zlib 解码）
- [x] 消息导航（`tree`、Web 面板连按 Esc、宿主 `/nav`）—— pi `/tree` 精简移植

## License

MIT
