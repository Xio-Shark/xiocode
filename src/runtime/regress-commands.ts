import {
  InvalidRegressionCaseError,
  RegressionCapture,
  RegressionCaseStore,
  RegressionPreflight,
} from "../../extensions/xio-regress/src/index.ts";
import {
  DEFAULT_FAILURE_TYPE,
  VERIFIER_TEMPLATE_COMMANDS,
} from "../cli/regress-cli.ts";
import { choicesFromLabels } from "./interactive-io.ts";

import type { ExtensionHost } from "./extension-host.ts";
import type { InteractiveIO } from "./interactive-io.ts";
import type { SessionUiSink } from "./session-ui.ts";
import type { RegressionCaseStore as CaseStore } from "../../extensions/xio-regress/src/case-store.ts";

export type RegressCommandOptions = Readonly<{
  host: ExtensionHost;
  interactive: InteractiveIO;
  sink: SessionUiSink;
  getRunId: () => Promise<string | undefined> | string | undefined;
  runRoot: string;
  env?: NodeJS.ProcessEnv;
  store?: CaseStore;
  now?: () => Date;
}>;

export type CapturePromptInput = Readonly<{
  /** Prefer this run id over getRunId() when set. */
  runId?: string;
  failure?: string;
  verify?: string;
  /** Drafted statement; confirmed via ask before capture (Esc/decline ≠ accept). */
  draftFailure?: string;
}>;

/**
 * Session slash command: capture a private case from the current run with minimal prompts.
 */
export function registerRegressCommands(options: RegressCommandOptions): void {
  options.host.registerCommand("regress", {
    description: "Capture a private regression from the current run (then auto-preflight).",
    handler: async (args) => runRegressCommand(options, typeof args === "string" ? args : ""),
  });
}

async function runRegressCommand(options: RegressCommandOptions, rawArgs: string): Promise<string> {
  const parsed = parseSlashArgs(rawArgs);
  return promptAndCaptureRegression(options, parsed);
}

/**
 * Shared write path for `/regress` and failure-signal offer capture.
 * Always requires an explicit failure statement + verifier (human verdict).
 */
export async function promptAndCaptureRegression(
  options: RegressCommandOptions,
  input: CapturePromptInput = {},
): Promise<string> {
  const runId = input.runId ?? await options.getRunId();
  if (!runId || runId === "none") {
    throw new Error("No current run. Send a prompt first, or use: xio regress capture --last ...");
  }

  let failure = input.failure;
  if (!failure && input.draftFailure) {
    // Prefer ask over "blank keeps draft": TUI/readline map Esc and empty Enter to
    // undefined, so blank-keep would also treat Esc as accept (fails human verdict).
    const acceptDraft = await options.interactive.ask(
      "Accept drafted failure statement?",
      input.draftFailure,
    );
    if (acceptDraft) {
      failure = input.draftFailure;
    }
  }
  if (!failure) {
    const answered = await options.interactive.prompt("Failure statement (what went wrong)");
    failure = answered?.trim();
  }
  if (!failure) return "regress cancelled";

  let verify = input.verify;
  if (!verify) {
    const labels = [...VERIFIER_TEMPLATE_COMMANDS, "custom"];
    const picked = await options.interactive.select("Verifier command", choicesFromLabels(labels));
    if (!picked) return "regress cancelled";
    if (picked === "custom") {
      verify = await options.interactive.prompt("Custom verifier command");
    } else {
      verify = picked;
    }
  }
  if (!verify) return "regress cancelled";

  return persistCapturedRegression(options, {
    runId,
    failure,
    verify,
  });
}

export async function persistCapturedRegression(
  options: RegressCommandOptions,
  input: Readonly<{ runId: string; failure: string; verify: string }>,
): Promise<string> {
  const env = options.env ?? process.env;
  const store = options.store ?? new RegressionCaseStore(env.XIO_REGRESSION_ROOT);
  try {
    const capture = await new RegressionCapture({
      run_root: options.runRoot,
      store,
      now: options.now,
    }).capture({
      run_id: input.runId,
      failure_type: DEFAULT_FAILURE_TYPE,
      failure_statement: input.failure,
      verifier_command: input.verify,
    });
    const preflight = await new RegressionPreflight({ store, env }).run(capture.case.case_id);
    const message =
      `Captured ${capture.case.case_id} from run ${input.runId}; preflight=${preflight.status}`;
    options.sink.notify?.(message, preflight.status === "BASE_RED" ? "info" : "warning");
    return [
      message,
      `case_path=${capture.case_path}`,
      preflight.concerns.length > 0 ? `concerns=${preflight.concerns.join(",")}` : undefined,
    ].filter(Boolean).join("\n");
  } catch (error) {
    if (error instanceof InvalidRegressionCaseError) {
      throw new Error(error.message);
    }
    throw error;
  }
}

function parseSlashArgs(raw: string): CapturePromptInput {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const verifyMatch = trimmed.match(/--verify(?:\s+|=)(.+)$/);
  if (verifyMatch) {
    const before = trimmed.slice(0, verifyMatch.index).trim();
    return {
      failure: stripQuotes(before) || undefined,
      verify: stripQuotes(verifyMatch[1] ?? ""),
    };
  }
  if (trimmed.startsWith("--verify")) {
    return { verify: stripQuotes(trimmed.replace(/^--verify(?:\s+|=)?/, "")) };
  }
  return { failure: stripQuotes(trimmed) };
}

function stripQuotes(value: string): string {
  const text = value.trim();
  if (
    (text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}
