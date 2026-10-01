import { describe, expect, it } from "vitest";

import { formatAge, isConnected, loadRecentSessions, welcomeTips } from "./welcome.ts";

import type { SessionMetadata, StoredSession } from "../runtime/session-store.ts";

function stored(id: string, mainRoot: string, updatedAt: string, prompt?: string): StoredSession {
  return {
    metadata: { id, main_root: mainRoot, updated_at: updatedAt } as unknown as SessionMetadata,
    messages: prompt ? [{ role: "user", content: prompt }] : [{ role: "system", content: "sys" }],
  } as unknown as StoredSession;
}

describe("welcome", () => {
  it("leads with /connect until a provider is connected", () => {
    expect(welcomeTips({ connected: false })[0]!.keys).toBe("/connect");
    expect(welcomeTips({ connected: true }).map((tip) => tip.keys)).toEqual(["@", "?", "/rollback"]);
    expect(isConnected("not connected · /connect")).toBe(false);
    expect(isConnected("deepseek/deepseek-chat")).toBe(true);
  });

  it("lists this repository's latest prompted sessions, opening only as many as needed", async () => {
    const sessions = [
      stored("s1", "/repo", "2026-10-01T10:00:00Z", "fix the parser"),
      stored("s2", "/other", "2026-10-01T09:00:00Z", "elsewhere"),
      stored("s3", "/repo", "2026-10-01T08:00:00Z"),
      stored("s4", "/repo/", "2026-10-01T07:00:00Z", "add tests"),
      stored("current", "/repo", "2026-10-01T06:00:00Z", "this one"),
      stored("s5", "/repo", "2026-10-01T05:00:00Z", "rename module"),
      stored("s6", "/repo", "2026-10-01T04:00:00Z", "never opened"),
    ];
    const loaded: string[] = [];
    const store = {
      list: async () => sessions.map((session) => session.metadata),
      load: async (id: string) => {
        loaded.push(id);
        return sessions.find((session) => session.metadata.id === id)!;
      },
    };
    const recent = await loadRecentSessions(store, { mainRoot: "/repo", currentId: "current" });
    expect(recent.map((session) => session.firstPrompt)).toEqual(["fix the parser", "add tests", "rename module"]);
    expect(loaded).not.toContain("s6");
    expect(loaded).not.toContain("s2");
  });

  it("surfaces a store failure instead of showing an empty list", async () => {
    const store = { list: async () => { throw new Error("EACCES"); }, load: async () => { throw new Error("unused"); } };
    await expect(loadRecentSessions(store, { mainRoot: "/repo" })).rejects.toThrow("EACCES");
  });

  it("formats ages compactly", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    expect(formatAge("2026-10-01T11:57:00Z", now)).toBe("3m ago");
    expect(formatAge("2026-10-01T07:00:00Z", now)).toBe("5h ago");
    expect(formatAge("2026-09-29T12:00:00Z", now)).toBe("2d ago");
    expect(formatAge("2026-09-01T12:00:00Z", now)).toBe("09-01");
  });
});
