import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "./session-store.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe("SessionStore", () => {
  it("saves, lists, loads, updates, and removes a session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-sessions-"));
    roots.push(root);
    let timestamp = "2026-07-11T00:00:00.000Z";
    const store = new SessionStore({ root, now: () => new Date(timestamp) });
    const input = {
      id: "session1",
      model: { provider: "test", id: "model-a" },
      cwd: "/tmp/worktree",
      mainRoot: "/tmp/main",
      messages: [{ role: "user" as const, content: "hello" }],
    };

    const created = await store.save(input);
    timestamp = "2026-07-11T01:00:00.000Z";
    await store.save({ ...input, messages: [...input.messages, { role: "assistant", content: "hi" }] });

    expect((await store.list())[0]?.id).toBe("session1");
    const loaded = await store.load("session1");
    expect(loaded.metadata.created_at).toBe(created.metadata.created_at);
    expect(loaded.metadata.updated_at).toBe(timestamp);
    expect(loaded.messages).toHaveLength(2);
    expect((await store.latest("/tmp/main"))?.metadata.id).toBe("session1");
    await store.remove("session1");
    await expect(store.load("session1")).rejects.toThrow(/failed to load session session1/i);
  });

  it("reports corrupt records and rejects path-like ids", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-sessions-"));
    roots.push(root);
    await mkdir(path.join(root, "broken"), { recursive: true });
    await writeFile(path.join(root, "broken", "metadata.json"), "not-json", "utf8");
    await writeFile(path.join(root, "broken", "messages.json"), "[]", "utf8");
    const store = new SessionStore({ root });

    await expect(store.load("broken")).rejects.toThrow(/failed to load session broken/i);
    await expect(store.load("../escape")).rejects.toThrow(/invalid session id/i);
    await store.remove("broken");
  });
});
