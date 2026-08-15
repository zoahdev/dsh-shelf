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
```

根目录：`--root` 指定；默认 `$DSH_SESSIONS` 或 `~/.dsh/sessions`。归档/回收站默认在根目录旁 `sessions-archive` / `sessions-trash`。

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
- [ ] Web UI 插件（设置页管理会话）
- [ ] FTS5 中文分词搜索（对齐 #1999）
- [ ] Zstandard 导出（zstd 解码）
- [ ] 定时自动归档 N 天前的会话

## License

MIT
