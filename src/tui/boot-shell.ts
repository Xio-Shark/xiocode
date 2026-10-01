/**
 * Interactive boot shell: first operable Ink frame before prepareSession completes.
 * Keystrokes are buffered and drained into the full App composer at prompt_ready.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";

import {
  applyInputChunk,
  deleteBackward,
  emptyComposer,
  moveCursor,
  setComposerText,
  type ComposerState,
} from "./composer.ts";
import { t } from "../i18n/messages.ts";
import { formatShortCwd, theme } from "./theme.ts";
import { BrandHeader } from "./shark-logo.ts";

const h = React.createElement;

export type BootReadiness = "boot" | "core_session" | "prompt_context" | "ready";

export type BootConfirmation = Readonly<{
  question: string;
  detail?: string;
}>;

export type BootConfirmationIntent = "approve" | "deny" | "interrupt";

export type BootInputSnapshot = Readonly<{
  text: string;
  /** True when the user pressed Enter during boot with non-empty draft. */
  pendingSubmit: boolean;
}>;

/**
 * Mutable buffer shared between the boot shell and the session launcher.
 * Thread-safe enough for single-threaded Node event loop.
 */
export class BootInputBuffer {
  #state: ComposerState = emptyComposer();
  #pendingSubmit = false;
  #listeners = new Set<() => void>();

  get text(): string {
    return this.#state.text;
  }

  get pendingSubmit(): boolean {
    return this.#pendingSubmit;
  }

  snapshot(): BootInputSnapshot {
    return { text: this.#state.text, pendingSubmit: this.#pendingSubmit };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  applyKey(
    character: string,
    key: Readonly<{
      return: boolean;
      backspace?: boolean;
      delete?: boolean;
      leftArrow?: boolean;
      rightArrow?: boolean;
      escape?: boolean;
      ctrl?: boolean;
    }>,
  ): void {
    if (key.escape || (key.ctrl && character === "c")) {
      return;
    }
    if (key.backspace || key.delete) {
      this.#state = deleteBackward(this.#state);
      this.#pendingSubmit = false;
      this.#notify();
      return;
    }
    if (key.leftArrow) {
      this.#state = moveCursor(this.#state, -1);
      this.#notify();
      return;
    }
    if (key.rightArrow) {
      this.#state = moveCursor(this.#state, 1);
      this.#notify();
      return;
    }
    const applied = applyInputChunk(this.#state, character, { return: key.return === true });
    this.#state = applied.state;
    if (applied.submit && this.#state.text.trim().length > 0) {
      this.#pendingSubmit = true;
    } else if (!applied.submit && character.length > 0) {
      this.#pendingSubmit = false;
    }
    this.#notify();
  }

  /** Replace draft (tests / programmatic seed). */
  setText(text: string): void {
    this.#state = setComposerText(this.#state, text);
    this.#pendingSubmit = false;
    this.#notify();
  }

  /** Drain into the full App; clears boot buffer. */
  drain(): BootInputSnapshot {
    const snap = this.snapshot();
    this.#state = emptyComposer();
    this.#pendingSubmit = false;
    this.#notify();
    return snap;
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

export type BootShellProps = Readonly<{
  version: string;
  cwd: string;
  status: string;
  readiness: BootReadiness;
  buffer: BootInputBuffer;
  confirmation?: BootConfirmation;
  onAnswerConfirmation?: (approved: boolean) => void;
  onInterrupt?: () => void;
  /** When false, skip useInput (headless paint / tests that only check layout). */
  captureInput?: boolean;
  /** Terminal width; forwarded so the brand mark is dropped when it cannot fit. */
  columns?: number;
}>;

export function BootShell(props: BootShellProps): React.JSX.Element {
  const captureInput = props.captureInput !== false;
  const [draft, setDraft] = useState(props.buffer.text);
  const [pending, setPending] = useState(props.buffer.pendingSubmit);

  useEffect(() => {
    return props.buffer.subscribe(() => {
      setDraft(props.buffer.text);
      setPending(props.buffer.pendingSubmit);
    });
  }, [props.buffer]);

  useInput(
    (input, key) => {
      if (props.confirmation) {
        const intent = bootConfirmationIntent(input, key);
        if (intent === "approve") {
          props.onAnswerConfirmation?.(true);
        } else if (intent === "deny") {
          props.onAnswerConfirmation?.(false);
        } else if (intent === "interrupt") {
          props.onInterrupt?.();
          props.onAnswerConfirmation?.(false);
        }
        return;
      }
      props.buffer.applyKey(input, key);
    },
    { isActive: captureInput },
  );

  const statusLabel = readinessLabel(props.readiness, props.status);
  return h(Box, { flexDirection: "column", marginBottom: 1 },
    h(BrandHeader, {
      version: props.version,
      meta: props.confirmation ? t("boot.projectTrust") : statusLabel,
      path: formatShortCwd(props.cwd),
      columns: props.columns,
    }),
    props.confirmation
      ? h(Box, { flexDirection: "column", marginTop: 1 },
        h(Text, { color: theme.accent, bold: true }, stripAnswerHint(props.confirmation.question)),
        props.confirmation.detail
          ? h(Text, { color: theme.muted }, shortenDetailPaths(props.confirmation.detail))
          : null,
        h(Text, { color: theme.muted }, t("boot.trustKeys")))
      : h(React.Fragment, null,
        h(Box, { marginTop: 1 },
          h(Text, { color: theme.muted }, theme.sym.prompt),
          h(Text, null, ` ${draft}${pending ? " ↵" : ""}`)),
        pending
          ? h(Text, { color: theme.muted }, t("boot.buffered"))
          : null));
}

/**
 * The `[y/N]` suffix is for the line-mode REPL; full-screen views list their keys
 * on a line of their own, and the suffix only made the question wrap.
 */
export function stripAnswerHint(question: string): string {
  return question.replace(/\s*\[y\/N\]\s*$/i, "");
}

/** `cwd: /Users/me/…/repo` lines shown like the footer path (home → ~, middle ellipsis). */
function shortenDetailPaths(detail: string): string {
  return detail.split("\n").map((line) => {
    const match = /^(cwd|path): (\/.*)$/.exec(line);
    return match ? `${match[1]}: ${formatShortCwd(match[2]!, 56)}` : line;
  }).join("\n");
}

export function bootConfirmationIntent(
  character: string,
  key: Readonly<{ return?: boolean; escape?: boolean; ctrl?: boolean }>,
): BootConfirmationIntent | undefined {
  const normalized = character.toLowerCase();
  if (key.ctrl && normalized === "c") return "interrupt";
  if (normalized === "y") return "approve";
  if (normalized === "n" || key.return || key.escape) return "deny";
  return undefined;
}

export function readinessLabel(readiness: BootReadiness, status: string): string {
  if (status.length > 0 && readiness !== "ready") {
    return status;
  }
  switch (readiness) {
    case "boot":
      return t("boot.starting");
    case "core_session":
      return t("boot.loadingSession");
    case "prompt_context":
      return t("boot.loadingContext");
    case "ready":
      return t("boot.ready");
    default: {
      const _exhaustive: never = readiness;
      return _exhaustive;
    }
  }
}

/** Pure helper for tests: apply a single character without React. */
export function applyBootKeyForTest(
  buffer: BootInputBuffer,
  character: string,
  key: Readonly<{ return?: boolean; backspace?: boolean }> = {},
): BootInputSnapshot {
  buffer.applyKey(character, {
    return: key.return === true,
    backspace: key.backspace === true,
  });
  return buffer.snapshot();
}
