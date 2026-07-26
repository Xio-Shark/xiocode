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
  command -v node >/dev/null 2>&1 || return 1
  local version major minor
  version="$(node -v 2>/dev/null | sed 's/^v//')"
  major="${version%%.*}"
  minor="$(printf '%s' "${version#*.}" | cut -d. -f1)"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  if (( major > MIN_NODE_MAJOR )); then return 0; fi
  if (( major == MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR )); then return 0; fi
  return 1
}

# Print the one-line Node install command for this platform.
node_hint() {
  local os
  os="$(uname -s 2>/dev/null || echo unknown)"
  case "$os" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        say "  brew install node@22 && brew link --overwrite node@22"
      else
        say "  curl -fsSL https://fnm.vercel.app/install | bash   # then: fnm install 22 && fnm use 22"
      fi
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        say "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
      elif command -v dnf >/dev/null 2>&1; then
        say "  sudo dnf module install -y nodejs:22"
      elif command -v pacman >/dev/null 2>&1; then
        say "  sudo pacman -S nodejs npm"
      elif command -v apk >/dev/null 2>&1; then
        say "  sudo apk add nodejs npm"
      else
        say "  curl -fsSL https://fnm.vercel.app/install | bash   # then: fnm install 22 && fnm use 22"
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*)
      say "  Windows is untested — please use WSL: https://learn.microsoft.com/windows/wsl/install"
      ;;
    *)
      say "  Install Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ from https://nodejs.org"
      ;;
  esac
}

# Opt-in automated Node install via fnm (XIO_INSTALL_NODE=1).
install_node_via_fnm() {
  say "Installing Node.js ${MIN_NODE_MAJOR} via fnm…"
  if ! command -v fnm >/dev/null 2>&1; then
    curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell
    export PATH="${HOME}/.local/share/fnm:${HOME}/.fnm:${PATH}"
  fi
  command -v fnm >/dev/null 2>&1 || fail "fnm bootstrap failed; install Node manually (see hint above)"
  fnm install "${MIN_NODE_MAJOR}"
  eval "$(fnm env)"
  fnm use "${MIN_NODE_MAJOR}"
  node_ok || fail "fnm installed Node but the active version is still too old; open a new shell and retry"
  say "Note: add 'eval \"\$(fnm env --use-on-cd)\"' to your shell rc so this Node persists."
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

if ! node_ok; then
  if [[ "${XIO_INSTALL_NODE:-}" == "1" ]]; then
    install_node_via_fnm
  else
    say ""
    say "Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} required (found: $(node -v 2>/dev/null || echo none))."
    say "Install it with:"
    node_hint
    say ""
    say "Or let this installer handle it via fnm:"
    say "  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | XIO_INSTALL_NODE=1 bash"
    fail "Node.js too old or missing"
  fi
fi

need_cmd npm

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
