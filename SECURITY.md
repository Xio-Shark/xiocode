# Security Policy

## Supported versions

The latest published release receives security fixes. Older minors are not maintained.

## Reporting a vulnerability

Prefer GitHub's private channel: **Security → Report a vulnerability** on <https://github.com/Xio-Shark/xiocode>. If that is not possible, the maintainer's address is listed in [.github/ISSUE_TEMPLATE/config.yml](./.github/ISSUE_TEMPLATE/config.yml).

Please do not open a public issue for an unfixed vulnerability, and do not include working exploit payloads in public threads before a fix exists.

Useful details: XioCode version (`xio --version`), Node version, OS, the provider in use, the exact command or tool call, and what you expected versus observed. `xio doctor` output helps and contains no API keys.

## What is in scope

- **Sandbox and guardrail bypass**: a command or file mutation that the tool guardrails claim to block actually running without approval; workspace path policy escapes (`read` / `write` / `grep` / `glob` leaving the project root through symlinks or relative paths).
- **Secret handling**: API keys or credentials ending up in logs, transcripts, session files, spill artifacts, or child environments; secrets being sent anywhere other than the provider endpoint the user configured.
- **Prompt-injection to execution**: content read from a repository, webpage, or MCP tool causing unapproved command execution or file writes.
- **Session and rollback integrity**: session records or rollback checkpoints being rewritten, forged, or replayed in a way that silently loses user data.
- **Extension / MCP trust**: an extension or MCP server gaining capabilities beyond what the user granted.
- **Process layer**: a supervised command reported as stopped while it still runs; a command escaping its process group unnoticed; the experimental kernel path (`XIOCODE_PROCESS_KERNEL=1`) releasing a lease before a stop is confirmed.

## What is not a vulnerability here

- A model giving wrong or unsafe *advice*.
- Cost or token accounting being surprising, unless it is provably wrong.
- Anything that requires the user to explicitly approve a destructive command, when it does exactly what the approval said.
- Windows behaviour of the experimental kernel process layer: that path is unsupported on Windows and says so.

This is a spare-time project with no bug bounty and no guaranteed response time.
