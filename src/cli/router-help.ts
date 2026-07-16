import { XIO_VERSION } from "./version.ts";

/** Shared --version / --help handling with no session/launch imports. */
export function handleXioFlag(args: readonly string[], write: (chunk: string) => void): boolean {
  if (args.length !== 1) {
    return false;
  }
  const [flag] = args;
  if (flag === "--version" || flag === "-v") {
    write(`XioCode ${XIO_VERSION}\n`);
    return true;
  }
  if (flag === "--help" || flag === "-h") {
    write(xioHelp());
    return true;
  }
  return false;
}

export function xioHelp(): string {
  return [
    "XioCode - local-first coding agent",
    `Version: ${XIO_VERSION}`,
    "Config: ~/.xiocode/config.toml",
    "",
    "Usage:",
    "  xio                 Start the interactive Ink TUI",
    "  xio init            Create ~/.xiocode/config.toml if missing; print recommended CLI tools",
    "  xio -p \"prompt\"     Run a single prompt",
    "  xio -p \"prompt\" --output-format stream-json",
    "                      NDJSON RuntimeEvent.v1 on stdout (diagnostics on stderr)",
    "  xio resume          Resume the most recent session for this repository",
    "  xio resume <id>     Resume a specific session",
    "  xio resume --list   Choose from saved sessions",
    "  xio resume --delete <id>  Delete a saved session",
    "  xio --continue      Resume the most recent session",
    "  xio improve         Self-improve loop (worktree + verifier + merge ask)",
    "  xio eval            Trusted capability preflight/smoke/compare",
    "  xio regress         Capture / preflight / compare private regressions",
    "  xio bench           Performance baseline fixtures (P50/P95 local report)",
    "  xio models          List known provider/model ids (no worktree session)",
    "  xiocode             Same as xio (alias)",
    "  xio --xio-fast      Skip evolve/sandbox extensions",
    "  xio --allow-dirty   Allow worktree session when main tree is dirty",
    "  xio --version",
    "  xio --help",
    "",
    "Install once: curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/main/install.sh | bash",
    "Then run xio / xiocode from any directory (git optional).",
    "Default workspace: the directory you launch from (no worktree sandbox).",
    "Opt-in sandbox: set [worktree] enabled = true (requires git; uses ~/.xiocode/worktrees).",
    "With worktree on, dirty main trees are refused unless --allow-dirty or [worktree] allow_dirty = true.",
    "Merge with /merge, or answer the prompt when the session ends (worktree mode only).",
    "Self-improve never auto-merges on green verifier — MergeGate ask only.",
    "MCP servers connect in the background after the prompt is ready.",
    "Permission modes: /permission auto|full|strict (Shift+Tab cycles; default auto).",
    "",
  ].join("\n");
}
