import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { emptyUsage } from "./types.ts";

import type { CandidateInput, CandidateResult } from "./types.ts";

const RESULT_MARKER = "XIO_EVAL_RESULT=";

await main();

async function main(): Promise<void> {
  const [candidateRoot, fixtureRoot, trialHome, inputPath] = process.argv.slice(2);
  if (!candidateRoot || !fixtureRoot || !trialHome || !inputPath) {
    writeResult(infraResult("candidate child requires candidate, fixture, home, and input"));
    return;
  }
  try {
    const input = decodeCandidateInput(JSON.parse(await readFile(inputPath, "utf8")) as unknown);
    const result = input.mode === "stub"
      ? await runStub(candidateRoot, fixtureRoot, trialHome, input)
      : await runReal(candidateRoot, fixtureRoot, trialHome, input);
    writeResult(result);
  } catch (error) {
    writeResult(infraResult(error instanceof Error ? error.message : String(error)));
  }
}

async function runStub(
  candidateRoot: string,
  fixtureRoot: string,
  trialHome: string,
  input: Extract<CandidateInput, { mode: "stub" }>,
): Promise<CandidateResult> {
  const started = Date.now();
  const sandboxModule = await importCandidate(candidateRoot, "extensions/xio-sandbox/src/worktree-sandbox.ts");
  const Sandbox = requiredExport(sandboxModule, "WorktreeSandbox") as {
    create: (options: Record<string, unknown>) => Promise<{ worktreePath: string }>;
  };
  const session = await Sandbox.create({
    mainRoot: fixtureRoot,
    baseDir: path.join(trialHome, ".xiocode", "worktrees"),
    sessionId: `eval-${input.case_id}`.slice(0, 40),
  });
  await writeFiles(session.worktreePath, input.oracle_files);
  return {
    schema_version: "xio-eval-candidate.v1",
    status: "completed",
    worktree_path: session.worktreePath,
    provider: "stub",
    model: "deterministic-oracle",
    agent_ms: Date.now() - started,
    turns: 0,
    tool_calls: 0,
    tool_errors: 0,
    system_prompt_sha: null,
    usage: emptyUsage(),
  };
}

async function runReal(
  candidateRoot: string,
  fixtureRoot: string,
  trialHome: string,
  input: Extract<CandidateInput, { mode: "real" }>,
): Promise<CandidateResult> {
  const started = Date.now();
  const api = await loadCandidateApi(candidateRoot);
  const prepared = await prepareCandidateSession(
    api,
    candidateRoot,
    fixtureRoot,
    trialHome,
    input.max_turns,
  );
  if (input.provider && input.model) {
    const desired = {
      provider: input.provider,
      id: input.model,
      name: input.model,
      api: prepared.session.model.api ?? "openai-completions",
    };
    if (prepared.session.model.provider !== desired.provider || prepared.session.model.id !== desired.id) {
      await prepared.session.setModel(desired);
    }
  }
  let promptResult: RuntimePromptResult;
  let systemPrompt = "";
  try {
    promptResult = await prepared.session.runPrompt(input.prompt);
    systemPrompt = prepared.session.host.createContext().getSystemPrompt?.() ?? "";
  } finally {
    // Keep the candidate worktree for the trusted out-of-tree grader. Session close
    // finalizes MergeGate and removes clean/ancestor worktrees; trial root cleanup
    // owns deletion after grading.
    await prepared.session.host.emit("session_end", {}).catch(() => undefined);
  }
  const runId = await findRunId(prepared.runRoot);
  return {
    schema_version: "xio-eval-candidate.v1",
    status: promptResult.success ? "completed" : "agent_failure",
    worktree_path: prepared.launch.worktree?.worktreePath,
    run_id: runId,
    provider: prepared.session.model.provider,
    model: prepared.session.model.id,
    agent_ms: Date.now() - started,
    turns: promptResult.turns ?? 0,
    tool_calls: promptResult.toolCalls ?? 0,
    tool_errors: promptResult.toolErrors ?? 0,
    system_prompt_sha: hashText(systemPrompt),
    usage: promptResult.usage ? toEvalUsage(promptResult.usage) : emptyUsage(),
  };
}

async function loadCandidateApi(candidateRoot: string): Promise<CandidateApi> {
  const [cli, runtime, extension] = await Promise.all([
    importCandidate(candidateRoot, "src/cli/index.ts"),
    importCandidate(candidateRoot, "src/runtime/session.ts"),
    importCandidate(candidateRoot, "src/cli/xio-extension.ts"),
  ]);
  return {
    prepareLaunch: requiredFunction(cli, "prepareLaunch") as CandidateApi["prepareLaunch"],
    prepareSession: requiredFunction(runtime, "prepareSession") as CandidateApi["prepareSession"],
    registerExtension: requiredFunction(extension, "default") as CandidateApi["registerExtension"],
  };
}

async function prepareCandidateSession(
  api: CandidateApi,
  candidateRoot: string,
  fixtureRoot: string,
  trialHome: string,
  maxTurns: number,
): Promise<{ launch: RuntimeLaunch; session: RuntimeSession; runRoot: string }> {
  const env = isolatedEnv(trialHome);
  // Seed eval config so prepareLaunch prefers worktree mode when possible.
  await seedEvalWorktreeConfig(env);
  let launch = await api.prepareLaunch(fixtureRoot, env);
  const runRoot = path.join(trialHome, ".xiocode", "runs");

  // Trusted eval isolation is independent of the interactive direct-cwd default:
  // always leave a gradeable worktree under the trial root.
  if (!launch.worktree) {
    const sandboxModule = await importCandidate(
      candidateRoot,
      "extensions/xio-sandbox/src/worktree-sandbox.ts",
    );
    const Sandbox = requiredExport(sandboxModule, "WorktreeSandbox") as {
      create: (options: Record<string, unknown>) => Promise<RuntimeWorktreeSession>;
    };
    const worktree = await Sandbox.create({
      mainRoot: launch.mainRoot ?? fixtureRoot,
      baseDir: path.join(trialHome, ".xiocode", "worktrees"),
      sessionId: `eval-candidate`.slice(0, 40),
    });
    launch = {
      ...launch,
      cwd: worktree.worktreePath,
      worktree,
      runtimeConfig: {
        ...launch.runtimeConfig,
        worktree: {
          ...launch.runtimeConfig.worktree,
          enabled: true,
          retainOnReject: true,
          session: worktree,
        },
      },
      env: {
        ...launch.env,
        XIO_WORKTREE: worktree.worktreePath,
      },
    };
  }

  const runtimeConfig = {
    ...launch.runtimeConfig,
    general: { ...launch.runtimeConfig.general, runRoot },
    worktree: {
      ...launch.runtimeConfig.worktree,
      enabled: true,
      retainOnReject: true,
      session: launch.worktree,
    },
  };
  await writeFile(launch.runtimeConfigPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, "utf8");
  Object.assign(process.env, launch.env);
  const session = await api.prepareSession({
    cwd: launch.cwd,
    workspaceRoot: launch.cwd,
    runtimeConfig,
    env: launch.env,
    ask: async () => false,
    maxTurns,
    registerExtensions: async (extensionApi: unknown) => {
      process.env.XIO_RUNTIME_CONFIG = launch.runtimeConfigPath;
      await api.registerExtension(extensionApi);
    },
  });
  return { launch, session, runRoot };
}

/** Force `[worktree] enabled = true` in the trial config before prepareLaunch. */
async function seedEvalWorktreeConfig(env: NodeJS.ProcessEnv): Promise<void> {
  const configPath = env.XIO_CONFIG;
  if (!configPath) return;
  await mkdir(path.dirname(configPath), { recursive: true });
  let content = "";
  try {
    content = await readFile(configPath, "utf8");
  } catch {
    content = "";
  }
  if (content.length === 0) {
    // Minimal seed; prepareLaunch/ensureConfigFile keeps this file if present.
    // Include worktree-on so eval never inherits the interactive direct-cwd default.
    content = [
      "[general]",
      'default_provider = "deepseek"',
      'default_model = "deepseek-chat"',
      "",
      "[worktree]",
      "enabled = true",
      "retain_on_reject = true",
      "",
    ].join("\n");
    await writeFile(configPath, content, "utf8");
    return;
  }
  if (/\[worktree\]/.test(content)) {
    content = content.replace(/(enabled\s*=\s*)false/g, "$1true");
    if (!/enabled\s*=/.test(content.match(/\[worktree\][\s\S]*?(?=\n\[|$)/)?.[0] ?? "")) {
      content = content.replace("[worktree]", "[worktree]\nenabled = true");
    }
  } else {
    content = `${content.trimEnd()}\n\n[worktree]\nenabled = true\nretain_on_reject = true\n`;
  }
  await writeFile(configPath, content, "utf8");
}

function isolatedEnv(trialHome: string): NodeJS.ProcessEnv {
  const xioHome = path.join(trialHome, ".xiocode");
  return {
    ...process.env,
    HOME: trialHome,
    XIO_HOME: xioHome,
    XIO_CONFIG: path.join(xioHome, "config.toml"),
  };
}

async function importCandidate(candidateRoot: string, relativePath: string): Promise<Record<string, unknown>> {
  const target = path.join(candidateRoot, relativePath);
  return import(`${pathToFileURL(target).href}?eval=${Date.now()}`) as Promise<Record<string, unknown>>;
}

async function writeFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.resolve(root, relativePath);
    if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) {
      throw new Error(`oracle path escapes worktree: ${relativePath}`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

async function findRunId(runRoot: string): Promise<string | undefined> {
  const entries = await readdir(runRoot, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().at(-1);
}

function decodeCandidateInput(value: unknown): CandidateInput {
  const input = asRecord(value, "candidate input");
  if (input.schema_version !== "xio-eval-candidate-input.v1") {
    throw new Error(`unsupported candidate input schema: ${String(input.schema_version)}`);
  }
  if ((input.mode !== "real" && input.mode !== "stub")
    || typeof input.case_id !== "string" || typeof input.prompt !== "string") {
    throw new Error("candidate input requires mode, case_id, and prompt");
  }
  if (!Number.isInteger(input.max_turns) || Number(input.max_turns) <= 0) {
    throw new Error("candidate input max_turns must be a positive integer");
  }
  if (input.mode === "stub" && !isStringRecord(input.oracle_files)) {
    throw new Error("stub candidate input requires oracle_files");
  }
  if (input.mode === "real") {
    assertOptionalString(input.provider, "candidate input provider");
    assertOptionalString(input.model, "candidate input model");
  }
  return value as CandidateInput;
}

function assertOptionalString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${label} must be a string or absent`);
  }
}

function requiredExport(module: Record<string, unknown>, name: string): unknown {
  const value = module[name];
  if (value === undefined) {
    throw new Error(`candidate module is missing export: ${name}`);
  }
  return value;
}

function requiredFunction(module: Record<string, unknown>, name: string): (...args: never[]) => unknown {
  const value = requiredExport(module, name);
  if (typeof value !== "function") {
    throw new Error(`candidate export is not a function: ${name}`);
  }
  return value as (...args: never[]) => unknown;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((item) => typeof item === "string"));
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toEvalUsage(usage: RuntimePromptResult["usage"]): CandidateResult["usage"] {
  return {
    input_tokens: usage?.inputTokens ?? null,
    output_tokens: usage?.outputTokens ?? null,
    cache_tokens: usage?.cacheTokens ?? null,
    reasoning_tokens: usage?.reasoningTokens ?? null,
    estimated_cost_usd: null,
  };
}

function infraResult(error: string): CandidateResult {
  return {
    schema_version: "xio-eval-candidate.v1",
    status: "infra_error",
    provider: null,
    model: null,
    agent_ms: 0,
    turns: 0,
    tool_calls: 0,
    tool_errors: 0,
    system_prompt_sha: null,
    usage: emptyUsage(),
    error,
  };
}

function writeResult(result: CandidateResult): void {
  process.stdout.write(`${RESULT_MARKER}${JSON.stringify(result)}\n`);
}

type RuntimeWorktreeSession = {
  worktreePath: string;
  mainRoot?: string;
  branch?: string;
  sessionId?: string;
  [key: string]: unknown;
};

type RuntimeLaunch = {
  cwd: string;
  mainRoot?: string;
  runtimeConfigPath: string;
  env: NodeJS.ProcessEnv;
  worktree?: RuntimeWorktreeSession;
  runtimeConfig: { general: { runRoot: string }; worktree: Record<string, unknown> };
};

type CandidateApi = {
  prepareLaunch: (fixtureRoot: string, env: NodeJS.ProcessEnv) => Promise<RuntimeLaunch>;
  prepareSession: (options: Readonly<{
    cwd: string;
    workspaceRoot: string;
    runtimeConfig: RuntimeLaunch["runtimeConfig"];
    env: NodeJS.ProcessEnv;
    ask: () => Promise<boolean>;
    maxTurns: number;
    registerExtensions: (api: unknown) => Promise<void>;
  }>) => Promise<RuntimeSession>;
  registerExtension: (api: unknown) => Promise<void> | void;
};

type RuntimePromptResult = {
  success: boolean;
  turns?: number;
  toolCalls?: number;
  toolErrors?: number;
  usage?: {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheTokens: number | null;
    reasoningTokens: number | null;
  };
};

type RuntimeSession = {
  model: { provider: string; id: string; api?: string };
  host: {
    createContext: () => { getSystemPrompt?: () => string };
    emit: (event: string, payload?: unknown) => Promise<unknown>;
  };
  runPrompt: (prompt: string) => Promise<RuntimePromptResult>;
  setModel: (model: { provider: string; id: string; name: string; api: string }) => Promise<void>;
  close: () => Promise<void>;
};
