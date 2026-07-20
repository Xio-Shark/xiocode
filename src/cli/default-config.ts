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
# max_session_tokens = 48000 # optional token-aware compact budget; else ~75% of model context_window
# default_thinking_level = "medium"  # off|minimal|low|medium|high|xhigh|max|ultra — UI ladder
# max/ultra stay product levels: deepseek* models wire them as reasoning_effort=max;
# other OpenAI-compat models wire them as xhigh. Override with providers.*.thinking_level_map.
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
# Optional explicit wire map (defaults already map max/ultra → "max" for deepseek* ids):
# [providers.deepseek.thinking_level_map]
# high = "high"
# max = "max"
# ultra = "max"

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

# Outer worktree sandbox is opt-in. Default: run in the launch directory (git optional).
[worktree]
enabled = false
retain_on_reject = false
# allow_dirty = true   # only matters when enabled = true

# Multi-explore: primary model keeps the session; cheaper workers survey tiny slices.
# thinking=ultra AUTO-ENABLES explore even when enabled=false (uses explore.model or the session model).
# For non-ultra sessions, set enabled=true + model to opt in.
# max_concurrency is the absolute ceiling 1–16 (default 16). Adaptive lanes (live):
#   - fast (0): simple/single-file — do not spawn unless user asks or uncertainty remains
#   - standard (2–4): default multi-file exploration when enabled
#   - deep (4–8): ultra / high uncertainty raises the ceiling (does not force spawn on trivial tasks)
#   - explicit_high (≤16): only when the user clearly requests high fan-out
# Wave budgets (soft; 0 = unlimited): max_tokens / max_cost_usd / max_starts_per_minute.
# Optional partition_hint tells the primary how you want slices chosen (API / feature / package / …).
# [explore]
# enabled = false                  # ultra still auto-enables; set true for explore at any effort
# model = "deepseek-v4-flash"       # or "opencode-go/deepseek-v4-flash"; fallback = session primary
# # provider = "opencode-go"        # optional when model has no provider prefix
# max_turns = 12
# max_concurrency = 16
# max_output_chars = 64000          # verbatim file excerpts back to primary; raise if reports truncate
# max_tokens = 250000               # soft wave token budget; 0 = unlimited
# max_cost_usd = 1                  # soft USD estimate across workers; 0 = unlimited
# max_starts_per_minute = 24        # provider-rate: worker starts / rolling minute; 0 = unlimited
# # partition_hint = "按 API 边界拆成小片；用户另有说明时以用户为准"
# timeout_ms = 180000
# allow_bash = false                # keep false: workers stay read/grep/glob only

# [permissions]
# allow_high_risk = false  # set true for non-interactive bash/MCP without session ask

# [tools]
# require_read_before_edit = true  # set false to allow edit/overwrite without a prior read

# [mcp]
# unknown_source_fail_closed = false  # set true to skip Claude/Cursor user MCP auto-import
# # read_cursor = true               # auto-loads ~/.cursor/mcp.json (broken command paths will warn)
# # timeout_ms = 30000               # per-server connect/listTools; close force-kills stdio after ~1.5s

# [improve]
# capability_gate = false  # set true so bare xio improve requires trusted PASS before merge ask
# private_case = "last"    # optional; "last" or a 64-char case id (requires capability_gate)

# Failure-signal capture offer (rollback / hard steer / turn failed). Verdict stays human.
# [regress]
# offer_on_failure = true  # set false to silence offers; /regress manual path unchanged

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
