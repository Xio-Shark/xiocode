# XioCode — Claude Code 入口

@AGENTS.md

通用规则与按需附录以全局为准（勿在本仓库复制全文）：

- `~/.claude/AGENTS.md` — 全局 Agent 单源
- `~/.claude/AGENTS.trellis.md` — 含 `.trellis/` 时按需读
- `~/.claude/AGENTS.gitnexus.md` — 改代码前按需读

## 本仓库注意

- 独立仓库，**不要**执行上层 career 的 `knowledge_mcp` doctor / `platform/` / 强制 `rtk`
- GitNexus 仓库名是 **`xiocode`**，不是 `career`
- 浏览器：优先 Cursor IDE browser / Firecrawl；不要依赖已损坏的 GenericAgent MCP 路径
- 会话起手：`python3 ./.trellis/scripts/get_context.py`（非琐碎任务）
