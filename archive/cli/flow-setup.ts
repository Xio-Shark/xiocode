import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateFlow, type FlowConfig } from "../../xio-flow/src/index.ts";

export type FlowSetupOptions = Readonly<{
  write?: (chunk: string) => void;
  cwd?: string;
}>;

const HELP = `xio-setup flow — native Task Flow (DAG) orchestration & validation

Usage:
  xio-setup flow                Show status of project .xio/flow.json
  xio-setup flow init [--force] Initialize a starter .xio/flow.json pipeline
  xio-setup flow validate       Validate DAG topology, circular deps, and write_scope conflicts
  xio-setup flow plan           Preview wave-by-wave execution order and concurrency
  xio-setup flow help           This help

Tasks in .xio/flow.json support 'depends_on' (DAG dependencies) and
'write_scope' (automatic conflict detection for concurrent tasks).
`;

const STARTER_FLOW: FlowConfig = {
  version: "1.0",
  name: "project-pipeline",
  max_concurrency: 4,
  tasks: [
    {
      id: "lint-and-typecheck",
      name: "Static Checks",
      write_scope: [],
      command: "npm run check",
    },
    {
      id: "build-backend",
      name: "Build Runtime",
      depends_on: ["lint-and-typecheck"],
      write_scope: ["src/runtime/**", "dist/runtime/**"],
    },
    {
      id: "build-frontend",
      name: "Build Web Surface",
      depends_on: ["lint-and-typecheck"],
      write_scope: ["src/web/**", "dist/web/**"],
    },
    {
      id: "e2e-verify",
      name: "End-to-End Verification",
      depends_on: ["build-backend", "build-frontend"],
      write_scope: ["test/**"],
      command: "npm test",
    },
  ],
};

export async function runFlowSetupCommand(
  args: readonly string[],
  options: FlowSetupOptions = {},
): Promise<number> {
  const write = options.write ?? ((chunk: string) => process.stdout.write(chunk));
  const root = options.cwd ?? process.cwd();
  const flowDir = path.join(root, ".xio");
  const flowPath = path.join(flowDir, "flow.json");

  const [sub, ...flags] = args;

  if (sub === "help" || sub === "--help" || sub === "-h") {
    write(HELP);
    return 0;
  }

  if (sub === undefined || sub === "status") {
    return handleStatus(flowPath, write);
  }

  if (sub === "init") {
    const force = flags.includes("--force");
    return handleInit(flowDir, flowPath, force, write);
  }

  if (sub === "validate") {
    return handleValidate(flowPath, write);
  }

  if (sub === "plan") {
    return handlePlan(flowPath, write);
  }

  write(`xio-setup: unknown flow subcommand: ${sub}\n\n${HELP}`);
  return 1;
}

async function handleStatus(flowPath: string, write: (chunk: string) => void): Promise<number> {
  try {
    await access(flowPath);
    const content = await readFile(flowPath, "utf8");
    const parsed = JSON.parse(content) as FlowConfig;
    write(`xio-setup flow: .xio/flow.json found (${parsed.tasks?.length ?? 0} tasks configured)\n`);
    write(`Pipeline: ${parsed.name ?? "unnamed"}\n`);
    write(`Max Concurrency: ${parsed.max_concurrency ?? "unlimited"}\n`);
    return 0;
  } catch {
    write("xio-setup flow: no .xio/flow.json found in current workspace.\n");
    write("Run 'xio-setup flow init' to create a starter DAG pipeline.\n");
    return 0;
  }
}

async function handleInit(
  flowDir: string,
  flowPath: string,
  force: boolean,
  write: (chunk: string) => void,
): Promise<number> {
  if (!force) {
    try {
      await access(flowPath);
      write(`xio-setup flow: ${flowPath} already exists. Use --force to overwrite.\n`);
      return 1;
    } catch {
      // does not exist, proceed
    }
  }

  await mkdir(flowDir, { recursive: true });
  await writeFile(flowPath, JSON.stringify(STARTER_FLOW, null, 2) + "\n", "utf8");
  write(`xio-setup flow: created starter flow template at ${flowPath}\n`);
  return 0;
}

async function handleValidate(flowPath: string, write: (chunk: string) => void): Promise<number> {
  let config: FlowConfig;
  try {
    const content = await readFile(flowPath, "utf8");
    config = JSON.parse(content) as FlowConfig;
  } catch (err) {
    write(`xio-setup flow: failed to read ${flowPath}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const result = validateFlow(config);
  if (!result.valid) {
    write("xio-setup flow: validation FAILED:\n");
    for (const error of result.errors) {
      write(`  - ERROR: ${error}\n`);
    }
    return 1;
  }

  write("xio-setup flow: validation PASSED (Valid DAG, 0 cycles)\n");
  if (result.warnings.length > 0) {
    write("Scope Warnings:\n");
    for (const warning of result.warnings) {
      write(`  - WARNING: ${warning}\n`);
    }
  } else {
    write("Write Scopes: No concurrent write conflicts detected across waves.\n");
  }

  return 0;
}

async function handlePlan(flowPath: string, write: (chunk: string) => void): Promise<number> {
  let config: FlowConfig;
  try {
    const content = await readFile(flowPath, "utf8");
    config = JSON.parse(content) as FlowConfig;
  } catch (err) {
    write(`xio-setup flow: failed to read ${flowPath}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const result = validateFlow(config);
  if (!result.valid) {
    write(`xio-setup flow: cannot generate plan, configuration invalid: ${result.errors.join("; ")}\n`);
    return 1;
  }

  write(`Execution Plan for "${config.name ?? "pipeline"}":\n`);
  const waves = result.waves ?? [];
  waves.forEach((wave, idx) => {
    write(`  Wave ${idx + 1} (${wave.length} task${wave.length > 1 ? "s in parallel" : ""}):\n`);
    for (const taskId of wave) {
      const task = config.tasks.find((t) => t.id === taskId);
      const scopes = task?.write_scope?.length ? ` [write: ${task.write_scope.join(", ")}]` : "";
      write(`    - ${taskId}${scopes}\n`);
    }
  });

  return 0;
}
