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
  const runId = await options.getRunId();
  if (!runId || runId === "none") {
    throw new Error("No current run. Send a prompt first, or use: xio regress capture --last ...");
  }

  let failure = parsed.failure;
  if (!failure) {
    failure = await options.interactive.prompt("Failure statement (what went wrong)");
  }
  if (!failure) return "regress cancelled";

  let verify = parsed.verify;
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

  const env = options.env ?? process.env;
  const store = options.store ?? new RegressionCaseStore(env.XIO_REGRESSION_ROOT);
  try {
    const capture = await new RegressionCapture({
      run_root: options.runRoot,
      store,
      now: options.now,
    }).capture({
      run_id: runId,
      failure_type: DEFAULT_FAILURE_TYPE,
      failure_statement: failure,
      verifier_command: verify,
    });
    const preflight = await new RegressionPreflight({ store, env }).run(capture.case.case_id);
    const message =
      `Captured ${capture.case.case_id} from run ${runId}; preflight=${preflight.status}`;
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

function parseSlashArgs(raw: string): Readonly<{ failure?: string; verify?: string }> {
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
