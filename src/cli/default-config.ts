/**
 * Default ~/.xiocode/config.toml written on first run / `xio init`.
 * Providers read API keys from env — never embed secrets here.
 *
 * Minimal by design: general + providers only. Optional sections (worktree /
 * explore / permissions / tools / trust / mcp / improve / regress / agent /
 * context / retrospective) live in extensions/xio-setup and are appended on
 * demand via `xio-setup`.
 */
export const DEFAULT_CONFIG_TOML = `# XioCode local config — edit providers to match your API keys.
# Docs: https://github.com/Xio-Shark/xiocode
#
# Minimal by design. Optional sections (worktree / explore / permissions / tools /
# trust / mcp / improve / regress / agent / context / retrospective) are managed
# by the companion CLI: run \`xio-setup list\`, then \`xio-setup add <section>\`.

[general]
default_provider = "deepseek"
default_model = "deepseek-chat"
# default_thinking_level = "medium"  # off|minimal|low|medium|high|xhigh|max|ultra — UI ladder
# max_session_messages = 80  # auto-compact before the next prompt would exceed this message budget
# max_session_tokens = 48000 # optional token-aware compact budget; else ~75% of model context_window
# max_turns = 24             # per-prompt agent↔model turns (1–40; default 24)
# repeat_tool_limit = 3      # block identical tool+args after N in a row; 0 = off

[providers.deepseek]
kind = "openai"
base_url = "https://api.deepseek.com"
model = "deepseek-chat"
api_key_env = "DEEPSEEK_API_KEY"
# Optional explicit wire map (defaults already map max/ultra → "max" for deepseek* ids):
# [providers.deepseek.thinking_level_map]
# high = "high"
# max = "max"
# ultra = "max"

# More providers: run /connect inside a session, or uncomment:
# [providers.openai]
# kind = "openai"
# base_url = "https://api.openai.com/v1"
# model = "gpt-4.1"
# api_key_env = "OPENAI_API_KEY"
`;
