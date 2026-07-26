/**
 * Header lettermark — “XIO” in block glyphs plus a shark fin (Claude
 * CondensedLogo slot). X + O in brand magenta; the I spine and the fin in
 * accent cyan, so the mark reads as one animal: letters up front, fin behind.
 *
 *   █ █ ▄█▄ ▄▀▀▄   ▄
 *    █   █  █  █  ▄█
 *   █ █ ▀█▀ ▀▄▄▀ ▄██
 */

import React from "react";
import { Box, Text } from "ink";

import { theme } from "./theme.ts";

const h = React.createElement;

/** Three-row XIO wordmark with trailing fin (~16 cols). */
export function XioMark(): React.JSX.Element {
  const letters = theme.shark;
  const accent = theme.accent;
  return h(Box, { flexDirection: "column", flexShrink: 0 },
    h(Text, null,
      h(Text, { color: letters }, "█ █"),
      h(Text, null, " "),
      h(Text, { color: accent }, "▄█▄"),
      h(Text, null, " "),
      h(Text, { color: letters }, "▄▀▀▄"),
      h(Text, null, " "),
      h(Text, { color: accent }, "  ▄")),
    h(Text, null,
      h(Text, { color: letters }, " █ "),
      h(Text, null, " "),
      h(Text, { color: accent }, " █ "),
      h(Text, null, " "),
      h(Text, { color: letters }, "█  █"),
      h(Text, null, " "),
      h(Text, { color: accent }, " ▄█")),
    h(Text, null,
      h(Text, { color: letters }, "█ █"),
      h(Text, null, " "),
      h(Text, { color: accent }, "▀█▀"),
      h(Text, null, " "),
      h(Text, { color: letters }, "▀▄▄▀"),
      h(Text, null, " "),
      h(Text, { color: accent }, "▄██")));
}

/** @deprecated Alias — kept for older imports; the mark carries the fin now. */
export const SharkLogo = XioMark;

/** Condensed Claude-style brand row: lettermark + title column. */
export function BrandHeader(props: Readonly<{
  version: string;
  /** Dim second line (model · think · …). */
  meta?: string;
  /** Dim third line (cwd / boot status). */
  path?: string;
}>): React.JSX.Element {
  return h(Box, {
    flexDirection: "row",
    gap: 2,
    alignItems: "center",
    marginBottom: 1,
  },
    h(XioMark),
    h(Box, { flexDirection: "column", flexGrow: 1 },
      h(Text, null,
        h(Text, { bold: true }, "XioCode"),
        h(Text, { dimColor: true }, ` v${props.version}`)),
      props.meta
        ? h(Text, { dimColor: true, wrap: "truncate-end" }, props.meta)
        : null,
      props.path
        ? h(Text, { dimColor: true, wrap: "truncate-end" }, props.path)
        : null));
}
