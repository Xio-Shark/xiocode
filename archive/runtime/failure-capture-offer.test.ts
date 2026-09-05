import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";

import { ExtensionHost } from "./extension-host.ts";
import {
  createFailureCaptureOffer,
  createLiveFailureStatementDrafter,
  draftFailureStatementFromRun,
} from "./failure-capture-offer.ts";
import { createPromptRunner } from "./session-lifecycle.ts";
import { SessionHistory } from "./context-compaction.ts";
import { SteerMailbox } from "./steer.ts";
import { createScriptedLlmClient, parseAgentTape } from "./providers/scripted/index.ts";
import { createFixture } from "../../extensions/xio-regress/test/fixture.ts";

import type { InteractiveIO } from "./interactive-io.ts";
import type { LlmClient, ProviderRegistration } from "./types.ts";
import type { ExploreSubagentResult } from "./explore/types.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
  temporaryRoots.length = 0;
});

function fakeIo(input: Readonly<{
  asks?: boolean[];
  prompts?: Array<string | undefined>;
  selects?: string[];
}> = {}): InteractiveIO & { asks: string[] } {
  const asks = [...(input.asks ?? [])];
  const prompts = [...(input.prompts ?? [])];
  const selects = [...(input.selects ?? [])];
  const asked: string[] = [];
  return {
    asks: asked,
    ask: async (question) => {
      asked.push(question);
      return asks.shift() ?? false;
    },
    select: async () => selects.shift(),
    prompt: async () => prompts.shift(),
  };
}

const stubRegistration: ProviderRegistration = {
  name: "stub",
  api: "openai-completions",
  models: [{ id: "flash", name: "flash", input: ["text"] }],
};

function emptyUsage(): ExploreSubagentResult["usage"] {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheTokens: null,
    reasoningTokens: null,
  };
}

describe("createFailureCaptureOffer", () => {
  it("offers once per turn and remembers decline", async () => {
    const notices: string[] = [];
    const io = fakeIo({ asks: [false, false] });
    const offer = createFailureCaptureOffer({
      offerOnFailure: true,
      interactive: io,
      sink: { notify: (message) => notices.push(message) },
      capture: {
        host: new ExtensionHost(),
        interactive: io,
        sink: { notify: (message) => notices.push(message) },
        getRunId: () => "run-1",
        runRoot: "/tmp",
      },
      draftFailureStatement: async () => "draft",
    });

    await offer.maybeOfferFailureCapture({ turnId: "t1", signal: "turn_failed", runId: "run-1" });
    await offer.maybeOfferFailureCapture({ turnId: "t1", signal: "hard_steer", runId: "run-1" });
    await offer.maybeOfferFailureCapture({ turnId: "t2", signal: "rollback", runId: "run-1" });

    expect(io.asks).toEqual([
      "Capture as regression case?",
      "Capture as regression case?",
    ]);
    expect(notices.filter((n) => n.includes("/regress")).length).toBe(2);
  });

  it("silences offers when offer_on_failure is false", async () => {
    const io = fakeIo({ asks: [true] });
    const offer = createFailureCaptureOffer({
      offerOnFailure: false,
      interactive: io,
      sink: {},
      capture: {
        host: new ExtensionHost(),
        interactive: io,
        sink: {},
        getRunId: () => "run-1",
        runRoot: "/tmp",
      },
    });
    await offer.maybeOfferFailureCapture({ turnId: "t1", signal: "rollback", runId: "run-1" });
    expect(io.asks).toEqual([]);
  });

  it("degrades to manual prompts when draft fails", async () => {
    const fixture = await createFixture(temporaryRoots, "failed");
    const notices: string[] = [];
    const io = fakeIo({
      // capture offer only — no draft-accept ask when enrichment fails
      asks: [true],
      prompts: ["manual failure", "false"],
      selects: ["custom"],
    });
    const offer = createFailureCaptureOffer({
      offerOnFailure: true,
      interactive: io,
      sink: { notify: (message) => notices.push(message) },
      capture: {
        host: new ExtensionHost(),
        interactive: io,
        sink: { notify: (message) => notices.push(message) },
        getRunId: () => "run-1",
        runRoot: fixture.runRoot,
        store: fixture.store,
        env: { SHELL: "/bin/sh" },
        now: () => new Date("2026-07-16T12:00:00.000Z"),
      },
      draftFailureStatement: async () => {
        throw new Error("worker timeout");
      },
    });

    await offer.maybeOfferFailureCapture({
      turnId: "t-degrade",
      signal: "turn_failed",
      runId: "run-1",
    });

    expect(notices.some((n) => /Draft enrichment unavailable/.test(n))).toBe(true);
    expect(notices.some((n) => /Captured/.test(n) && /preflight=/.test(n))).toBe(true);
  });

  it("captures with machine-drafted failure statement on accept", async () => {
    const fixture = await createFixture(temporaryRoots, "failed");
    const notices: string[] = [];
    const io = fakeIo({
      // capture offer + accept drafted statement; custom verifier command
      asks: [true, true],
      prompts: ["false"],
      selects: ["custom"],
    });

    const offer = createFailureCaptureOffer({
      offerOnFailure: true,
      interactive: io,
      sink: { notify: (message) => notices.push(message) },
      capture: {
        host: new ExtensionHost(),
        interactive: io,
        sink: { notify: (message) => notices.push(message) },
        getRunId: () => "run-1",
        runRoot: fixture.runRoot,
        store: fixture.store,
        env: { SHELL: "/bin/sh" },
        now: () => new Date("2026-07-16T12:30:00.000Z"),
      },
      draftFailureStatement: async () => "machine drafted failure",
    });

    await offer.maybeOfferFailureCapture({
      turnId: "t-happy",
      signal: "hard_steer",
      runId: "run-1",
    });

    expect(io.asks).toEqual([
      "Capture as regression case?",
      "Accept drafted failure statement?",
    ]);
    expect(notices.some((n) => n.includes("Draft failure statement:\nmachine drafted failure"))).toBe(true);
    expect(notices.some((n) => /Captured/.test(n))).toBe(true);
  });

  it("cancels when draft is declined and manual statement is empty", async () => {
    const notices: string[] = [];
    const io = fakeIo({
      asks: [true, false],
      prompts: [undefined],
    });
    const offer = createFailureCaptureOffer({
      offerOnFailure: true,
      interactive: io,
      sink: { notify: (message) => notices.push(message) },
      capture: {
        host: new ExtensionHost(),
        interactive: io,
        sink: { notify: (message) => notices.push(message) },
        getRunId: () => "run-1",
        runRoot: "/tmp",
      },
      draftFailureStatement: async () => "machine drafted failure",
    });

    await offer.maybeOfferFailureCapture({
      turnId: "t-cancel",
      signal: "turn_failed",
      runId: "run-1",
    });

    expect(notices.some((n) => /Captured/.test(n))).toBe(false);
  });

  it("keeps artifact seed when live-style draft returns after abort at draftTimeoutMs", async () => {
    const fixture = await createFixture(temporaryRoots, "failed");
    const notices: string[] = [];
    const io = fakeIo({
      asks: [true, true],
      prompts: ["false"],
      selects: ["custom"],
    });
    const offer = createFailureCaptureOffer({
      offerOnFailure: true,
      interactive: io,
      sink: { notify: (message) => notices.push(message) },
      capture: {
        host: new ExtensionHost(),
        interactive: io,
        sink: { notify: (message) => notices.push(message) },
        getRunId: () => "run-1",
        runRoot: fixture.runRoot,
        store: fixture.store,
        env: { SHELL: "/bin/sh" },
        now: () => new Date("2026-07-16T13:00:00.000Z"),
      },
      draftTimeoutMs: 40,
      draftFailureStatement: createLiveFailureStatementDrafter({
        cwd: process.cwd(),
        workspaceRoot: process.cwd(),
        runRoot: fixture.runRoot,
        getRegistration: () => stubRegistration,
        resolveApiKey: () => "sk-test",
        getModelId: () => "flash",
        timeoutMs: 40,
        onDegrade: (message) => notices.push(message),
        runDraftSubagent: async (opts) => {
          await new Promise<void>((resolve) => {
            opts.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          // Settle slightly after abort — must still beat the offer outer budget.
          await new Promise<void>((r) => {
            setTimeout(r, 15);
          });
          return {
            provider: "stub",
            model: "flash",
            success: false,
            cancelled: true,
            text: "",
            turns: 0,
            toolCalls: 0,
            toolErrors: 0,
            usage: emptyUsage(),
            error: "aborted",
          };
        },
      }),
    });

    await offer.maybeOfferFailureCapture({
      turnId: "t-seed-survive",
      signal: "turn_failed",
      runId: "run-1",
    });

    expect(notices.some((n) => /timed out or aborted/.test(n))).toBe(true);
    expect(notices.some((n) => /Draft enrichment unavailable/.test(n))).toBe(false);
    expect(io.asks).toContain("Accept drafted failure statement?");
    expect(notices.some((n) => /Captured/.test(n))).toBe(true);
  });
});

describe("createLiveFailureStatementDrafter", () => {
  it("uses LLM draft text when the explore worker succeeds", async () => {
    const fixture = await createFixture(temporaryRoots, "failed");
    const calls: Array<{ goal: string; artifactSeed?: string }> = [];
    const draft = createLiveFailureStatementDrafter({
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      runRoot: fixture.runRoot,
      getRegistration: () => stubRegistration,
      resolveApiKey: () => "sk-test",
      getModelId: () => "flash",
      runDraftSubagent: async (opts) => {
        calls.push({ goal: opts.goal, artifactSeed: opts.artifactSeed });
        return {
          provider: "stub",
          model: "flash",
          success: true,
          text: "LLM: verifier red after hard steer on auth path",
          turns: 1,
          toolCalls: 0,
          toolErrors: 0,
          usage: emptyUsage(),
        };
      },
    });

    const text = await draft({ turnId: "t1", signal: "hard_steer", runId: "run-1" });
    expect(text).toBe("LLM: verifier red after hard steer on auth path");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.artifactSeed).toMatch(/Operator signal: hard steer/);
    expect(calls[0]?.goal).toMatch(/hard steer/i);
  });

  it("announces degrade and falls back to artifact seed when LLM fails", async () => {
    const fixture = await createFixture(temporaryRoots, "failed");
    const notices: string[] = [];
    const draft = createLiveFailureStatementDrafter({
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      runRoot: fixture.runRoot,
      getRegistration: () => stubRegistration,
      resolveApiKey: () => "sk-test",
      getModelId: () => "flash",
      onDegrade: (message) => notices.push(message),
      runDraftSubagent: async () => ({
        provider: "stub",
        model: "flash",
        success: false,
        text: "",
        turns: 0,
        toolCalls: 0,
        toolErrors: 0,
        usage: emptyUsage(),
        error: "provider down",
      }),
    });

    const text = await draft({ turnId: "t2", signal: "turn_failed", runId: "run-1" });
    expect(text).toMatch(/Operator signal: turn failed/);
    expect(notices.some((n) => /LLM draft unavailable/.test(n) && /artifact seed/.test(n))).toBe(true);
  });

  it("aborts on timeout and falls back with announced degrade", async () => {
    const fixture = await createFixture(temporaryRoots, "failed");
    const notices: string[] = [];
    const draft = createLiveFailureStatementDrafter({
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      runRoot: fixture.runRoot,
      getRegistration: () => stubRegistration,
      resolveApiKey: () => "sk-test",
      getModelId: () => "flash",
      timeoutMs: 30,
      onDegrade: (message) => notices.push(message),
      runDraftSubagent: async (opts) => {
        await new Promise<void>((resolve) => {
          opts.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          provider: "stub",
          model: "flash",
          success: false,
          cancelled: true,
          text: "",
          turns: 0,
          toolCalls: 0,
          toolErrors: 0,
          usage: emptyUsage(),
          error: "aborted",
        };
      },
    });

    const text = await draft({ turnId: "t3", signal: "rollback", runId: "run-1" });
    expect(text).toMatch(/Operator signal: \/rollback/);
    expect(notices.some((n) => /timed out or aborted/.test(n))).toBe(true);
  });

  it("skips LLM without throwing when credentials are missing", async () => {
    const fixture = await createFixture(temporaryRoots, "failed");
    const notices: string[] = [];
    let llmCalled = false;
    const draft = createLiveFailureStatementDrafter({
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      runRoot: fixture.runRoot,
      getRegistration: () => stubRegistration,
      resolveApiKey: () => undefined,
      getModelId: () => "flash",
      onDegrade: (message) => notices.push(message),
      runDraftSubagent: async () => {
        llmCalled = true;
        throw new Error("should not run");
      },
    });

    const text = await draft({ turnId: "t4", signal: "turn_failed", runId: "run-1" });
    expect(llmCalled).toBe(false);
    expect(text).toMatch(/Operator signal: turn failed/);
    expect(notices.some((n) => /missing provider credentials/.test(n))).toBe(true);
  });
});

describe("draftFailureStatementFromRun", () => {
  it("builds a statement from run summary", async () => {
    const fixture = await createFixture(temporaryRoots, "failed");
    const draft = await draftFailureStatementFromRun({
      runRoot: fixture.runRoot,
      runId: "run-1",
      signal: "turn_failed",
    });
    expect(draft).toContain("Operator signal: turn failed");
    expect(draft).toMatch(/Run status: failed/);
  });
});

describe("createPromptRunner failure capture wiring", () => {
  it("offers turn_failed once after settle", async () => {
    const offers: Array<{ signal: string; turnId: string }> = [];
    const host = new ExtensionHost();
    const client: LlmClient = {
      async complete() {
        return { content: "done", toolCalls: [] };
      },
    };
    const runPrompt = createPromptRunner({
      host,
      client,
      model: { provider: "test", id: "stub" },
      providerApi: "openai-completions",
      verify: {
        enabled: true,
        requireAllPass: true,
        repairTurns: 0,
        commands: [{ name: "fail", argv: ["false"] }],
      },
      doneContract: {
        requireAllPass: true,
        commands: [{ name: "fail", argv: ["false"] }],
      },
      getRunId: () => "run-42",
      sink: {},
      failureCapture: {
        maybeOffer: async (input) => {
          offers.push({ signal: input.signal, turnId: input.turnId });
        },
      },
    });

    const result = await runPrompt("verify me");
    expect(result.success).toBe(false);
    expect(offers).toHaveLength(1);
    expect(offers[0]?.signal).toBe("turn_failed");
  });

  it("offers hard_steer after hard-steer hop settles", async () => {
    const offers: Array<{ signal: string }> = [];
    const mailbox = new SteerMailbox();
    let signal = new AbortController();
    const tape = parseAgentTape({
      schema_version: "xio-agent-tape.v1",
      name: "hard-offer",
      turns: [
        {
          steps: [
            { type: "barrier", id: "b" },
            { type: "hang", ms: 60_000 },
            { type: "done" },
          ],
        },
        {
          steps: [
            { type: "delta", channel: "text", chunks: ["continued"] },
            { type: "done" },
          ],
        },
      ],
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = createScriptedLlmClient({
      tape,
      async onBarrier() {
        mailbox.enqueue({ text: "continue path", mode: "hard" });
        signal.abort();
        await gate;
      },
      async sleep() {},
    });
    const run = createPromptRunner({
      host: new ExtensionHost(),
      client,
      model: { provider: "scripted", id: "scripted" },
      providerApi: "openai-completions",
      verify: { enabled: false, requireAllPass: true, repairTurns: 0, commands: [] },
      history: new SessionHistory(),
      steerMailbox: mailbox,
      getSignal: () => signal.signal,
      resetSignal: () => {
        signal = new AbortController();
        return signal.signal;
      },
      getRunId: () => "run-hs",
      failureCapture: {
        maybeOffer: async (input) => {
          offers.push({ signal: input.signal });
        },
      },
    });
    const pending = run("start hard");
    await new Promise<void>((r) => {
      setTimeout(r, 20);
    });
    release?.();
    const out = await pending;
    expect(out.success).toBe(true);
    expect(offers).toEqual([{ signal: "hard_steer" }]);
  });

  it("offers turn_failed when the loop throws a non-compaction error", async () => {
    const offers: Array<{ signal: string }> = [];
    const host = new ExtensionHost();
    const client: LlmClient = {
      async complete() {
        throw new Error("provider exploded");
      },
    };
    const runPrompt = createPromptRunner({
      host,
      client,
      model: { provider: "test", id: "stub" },
      providerApi: "openai-completions",
      verify: { enabled: false, requireAllPass: true, repairTurns: 0, commands: [] },
      getRunId: () => "run-throw",
      sink: {},
      failureCapture: {
        maybeOffer: async (input) => {
          offers.push({ signal: input.signal });
        },
      },
    });
    await expect(runPrompt("boom")).rejects.toThrow(/provider exploded/);
    expect(offers).toEqual([{ signal: "turn_failed" }]);
  });
});
