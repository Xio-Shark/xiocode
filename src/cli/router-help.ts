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
    "Examples:",
    "  xio                               Start the interactive Ink TUI",
    "  xio \"explain this repo\"           Run a one-shot prompt",
    "  xio -p \"fix build\" --output-format stream-json",
    "                                    Emit NDJSON stream events",
    "  xio web                           Launch Web Console (http://127.0.0.1:3080)",
    "  xio resume                        Resume last session",
    "",
    "Usage:",
    "  xio [command] [options] [prompt]",
    "",
    "Getting Started:",
    "  xio                               Start the interactive Ink TUI",
    "  xio init                          Create ~/.xiocode/config.toml if missing; print recommended CLI tools",
    "  xio \"prompt\"                      Run a single prompt (same as -p)",
    "  xio -p \"prompt\"                   Run a single prompt non-interactively",
    "",
    "Sessions:",
    "  xio resume                        Resume the most recent session for this repository",
    "  xio resume <id>                   Resume a specific session",
    "  xio resume --list                 Choose from saved sessions",
    "  xio resume --delete <id>          Delete a saved session",
    "  xio --continue                    Resume the most recent session",
    "",
    "Web Console:",
    "  xio web                           Launch the Web Console (default: http://127.0.0.1:3080)",
    "",
    "Diagnostics & System:",
    "  xio doctor                        Self-check: Node / config / keys / provider connectivity (--offline skips probes)",
    "  xio feedback                      Report a bug / request a feature (--bug, --feature, --no-open)",
    "  xio models                        List known provider/model ids (no worktree session)",
    "  xio kernel                        Kernel runtime inspect / doctor / process supervisor status",
    "",
    "Options:",
    "  -p, --prompt <prompt>             Run a single prompt non-interactively",
    "  --output-format <format>          Output format: text | stream-json (NDJSON RuntimeEvent.v1)",
    "  --continue                        Resume the most recent session",
    "  --xio-fast                        Skip evolve/sandbox extensions",
    "  --allow-dirty                     Allow worktree session when main tree is dirty",
    "  --allow-high-risk                 Allow high risk operations",
    "  -v, --version                     Show version number",
    "  -h, --help                        Show help",
    "",
    "Notes:",
    "  Default workspace: the directory you launch from (no worktree sandbox).",
    "  Opt-in sandbox: set [worktree] enabled = true (requires git; uses ~/.xiocode/worktrees).",
    "  With worktree on, dirty main trees are refused unless --allow-dirty or [worktree] allow_dirty = true.",
    "  Merge with /merge, or answer the prompt when the session ends (worktree mode only).",
    "  MCP servers connect in the background after the prompt is ready.",
    "  Permission modes: /permission auto|full|strict (Shift+Tab cycles; default auto).",
    "",
  ].join("\n");
}
