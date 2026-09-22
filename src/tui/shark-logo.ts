/**
 * Header lettermark — “XIO” in modern geometric block glyphs with an iconic
 * trailing shark dorsal fin. X + O in brand/shark color; the I spine and the
 * fin in accent color, so the mark reads as one creature: letters up front,
 * fin trailing behind.
 *
 *   █   █  ███   ▄██▄          ▄▄
 *    ▀▄▀    █   █▀  ▀█       ▄███
 *    ▄▀▄    █   █▄  ▄█    ▄▄█████
 *   █   █  ███   ▀██▀   ▀▀▀██████
 */

import React from "react";
import { Box, Text } from "ink";

import { theme } from "./theme.ts";

const h = React.createElement;

/**
 * Columns needed to keep mark + gap + a readable title column on one row.
 * Below this the row wraps (Ink measures the truncated title as wider than the
 * room left) and a wrapped header row desyncs Ink's incremental repaint, so the
 * mark is dropped and the text column takes the full width instead.
 */
export const BRAND_MARK_MIN_COLUMNS = 54;

/** Four-row high-definition XIO wordmark with trailing shark dorsal fin (~29 cols). */
export function XioMark(): React.JSX.Element {
  if (process.env.XIO_DEBUG_WINDOW) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:fs").appendFileSync(process.env.XIO_DEBUG_WINDOW, `XioMark\n${new Error().stack}\n`);
    } catch {
      // ignore
    }
  }
  const letters = theme.shark;
  const accent = theme.accent;
  return h(Box, { flexDirection: "column", flexShrink: 0 },
    h(Text, null,
      h(Text, { color: letters }, "█   █"),
      h(Text, null, "  "),
      h(Text, { color: accent }, "███"),
      h(Text, null, "   "),
      h(Text, { color: letters }, "▄██▄"),
      h(Text, null, "          "),
      h(Text, { color: accent }, "▄▄")),
    h(Text, null,
      h(Text, { color: letters }, " ▀▄▀ "),
      h(Text, null, "   "),
      h(Text, { color: accent }, "█"),
      h(Text, null, "   "),
      h(Text, { color: letters }, "█▀  ▀█"),
      h(Text, null, "       "),
      h(Text, { color: accent }, "▄███")),
    h(Text, null,
      h(Text, { color: letters }, " ▄▀▄ "),
      h(Text, null, "   "),
      h(Text, { color: accent }, "█"),
      h(Text, null, "   "),
      h(Text, { color: letters }, "█▄  ▄█"),
      h(Text, null, "    "),
      h(Text, { color: accent }, "▄▄█████")),
    h(Text, null,
      h(Text, { color: letters }, "█   █"),
      h(Text, null, "  "),
      h(Text, { color: accent }, "███"),
      h(Text, null, "   "),
      h(Text, { color: letters }, "▀██▀"),
      h(Text, null, "   "),
      h(Text, { color: accent }, "▀▀▀██████")));
}

/** @deprecated Alias — kept for older imports; the mark carries the fin now. */
export const SharkLogo = XioMark;

/** Condensed brand header: prominent lettermark + title column. */
export function BrandHeader(props: Readonly<{
  version: string;
  /** Dim second line (model · think · …). */
  meta?: string;
  /** Dim third line (cwd / boot status). */
  path?: string;
  /** Terminal width; below {@link BRAND_MARK_MIN_COLUMNS} the mark is dropped. */
  columns?: number;
}>): React.JSX.Element {
  const showMark = (props.columns ?? 80) >= BRAND_MARK_MIN_COLUMNS;
  return h(Box, {
    flexDirection: "row",
    gap: 2,
    alignItems: "center",
    marginBottom: 1,
  },
    showMark ? h(XioMark) : null,
    h(Box, { flexDirection: "column", flexGrow: 1 },
      h(Text, null,
        h(Text, { bold: true, color: theme.brand }, "XioCode"),
        h(Text, { dimColor: true }, ` v${props.version}`)),
      props.meta
        ? h(Text, { dimColor: true, wrap: "truncate-end" }, props.meta)
        : null,
      props.path
        ? h(Text, { dimColor: true, wrap: "truncate-end" }, props.path)
        : null));
}
