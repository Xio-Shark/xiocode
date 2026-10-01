/**
 * Welcome screen body: three tips chosen from the session's state, then the
 * latest sessions of this repository (`xio resume` continues one). Shown under
 * the brand header until the first prompt is sent.
 */

import path from "node:path";
import React from "react";
import { Box, Text } from "ink";

import type { SessionStore } from "../runtime/session-store.ts";
import { t } from "../i18n/messages.ts";
import { displayWidth, truncateToDisplayWidth } from "./text-selection.ts";

/** Right-align by terminal columns (CJK counts two). */
function padDisplay(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - displayWidth(text))) + text;
}
import { theme } from "./theme.ts";

const h = React.createElement;

export type RecentSession = Readonly<{ id: string; updatedAt: string; firstPrompt: string }>;

export type WelcomeTip = Readonly<{ keys: string; text: string }>;

/** Tips for the first screen: getting connected first, then the features people miss. */
export function welcomeTips(state: Readonly<{ connected: boolean }>): readonly WelcomeTip[] {
  if (!state.connected) {
    return [
      { keys: "/connect", text: t("welcome.connect") },
      { keys: "/model", text: t("welcome.model") },
      { keys: "?", text: t("welcome.shortcuts") },
    ];
  }
  return [
    { keys: "@", text: t("welcome.mention") },
    { keys: "?", text: t("welcome.shortcuts") },
    { keys: "/rollback", text: t("welcome.rollback") },
  ];
}

/** The model status reads "not connected · /connect" while no credentials resolve. */
export function isConnected(modelStatus: string): boolean {
  return !modelStatus.includes("/connect");
}

/**
 * Latest prompted sessions of `mainRoot`, newest first, skipping `currentId`.
 * Sessions are opened one at a time and only until `limit` are found.
 */
export async function loadRecentSessions(
  store: Pick<SessionStore, "list" | "load">,
  input: Readonly<{ mainRoot: string; currentId?: string; limit?: number }>,
): Promise<readonly RecentSession[]> {
  const limit = input.limit ?? 3;
  const root = path.resolve(input.mainRoot);
  const recent: RecentSession[] = [];
  for (const metadata of await store.list()) {
    if (recent.length >= limit) break;
    if (metadata.id === input.currentId || path.resolve(metadata.main_root) !== root) continue;
    const session = await store.load(metadata.id);
    const first = session.messages.find((message) => message.role === "user");
    if (!first || typeof first.content !== "string") continue;
    recent.push({ id: metadata.id, updatedAt: metadata.updated_at, firstPrompt: first.content });
  }
  return recent;
}

/** "3m ago" / "5h ago" / "2d ago" / "10-01". */
export function formatAge(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return t("welcome.minutes", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("welcome.hours", { n: hours });
  const days = Math.round(hours / 24);
  if (days < 7) return t("welcome.days", { n: days });
  return iso.slice(5, 10);
}

export function WelcomePanel(props: Readonly<{
  connected: boolean;
  recent: readonly RecentSession[];
  columns: number;
  now?: number;
}>): React.JSX.Element {
  const tips = welcomeTips({ connected: props.connected });
  const keyWidth = Math.max(...tips.map((tip) => tip.keys.length));
  const now = props.now ?? Date.now();
  const budget = Math.max(16, props.columns - 4);
  return h(Box, { flexDirection: "column", flexShrink: 0, marginBottom: 1 },
    ...tips.map((tip) => h(Text, { key: tip.keys, wrap: "truncate-end" },
      h(Text, { color: theme.accent }, `  ${tip.keys.padEnd(keyWidth)}  `),
      h(Text, { color: theme.muted }, tip.text))),
    props.recent.length > 0
      ? h(Box, { flexDirection: "column", marginTop: 1 },
        h(Text, { color: theme.muted }, t("welcome.recent")),
        ...props.recent.map((session) => {
          const age = padDisplay(formatAge(session.updatedAt, now), 9);
          const prompt = session.firstPrompt.replace(/\s+/g, " ").trim();
          return h(Text, { key: session.id, wrap: "truncate-end" },
            h(Text, { color: theme.muted }, `  ${age}  `),
            truncateToDisplayWidth(prompt, Math.max(8, budget - displayWidth(age) - 4)));
        }))
      : null);
}
