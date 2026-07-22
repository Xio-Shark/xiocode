/**
 * Header lettermark — “XIO” in block glyphs (Claude CondensedLogo slot).
 * X + O in brand magenta; I spine in accent cyan so the trio reads as one mark.
 *
 *   █ █ ▄█▄ ▄▀▄
 *   ▀█▀  █  █ █
 *   █ █ ▀█▀ ▀▄▀
 */

import React from "react";
import { Box, Text } from "ink";

import { theme } from "./theme.ts";

const h = React.createElement;

/** Three-row XIO pixel wordmark (~11 cols). */
export function XioMark(): React.JSX.Element {
  const x = theme.shark;
  const eye = theme.accent;
  const o = theme.shark;
  return h(Box, { flexDirection: "column", flexShrink: 0 },
    h(Text, null,
      h(Text, { color: x }, "█ █"),
      h(Text, null, " "),
      h(Text, { color: eye }, "▄█▄"),
      h(Text, null, " "),
      h(Text, { color: o }, "▄▀▄")),
    h(Text, null,
      h(Text, { color: x }, "▀█▀"),
      h(Text, null, " "),
      h(Text, { color: eye }, " █ "),
      h(Text, null, " "),
      h(Text, { color: o }, "█ █")),
    h(Text, null,
      h(Text, { color: x }, "█ █"),
      h(Text, null, " "),
      h(Text, { color: eye }, "▀█▀"),
      h(Text, null, " "),
      h(Text, { color: o }, "▀▄▀")));
}

/** @deprecated Alias — header mark is XIO letters, not a mascot. */
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
