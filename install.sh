#!/usr/bin/env bash
# XioCode one-line installer (installs the published npm package).
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/main/install.sh | bash
# Pin a version:
#   export XIO_INSTALL_VERSION=1.1.0
#   curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/main/install.sh | bash
# Bleed from GitHub (full source tree, not the slim npm payload):
#   export XIO_INSTALL_FROM=github
#   export XIO_INSTALL_REF=main   # or a tag / SHA
#   curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/main/install.sh | bash
set -euo pipefail

PKG="${XIO_INSTALL_PACKAGE:-@xioshark/xiocode}"
VERSION="${XIO_INSTALL_VERSION:-}"
FROM="${XIO_INSTALL_FROM:-npm}"   # npm | github
REPO="${XIO_INSTALL_REPO:-Xio-Shark/xiocode}"
REF="${XIO_INSTALL_REF:-main}"
NPM_REGISTRY="${XIO_INSTALL_REGISTRY:-https://registry.npmjs.org/}"
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

resolve_spec() {
  case "$FROM" in
    npm)
      if [[ -n "$VERSION" ]]; then
        printf '%s@%s' "$PKG" "$VERSION"
      else
        printf '%s' "$PKG"
      fi
      ;;
    github)
      printf 'github:%s#%s' "$REPO" "$REF"
      ;;
    *)
      fail "XIO_INSTALL_FROM must be 'npm' or 'github' (got: ${FROM})"
      ;;
  esac
}

say "XioCode installer"
need_cmd curl
need_cmd npm
need_cmd node

if ! node_ok; then
  fail "Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} required (found $(node -v 2>/dev/null || echo none)). Install from https://nodejs.org and retry."
fi

SPEC="$(resolve_spec)"
say "Source: ${FROM} → ${SPEC}"
say "Registry: ${NPM_REGISTRY}"

say "Installing globally with npm…"
# Force public registry so corporate npm_config_registry overrides don't break install.
env -u npm_config_registry npm install -g --registry "$NPM_REGISTRY" "$SPEC"

if ! command -v xio >/dev/null 2>&1; then
  fail "npm install finished but \`xio\` is not on PATH. Add your npm global bin to PATH (\`npm prefix -g\`)/bin and reopen the terminal."
fi

say "Preparing ~/.xiocode/config.toml (create only if missing)…"
xio init >/dev/null

say ""
say "Installed: $(command -v xio)"
say "Also available as: xiocode"
say "Version:  $(xio --version 2>/dev/null || echo unknown)"
say ""
say "Next:"
say "  1) export DEEPSEEK_API_KEY=sk-...   # or run /connect inside xio"
say "  2) cd /path/to/your-project"
say "  3) xio"
say ""
say "Docs: https://github.com/${REPO}#readme"
say "npm:  https://www.npmjs.com/package/${PKG}"
