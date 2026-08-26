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
    "  xio web             Launch the modern Web Console (default: http://127.0.0.1:3080)",
    "  xio init            Create ~/.xiocode/config.toml if missing; print recommended CLI tools",
    "  xio \"prompt\"        Run a single prompt (same as -p)",
    "  xio -p \"prompt\"     Run a single prompt",
    "  xio -p \"prompt\" --output-format stream-json",
    "                      NDJSON RuntimeEvent.v1 on stdout (diagnostics on stderr)",
    "  xio resume          Resume the most recent session for this repository",
    "  xio resume <id>     Resume a specific session",
    "  xio resume --list   Choose from saved sessions",
    "  xio resume --delete <id>  Delete a saved session",
    "  xio --continue      Resume the most recent session",
    "  xio doctor          Self-check: Node / config / keys / provider connectivity (--offline skips probes)",
    "  xio feedback        Report a bug / request a feature (--bug, --feature, --no-open)",
    "  xio models          List known provider/model ids (no worktree session)",
    "  xiocode             Same as xio (alias)",
    "  xio --xio-fast      Skip evolve/sandbox extensions",
    "  xio --allow-dirty   Allow worktree session when main tree is dirty",
    "  xio --version",
    "  xio --help",
    "",
    "Experimental (not part of the supported product surface):",
    "  xio improve | xio eval | xio regress | xio bench",
    "",
    "Install once: curl -fsSL https://raw.githubusercontent.com/Xio-Shark/xiocode/main/install.sh | bash",
    "Then run xio / xiocode from any directory (git optional).",
    "Default workspace: the directory you launch from (no worktree sandbox).",
    "Opt-in sandbox: set [worktree] enabled = true (requires git; uses ~/.xiocode/worktrees).",
    "With worktree on, dirty main trees are refused unless --allow-dirty or [worktree] allow_dirty = true.",
    "Merge with /merge, or answer the prompt when the session ends (worktree mode only).",
    "MCP servers connect in the background after the prompt is ready.",
    "Permission modes: /permission auto|full|strict (Shift+Tab cycles; default auto).",
    "",
  ].join("\n");
}
