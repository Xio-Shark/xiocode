import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";

import { ExtensionHost } from "./extension-host.ts";
import { registerRegressCommands } from "./regress-commands.ts";
import { createFixture } from "../../extensions/xio-regress/test/fixture.ts";

import type { InteractiveIO } from "./interactive-io.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
  temporaryRoots.length = 0;
});

function fakeIo(input: Readonly<{
  prompts?: string[];
  selects?: string[];
}> = {}): InteractiveIO {
  const prompts = [...(input.prompts ?? [])];
  const selects = [...(input.selects ?? [])];
  return {
    ask: async () => false,
    select: async () => selects.shift(),
    prompt: async () => prompts.shift(),
  };
}

describe("registerRegressCommands", () => {
  it("captures from the current run with custom verifier", async () => {
    const fixture = await createFixture(temporaryRoots, "success");
    const host = new ExtensionHost();
    const notices: string[] = [];
    registerRegressCommands({
      host,
      interactive: fakeIo({
        prompts: ["behavior missing", "false"],
        selects: ["custom"],
      }),
      sink: { notify: (message) => notices.push(message) },
      getRunId: () => "run-1",
      runRoot: fixture.runRoot,
      store: fixture.store,
      env: { SHELL: "/bin/sh" },
      now: () => new Date("2026-07-11T01:00:00.000Z"),
    });

    const result = await host.runCommand("regress", "");
    expect(String(result)).toContain("Captured");
    expect(String(result)).toContain("preflight=BASE_RED");
    expect(notices.some((n) => n.includes("Captured"))).toBe(true);
  });

  it("errors when there is no current run", async () => {
    const host = new ExtensionHost();
    registerRegressCommands({
      host,
      interactive: fakeIo(),
      sink: {},
      getRunId: () => undefined,
      runRoot: "/tmp",
    });
    await expect(host.runCommand("regress", "oops")).rejects.toThrow(/No current run/i);
  });

  it("accepts failure text as slash args", async () => {
    const fixture = await createFixture(temporaryRoots, "success");
    const host = new ExtensionHost();
    registerRegressCommands({
      host,
      interactive: fakeIo({ selects: ["custom"], prompts: ["false"] }),
      sink: {},
      getRunId: () => "run-1",
      runRoot: fixture.runRoot,
      store: fixture.store,
      env: { SHELL: "/bin/sh" },
      now: () => new Date("2026-07-11T02:00:00.000Z"),
    });
    const result = await host.runCommand("regress", "behavior missing");
    expect(String(result)).toContain("preflight=BASE_RED");
  });
});
