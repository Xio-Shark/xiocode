#!/usr/bin/env bash
# XioCode one-line installer.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/main/install.sh | bash
# Pin a release tag:
#   export XIO_INSTALL_REF=v1.1.0
#   curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/${XIO_INSTALL_REF}/install.sh | bash
set -euo pipefail

REPO="${XIO_INSTALL_REPO:-Xio-Shark/xiocode}"
REF="${XIO_INSTALL_REF:-main}"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=6

say() { printf '%s\n' "$*"; }
fail() { printf 'xio install failed: %s\n' "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

node_ok() {
  local version major minor
  version="$(node -v 2>/dev/null | sed 's/^v//')"
  major="${version%%.*}"
  minor="$(printf '%s' "${version#*.}" | cut -d. -f1)"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  if (( major > MIN_NODE_MAJOR )); then return 0; fi
  if (( major == MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR )); then return 0; fi
  return 1
}

say "XioCode installer"
say "Repo: github:${REPO}#${REF}"
need_cmd curl
need_cmd npm
need_cmd node

if ! node_ok; then
  fail "Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} required (found $(node -v 2>/dev/null || echo none)). Install from https://nodejs.org and retry."
fi

say "Installing globally with npm…"
npm install -g "github:${REPO}#${REF}"

if ! command -v xio >/dev/null 2>&1; then
  fail "npm install finished but \`xio\` is not on PATH. Add your npm global bin to PATH (npm prefix -g)/bin and reopen the terminal."
fi

say "Preparing ~/.xiocode/config.toml (create only if missing)…"
xio init >/dev/null

say ""
say "Installed: $(command -v xio)"
say "Also available as: xiocode"
say ""
say "Next:"
say "  1) export DEEPSEEK_API_KEY=sk-...   # or edit ~/.xiocode/config.toml"
say "  2) cd /path/to/any-git-repo"
say "  3) xio"
say ""
say "Docs: https://github.com/${REPO}#readme"
