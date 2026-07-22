/**
 * Copy text to the system clipboard from a fullscreen TUI.
 *
 * Strategy (Grok-style multi-leg, simplified):
 * 1. OSC 52 escape sequence (works in many modern terminals, including over SSH)
 * 2. Platform CLI fallback: pbcopy (macOS) / wl-copy or xclip (Linux) / clip (Windows)
 */

import { spawnSync } from "node:child_process";

export type ClipboardResult = Readonly<{
  ok: boolean;
  via: readonly string[];
}>;

/** Encode OSC 52 clipboard set (`OSC 52 ; c ; <base64> BEL`). */
export function encodeOsc52Clipboard(text: string): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  return `\x1b]52;c;${b64}\x07`;
}

function tryWriteOsc52(text: string, stdout: NodeJS.WriteStream): boolean {
  if (!stdout.isTTY) return false;
  try {
    stdout.write(encodeOsc52Clipboard(text));
    return true;
  } catch {
    return false;
  }
}

function trySpawnCopy(command: string, args: readonly string[], text: string): boolean {
  try {
    const result = spawnSync(command, [...args], {
      input: text,
      encoding: "utf8",
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 2_000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function tryPlatformClipboard(text: string): boolean {
  if (process.platform === "darwin") {
    return trySpawnCopy("pbcopy", [], text);
  }
  if (process.platform === "win32") {
    return trySpawnCopy("clip", [], text);
  }
  // Linux: prefer wl-copy, then xclip CLIPBOARD.
  if (trySpawnCopy("wl-copy", [], text)) return true;
  return trySpawnCopy("xclip", ["-selection", "clipboard"], text);
}

/** Copy `text` via OSC 52 and/or platform clipboard tools. */
export function copyTextToClipboard(
  text: string,
  stdout: NodeJS.WriteStream = process.stdout,
): ClipboardResult {
  if (text.length === 0) return { ok: false, via: [] };
  const via: string[] = [];
  if (tryWriteOsc52(text, stdout)) via.push("osc52");
  if (tryPlatformClipboard(text)) via.push("native");
  return { ok: via.length > 0, via };
}
