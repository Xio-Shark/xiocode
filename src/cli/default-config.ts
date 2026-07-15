/**
 * Default ~/.xiocode/config.toml written on first run / `xio init`.
 * Providers read API keys from env — never embed secrets here.
 */
export const DEFAULT_CONFIG_TOML = `# XioCode local config — edit providers to match your API keys.
# Docs: https://github.com/Xio-Shark/xiocode

[general]
default_provider = "deepseek"
default_model = "deepseek-chat"
# max_session_messages = 80  # auto-compact before the next prompt would exceed this message budget
# default_thinking_level = "medium"  # off|minimal|low|medium|high|xhigh|max|ultra
# max_turns = 24                 # per-prompt agent↔model turns (1–40; default 24)
# repeat_tool_limit = 3          # block identical tool+args after N in a row; 0 = off
#
# Host search tools (optional — never required):
#   grep order: ugrep → rg → grep → node
#   glob order: ugrep → rg → bfs → find → node
# Recommended: brew install ugrep ripgrep bfs

[providers.deepseek]
kind = "openai"
base_url = "https://api.deepseek.com"
model = "deepseek-chat"
api_key_env = "DEEPSEEK_API_KEY"

# Optional OpenAI-compatible example (uncomment to use):
# [providers.openai]
# kind = "openai"
# base_url = "https://api.openai.com/v1"
# model = "gpt-4.1"
# api_key_env = "OPENAI_API_KEY"
#
# [general]
# default_provider = "openai"
# default_model = "gpt-4.1"

[worktree]
enabled = true
retain_on_reject = false

# Multi-explore: primary model keeps the session; Flash (or other) workers survey tiny slices.
# Enable and set explore.model (same provider or provider/model). Primary should be the stronger model.
# max_concurrency is a hard cap 1–16 (default 4). Runtime suggests fewer/more by project scale within the cap.
# Optional partition_hint tells the primary how you want slices chosen (API / feature / package / …).
# [explore]
# enabled = true
# model = "deepseek-v4-flash"       # or "opencode-go/deepseek-v4-flash"
# # provider = "opencode-go"        # optional when model has no provider prefix
# max_turns = 12
# max_concurrency = 4
# max_output_chars = 64000          # verbatim file excerpts back to primary; raise if reports truncate
# # partition_hint = "按 API 边界拆成小片；用户另有说明时以用户为准"
# timeout_ms = 180000
# allow_bash = false                # keep false: workers stay read/grep/glob only

# [permissions]
# allow_high_risk = false  # set true for non-interactive bash/MCP without session ask

# [mcp]
# unknown_source_fail_closed = false  # set true to skip Claude/Cursor user MCP auto-import

# [improve]
# capability_gate = false  # set true so bare xio improve requires trusted PASS before merge ask
# private_case = "last"    # optional; "last" or a 64-char case id (requires capability_gate)

# Post-task retrospective: after each full agent task, extract blockers → log → washed report.
# Report injects into the next turn for the primary agent; optional improve-queue goals for xio improve.
# [retrospective]
# enabled = true
# skip_trivial = true
# min_tool_calls = 1
# auto_inject = true
# enqueue_improve = true
# use_llm = false          # reserved; deterministic wash always runs
`;
