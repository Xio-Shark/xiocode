/**
 * Terminal mouse-wheel support for Ink alternate-screen apps.
 *
 * Inspired by pi-tui StdinBuffer (earendil-works/pi): mouse SGR sequences can
 * arrive in partial chunks; incomplete escapes must not be treated as keypresses.
 * Ink has no built-in wheel events — we enable SGR tracking and strip sequences
 * from the shared stdin stream so they never leak into the prompt editor.
 *
 * Button codes (SGR): 64 = wheel up, 65 = wheel down (68/69 with modifiers).
 */

const ENABLE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1007h";
const DISABLE = "\x1b[?1007l\x1b[?1006l\x1b[?1002l\x1b[?1000l";

/** Complete SGR mouse: optional ESC + `[<btn;x;yM|m` */
const SGR_MOUSE_COMPLETE_RE = /(?:\x1b)?\[<\d+(?:;\d+)*[Mm]/g;

/** Incomplete SGR mouse tail held across chunks. */
const SGR_MOUSE_PARTIAL_TAIL_RE = /(?:\x1b)?\[<\d*(?:;\d*)*$/;

export type MouseScrollDirection = "up" | "down";

export type MouseScrollHandler = (direction: MouseScrollDirection, steps: number) => void;

export function enableTerminalMouseTracking(stdout: NodeJS.WriteStream = process.stdout): void {
  if (!stdout.isTTY) return;
  try {
    stdout.write(ENABLE);
  } catch {
    // ignore write failures (piped / closed)
  }
}

export function disableTerminalMouseTracking(stdout: NodeJS.WriteStream = process.stdout): void {
  if (!stdout.isTTY) return;
  try {
    stdout.write(DISABLE);
  } catch {
    // ignore
  }
}

/**
 * Strip mouse SGR sequences (and incomplete tails) from text that might have
 * leaked into the prompt after ESC was consumed by the key parser.
 */
export function stripMouseLeak(text: string): string {
  if (text.length === 0) return text;
  let out = text.replace(SGR_MOUSE_COMPLETE_RE, "");
  out = out.replace(SGR_MOUSE_PARTIAL_TAIL_RE, "");
  return out;
}

/** True when the chunk is only mouse SGR (full or residual without ESC). */
export function isMouseLeakChunk(text: string): boolean {
  if (text.length === 0) return false;
  return stripMouseLeak(text).length === 0;
}

/**
 * Parse one stdin chunk for wheel events.
 * Returns whether any complete mouse sequence was found.
 */
export function consumeMouseScrollChunk(
  chunk: string,
  onScroll: MouseScrollHandler,
): boolean {
  let matched = false;
  const re = /(?:\x1b)?\[<(\d+);\d+;\d+[Mm]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(chunk)) !== null) {
    matched = true;
    const button = Number(match[1]);
    // 64/65 plain wheel; 68/69 with modifiers on some terminals
    if (button === 64 || button === 68) {
      onScroll("up", 3);
    } else if (button === 65 || button === 69) {
      onScroll("down", 3);
    }
  }
  return matched;
}

/**
 * Attach wheel listener and filter mouse sequences out of stdin before Ink.
 *
 * Pi's StdinBuffer completes CSI before key handling. We patch `stdin.emit('data')`
 * so residual `[<64;…M` never reaches useInput / the prompt.
 */
export function attachMouseScrollListener(
  stdin: NodeJS.ReadStream,
  onScroll: MouseScrollHandler,
  stdout: NodeJS.WriteStream = process.stdout,
): () => void {
  enableTerminalMouseTracking(stdout);

  let pending = "";
  const originalEmit = stdin.emit.bind(stdin);

  function filteredEmit(event: string | symbol, ...args: unknown[]): boolean {
    if (event !== "data") {
      return originalEmit(event, ...args);
    }

    const raw = args[0];
    const text = typeof raw === "string"
      ? raw
      : Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : "";
    if (text.length === 0) {
      return originalEmit(event, ...args);
    }

    const combined = pending + text;
    const { complete, forward, hold } = partitionMouseInput(combined);
    pending = hold;

    if (complete.length > 0) {
      consumeMouseScrollChunk(complete, onScroll);
    }

    if (forward.length === 0) {
      return false;
    }
    return originalEmit(event, forward, ...args.slice(1));
  }

  stdin.emit = filteredEmit as typeof stdin.emit;

  return () => {
    stdin.emit = originalEmit as typeof stdin.emit;
    pending = "";
    disableTerminalMouseTracking(stdout);
  };
}

/**
 * Partition a stdin buffer into:
 * - complete: full mouse sequences (for scroll handling)
 * - forward: non-mouse text safe for Ink
 * - hold: incomplete mouse/CSI prefix kept for the next chunk
 */
export function partitionMouseInput(buffer: string): Readonly<{
  complete: string;
  forward: string;
  hold: string;
}> {
  const completeParts: string[] = [];
  let cursor = 0;
  const re = /(?:\x1b)?\[<\d+(?:;\d+)*[Mm]/g;
  let match: RegExpExecArray | null;
  let forward = "";

  while ((match = re.exec(buffer)) !== null) {
    if (match.index > cursor) {
      forward += buffer.slice(cursor, match.index);
    }
    completeParts.push(match[0]!);
    cursor = match.index + match[0]!.length;
  }
  const tail = buffer.slice(cursor);

  // Hold incomplete mouse / ESC CSI prefix so Ink never sees partials.
  const partial = tail.match(SGR_MOUSE_PARTIAL_TAIL_RE);
  if (partial && partial.index !== undefined && partial[0].length > 0) {
    const before = tail.slice(0, partial.index);
    forward += before;
    // Also strip any accidental mouse leftovers already in forward.
    return {
      complete: completeParts.join(""),
      forward: stripCompletedMouseOnly(forward),
      hold: partial[0],
    };
  }

  // Hold bare ESC / ESC[ that may start a mouse sequence on the next chunk.
  if (tail === "\x1b" || tail === "\x1b[" || tail === "[") {
    return {
      complete: completeParts.join(""),
      forward: stripCompletedMouseOnly(forward),
      hold: tail,
    };
  }

  forward += tail;
  return {
    complete: completeParts.join(""),
    forward: stripCompletedMouseOnly(forward),
    hold: "",
  };
}

function stripCompletedMouseOnly(text: string): string {
  return text.replace(SGR_MOUSE_COMPLETE_RE, "");
}
