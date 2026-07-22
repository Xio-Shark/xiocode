/**
 * Terminal mouse support for Ink alternate-screen apps.
 *
 * Inspired by pi-tui StdinBuffer (earendil-works/pi): mouse SGR sequences can
 * arrive in partial chunks; incomplete escapes must not be treated as keypresses.
 * Ink has no built-in wheel/pointer events — we enable SGR tracking and strip
 * sequences from the shared stdin stream so they never leak into the prompt.
 *
 * Button codes (SGR 1006):
 * - 0 + M = left press; 0 + m = left release
 * - 32 + M = left drag (button-event tracking / 1002)
 * - 64/65 = wheel up/down (68/69 with modifiers)
 */

const ENABLE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1007h";
const DISABLE = "\x1b[?1007l\x1b[?1006l\x1b[?1002l\x1b[?1000l";

/** Complete SGR mouse: optional ESC + `[<btn;x;yM|m` */
const SGR_MOUSE_COMPLETE_RE = /(?:\x1b)?\[<\d+(?:;\d+)*[Mm]/g;

/** Incomplete SGR mouse tail held across chunks. */
const SGR_MOUSE_PARTIAL_TAIL_RE = /(?:\x1b)?\[<\d*(?:;\d*)*$/;

export type MouseScrollDirection = "up" | "down";

export type MouseScrollHandler = (direction: MouseScrollDirection, steps: number) => void;

/** 1-based terminal cell coordinates (SGR). */
export type MousePointerKind = "down" | "drag" | "up";

export type MousePointerHandler = (
  kind: MousePointerKind,
  col: number,
  row: number,
) => void;

export type MouseHandlers = Readonly<{
  onScroll?: MouseScrollHandler;
  onPointer?: MousePointerHandler;
}>;

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
 * Parse one stdin chunk for wheel + left-button pointer events.
 * Returns whether any complete mouse sequence was found.
 */
export function consumeMouseScrollChunk(
  chunk: string,
  onScroll: MouseScrollHandler,
): boolean {
  return consumeMouseChunk(chunk, { onScroll });
}

/** Full SGR consumer: scroll + left pointer (press/drag/release). */
export function consumeMouseChunk(
  chunk: string,
  handlers: MouseHandlers,
): boolean {
  let matched = false;
  const re = /(?:\x1b)?\[<(\d+);(\d+);(\d+)([Mm])/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(chunk)) !== null) {
    matched = true;
    const button = Number(match[1]);
    const col = Number(match[2]);
    const row = Number(match[3]);
    const release = match[4] === "m";

    // Wheel (ignore modifier bit for 68/69).
    if (button === 64 || button === 68) {
      handlers.onScroll?.("up", 3);
      continue;
    }
    if (button === 65 || button === 69) {
      handlers.onScroll?.("down", 3);
      continue;
    }

    if (!handlers.onPointer) continue;

    // Left button: base 0, motion 32. Strip shift/meta/ctrl (4/8/16).
    const base = button & ~0b11100;
    if (base === 0 && !release) {
      handlers.onPointer("down", col, row);
    } else if (base === 32 && !release) {
      handlers.onPointer("drag", col, row);
    } else if ((base === 0 || base === 32) && release) {
      handlers.onPointer("up", col, row);
    }
  }
  return matched;
}

/**
 * Attach wheel + pointer listener and filter mouse sequences out of stdin before Ink.
 *
 * Pi's StdinBuffer completes CSI before key handling. We patch `stdin.emit('data')`
 * so residual `[<64;…M` never reaches useInput / the prompt.
 */
export function attachMouseScrollListener(
  stdin: NodeJS.ReadStream,
  onScroll: MouseScrollHandler,
  stdout?: NodeJS.WriteStream,
): () => void;
export function attachMouseScrollListener(
  stdin: NodeJS.ReadStream,
  handlers: MouseHandlers,
  stdout?: NodeJS.WriteStream,
): () => void;
export function attachMouseScrollListener(
  stdin: NodeJS.ReadStream,
  onScrollOrHandlers: MouseScrollHandler | MouseHandlers,
  stdout: NodeJS.WriteStream = process.stdout,
): () => void {
  const handlers: MouseHandlers = typeof onScrollOrHandlers === "function"
    ? { onScroll: onScrollOrHandlers }
    : onScrollOrHandlers;

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
      consumeMouseChunk(complete, handlers);
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
