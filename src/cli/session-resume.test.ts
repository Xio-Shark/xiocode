import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../runtime/session-store.ts";
import { parseResumeRequest, resolveResume } from "./session-resume.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe("parseResumeRequest", () => {
  it("supports latest, id, picker, delete, and --continue", () => {
    expect(parseResumeRequest(["resume"]).request).toEqual({ action: "latest" });
    expect(parseResumeRequest(["resume", "abc"]).request).toEqual({ action: "load", id: "abc" });
    expect(parseResumeRequest(["resume", "--list"]).request).toEqual({ action: "list" });
    expect(parseResumeRequest(["resume", "--delete", "abc"]).request).toEqual({ action: "delete", id: "abc" });
    expect(parseResumeRequest(["--continue", "--xio-fast"])).toEqual({
      request: { action: "latest" },
      remaining: ["--xio-fast"],
    });
  });
});

describe("resolveResume", () => {
  it("filters picker sessions by repository and loads the selected record", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-resume-"));
    roots.push(root);
    const store = new SessionStore({ root });
    const base = {
      model: { provider: "test", id: "model" },
      cwd: "/tmp/worktree",
      messages: [{ role: "user" as const, content: "hello" }],
    };
    await store.save({ ...base, id: "one", mainRoot: "/repo/one" });
    await store.save({ ...base, id: "two", mainRoot: "/repo/two" });
    let choices: readonly string[] = [];

    const loaded = await resolveResume({
      store,
      request: { action: "list" },
      mainRoot: "/repo/one",
      select: async (sessions) => {
        choices = sessions.map((session) => session.id);
        return sessions[0]?.id;
      },
    });

    expect(choices).toEqual(["one"]);
    expect(loaded?.metadata.id).toBe("one");
    expect((await resolveResume({
      store,
      request: { action: "latest" },
      mainRoot: "/repo/two",
      select: async () => undefined,
    }))?.metadata.id).toBe("two");
  });
});
