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

# [permissions]
# allow_high_risk = false  # set true for non-interactive bash/MCP without session ask

# [mcp]
# unknown_source_fail_closed = false  # set true to skip Claude/Cursor user MCP auto-import

# [improve]
# capability_gate = false  # set true so bare xio improve requires trusted PASS before merge ask
# private_case = "last"    # optional; "last" or a 64-char case id (requires capability_gate)
`;
