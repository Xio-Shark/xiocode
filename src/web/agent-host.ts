/**
 * Runs real agent sessions for the web console.
 *
 * Sessions start the same way the CLI starts them (`launchStoredSession` →
 * `createLaunchSessionOptions` → `prepareSession`). The kernel binding is
 * process-wide, so the console hosts one live session at a time: switching to
 * another session closes the previous one, and a session that is running
 * refuses a second prompt. The session lease keeps the TUI and the web console
 * from driving the same session at once.
 *
 * Permission questions are pushed to the browser (`web.approval`) and answered
 * through `answerApproval`; with no browser listening they are denied, never
 * left hanging.
 */

import { WorktreeSandbox } from "../../extensions/xio-sandbox/src/worktree-sandbox.ts";
import { createLaunchSessionOptions, launchStoredSession } from "../cli/run-agent-cli.ts";
import { prepareSession, type PreparedSession } from "../runtime/session.ts";
import { recoverStoredSession } from "../runtime/session-recovery.ts";
import type { InteractiveIO } from "../runtime/interactive-io.ts";
import type { PermissionMode } from "../runtime/permission-mode.ts";
import type { SessionStore, StoredSession } from "../runtime/session-store.ts";
import type { SessionUiSink } from "../runtime/session-ui.ts";

export type WebEvent = Readonly<{ event: string; payload: Readonly<Record<string, unknown>> }>;

export type AgentHostOptions = Readonly<{
  cwd: string;
  env: NodeJS.ProcessEnv;
  store: SessionStore;
  /** Pushes an event to the browsers watching `sessionId`; returns how many received it. */
  broadcast: (sessionId: string, event: WebEvent) => number;
}>;

export class AgentHostBusyError extends Error {}

type ActiveSession = {
  sessionId: string;
  prepared: PreparedSession;
  releaseLease: () => Promise<void>;
  unsubscribe: () => void;
  running: boolean;
};

/** A browser's answer: yes/no for questions, the picked value for choices. */
export type ApprovalAnswer = Readonly<{ approve: boolean; value?: string }>;

type PendingApproval = Readonly<{ sessionId: string; resolve: (answer: ApprovalAnswer) => void }>;

export class WebAgentHost {
  readonly #options: AgentHostOptions;
  #active: ActiveSession | undefined;
  #switching: Promise<ActiveSession> | undefined;
  readonly #approvals = new Map<string, PendingApproval>();
  #approvalSeq = 0;
  /** Chosen in the console; applied to the live session and to the next one opened. */
  #permissionMode: PermissionMode | undefined;

  constructor(options: AgentHostOptions) {
    this.#options = options;
  }

  get activeSessionId(): string | undefined {
    return this.#active?.sessionId;
  }

  get permissionMode(): PermissionMode | undefined {
    return this.#active?.prepared.getPermissionMode() ?? this.#permissionMode;
  }

  setPermissionMode(mode: PermissionMode): PermissionMode {
    this.#permissionMode = mode;
    return this.#active?.prepared.setPermissionMode(mode) ?? mode;
  }

  isRunning(sessionId: string): boolean {
    return this.#active?.sessionId === sessionId && this.#active.running;
  }

  /** Starts a turn in the background; progress arrives as runtime events. */
  async prompt(sessionId: string, text: string): Promise<void> {
    if (this.#active?.running) {
      throw new AgentHostBusyError(this.#active.sessionId === sessionId
        ? "this session is already running a turn; wait for it or abort it"
        : `session ${this.#active.sessionId} is running a turn; wait for it or abort it first`);
    }
    const active = await this.#ensure(sessionId);
    active.running = true;
    void active.prepared.runPrompt(text).then(
      (result) => {
        this.#emit(sessionId, "web.turn_end", {
          success: result.success,
          cancelled: result.cancelled === true,
          turns: result.turns,
          toolCalls: result.toolCalls,
          toolErrors: result.toolErrors,
          usage: result.usage,
        });
      },
      (error: unknown) => {
        this.#emit(sessionId, "web.error", { message: errorText(error) });
      },
    ).finally(() => {
      active.running = false;
      this.#emit(sessionId, "web.idle", {});
    });
  }

  abort(sessionId: string): boolean {
    if (this.#active?.sessionId !== sessionId || !this.#active.running) return false;
    this.#denyApprovals(sessionId);
    this.#active.prepared.abortTurn();
    return true;
  }

  answerApproval(sessionId: string, approvalId: string, answer: ApprovalAnswer): boolean {
    const pending = this.#approvals.get(approvalId);
    if (!pending || pending.sessionId !== sessionId) return false;
    this.#approvals.delete(approvalId);
    pending.resolve(answer);
    return true;
  }

  async close(): Promise<void> {
    await this.#closeActive();
  }

  async #ensure(sessionId: string): Promise<ActiveSession> {
    if (this.#active?.sessionId === sessionId) return this.#active;
    if (this.#switching) await this.#switching.catch(() => undefined);
    if (this.#active?.sessionId === sessionId) return this.#active;
    const opening = this.#open(sessionId);
    this.#switching = opening;
    try {
      return await opening;
    } finally {
      this.#switching = undefined;
    }
  }

  async #open(sessionId: string): Promise<ActiveSession> {
    await this.#closeActive();
    const { cwd, env, store } = this.#options;
    const releaseLease = await store.acquireLease(sessionId);
    try {
      const stored = await loadIfExists(store, sessionId);
      const recovered = recoverStoredSession(stored);
      const launch = await launchStoredSession({
        cwd,
        env,
        sessionId,
        recovered,
        gitRoot: await WorktreeSandbox.tryResolveMainRoot(cwd),
      });
      const options = createLaunchSessionOptions({ launch, store, stored, recovered, sessionId });
      const interactive = this.#interactive(sessionId);
      const prepared = await prepareSession({
        ...options,
        uiSink: this.#sink(sessionId),
        interactive,
        ask: (question) => interactive.ask(question),
      });
      if (this.#permissionMode) prepared.setPermissionMode(this.#permissionMode);
      const bus = prepared.host.getRuntimeEvents();
      const unsubscribe = bus
        ? bus.subscribe((event) => {
          this.#options.broadcast(sessionId, event);
        })
        : () => undefined;
      this.#active = { sessionId, prepared, releaseLease, unsubscribe, running: false };
      return this.#active;
    } catch (error) {
      await releaseLease();
      throw error;
    }
  }

  async #closeActive(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    this.#active = undefined;
    this.#denyApprovals(active.sessionId);
    if (active.running) active.prepared.abortTurn();
    active.unsubscribe();
    try {
      await active.prepared.close();
    } finally {
      await active.releaseLease();
    }
  }

  #sink(sessionId: string): SessionUiSink {
    return {
      notify: (message, level) => {
        this.#emit(sessionId, "web.notice", { message, level: level ?? "info" });
      },
    };
  }

  #interactive(sessionId: string): InteractiveIO {
    return {
      ask: async (question, detail) => (await this.#askBrowser(sessionId, { question, ...(detail ? { detail } : {}) })).approve,
      select: async (question, choices) => {
        const answer = await this.#askBrowser(sessionId, { question, choices: choices.map((c) => ({ ...c })) });
        return answer.approve ? answer.value : undefined;
      },
      // Free-text prompts (/connect) are TUI-only for now.
      prompt: async () => undefined,
    };
  }

  #askBrowser(sessionId: string, payload: Record<string, unknown>): Promise<ApprovalAnswer> {
    return new Promise<ApprovalAnswer>((resolve) => {
      const id = `approval-${++this.#approvalSeq}`;
      this.#approvals.set(id, { sessionId, resolve });
      if (this.#emit(sessionId, "web.approval", { id, ...payload }) === 0) {
        this.#approvals.delete(id);
        this.#emit(sessionId, "web.notice", {
          message: `Denied "${String(payload.question).trim()}": no browser is connected to answer it.`,
          level: "warning",
        });
        resolve({ approve: false });
      }
    });
  }

  #denyApprovals(sessionId: string): void {
    for (const [id, pending] of this.#approvals) {
      if (pending.sessionId !== sessionId) continue;
      this.#approvals.delete(id);
      pending.resolve({ approve: false });
    }
  }

  #emit(sessionId: string, event: string, payload: Record<string, unknown>): number {
    return this.#options.broadcast(sessionId, { event, payload });
  }
}

async function loadIfExists(store: SessionStore, sessionId: string): Promise<StoredSession | undefined> {
  const known = (await store.list()).some((session) => session.id === sessionId);
  return known ? store.load(sessionId) : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
