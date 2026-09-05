/**
 * `xio-setup` — zcf-style companion configurator.
 *
 * xio core stays minimal (general + providers). This CLI progressively adds
 * the optional config.toml sections from sections.ts: `list` shows what is
 * present, `add` appends sections idempotently, bare invocation opens an
 * interactive menu. Never touches API keys; never rewrites existing sections.
 */

import { ensureConfigFile } from "../../../src/cli/ensure-config.ts";
import { parseXioConfig } from "../../../src/cli/config-parser.ts";
import { writePrivateFile } from "../../../src/runtime/private-fs.ts";
import {
  applyConfigSections,
  CONFIG_SECTIONS,
  getConfigSection,
  hasConfigSection,
  listSectionStatus,
  removeConfigSections,
  type ConfigSectionId,
} from "./sections.ts";
import { runProviderCommand } from "./provider-setup.ts";
import { runTrellisCommand } from "./trellis-setup.ts";
import {
  distributeTemplates,
  getSetupTemplate,
  isWorkspaceRoot,
  planTemplates,
  SETUP_TEMPLATES,
  type SetupTemplate,
} from "./templates.ts";

export type SetupCliOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  write?: (chunk: string) => void;
  /** Interactive line source (menu); defaults to stdin readline when TTY. */
  ask?: (question: string) => Promise<string>;
  isTty?: boolean;
  /** Workspace root for `templates`; defaults to process.cwd(). */
  cwd?: string;
}>;

const HELP = `xio-setup — progressively enable optional XioCode config sections

Usage:
  xio-setup              Interactive menu (TTY) — pick sections to add
  xio-setup list         Show optional sections and whether config.toml has them
  xio-setup add <id...>  Append section(s) with safe defaults (idempotent)
  xio-setup add --all    Append every missing section
  xio-setup remove <id...>  Remove section(s) — only that table block is deleted
  xio-setup provider [id]   Add a provider from presets (keys stay in env vars)
  xio-setup templates       Show project starter templates (AGENTS.md, .trellis/spec)
  xio-setup templates add [id...] [--yes]  Write missing starters (confirm first)
  xio-setup flow            Native Task Flow (DAG) orchestration & validation (see: xio-setup flow help)
  xio-setup trellis         Trellis DAG config & update (see: xio-setup trellis help)
  xio-setup path         Print the config.toml path
  xio-setup help         This help

Sections are appended with the same defaults used when absent — adding one
never changes behavior until you edit its values. API keys stay in env vars.
`;

export async function runSetupCli(
  argv: readonly string[],
  options: SetupCliOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const write = options.write ?? ((chunk: string) => process.stdout.write(chunk));
  const [command, ...rest] = argv;

  if (command === "help" || command === "--help" || command === "-h") {
    write(HELP);
    return 0;
  }
  if (command === "path") {
    const { path } = await ensureConfigFile(env, { write });
    write(`${path}\n`);
    return 0;
  }
  if (command === "list") {
    const { content } = await ensureConfigFile(env, { write });
    write(formatSectionList(content));
    return 0;
  }
  if (command === "add") {
    return runAdd(rest, env, write);
  }
  if (command === "remove") {
    return runRemove(rest, env, write);
  }
  if (command === "provider") {
    const isTty = options.isTty ?? process.stdin.isTTY === true;
    return runProviderCommand(rest, env, write, options.ask, isTty);
  }
  if (command === "templates") {
    return runTemplates(rest, write, options);
  }
  if (command === "flow") {
    write("xio-setup: flow subcommand has been archived into archive/extensions/xio-flow (Route B: focus on core coding agent resilience).\n");
    return 0;
  }
  if (command === "trellis") {
    const isTty = options.isTty ?? process.stdin.isTTY === true;
    const trellisOptions = {
      write,
      isTty,
      ...(options.ask ? { ask: options.ask } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    };
    return runTrellisCommand(rest, trellisOptions);
  }
  if (command === undefined || command === "menu") {
    const isTty = options.isTty ?? process.stdin.isTTY === true;
    if (!options.ask && !isTty) {
      write(HELP);
      const { content } = await ensureConfigFile(env, { write });
      write(formatSectionList(content));
      return 0;
    }
    return runMenu(env, write, options.ask);
  }
  write(`xio-setup: unknown command: ${command}\n\n${HELP}`);
  return 1;
}

async function runAdd(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  write: (chunk: string) => void,
): Promise<number> {
  const { path, content } = await ensureConfigFile(env, { write });
  let ids: ConfigSectionId[];
  if (args.includes("--all")) {
    ids = listSectionStatus(content)
      .filter((status) => !status.present)
      .map((status) => status.section.id);
  } else {
    const unknown = args.filter((id) => !getConfigSection(id));
    if (unknown.length > 0) {
      write(`xio-setup: unknown section(s): ${unknown.join(", ")}\n`);
      write(`Known: ${CONFIG_SECTIONS.map((section) => section.id).join(" ")}\n`);
      return 1;
    }
    ids = args as ConfigSectionId[];
  }
  if (ids.length === 0) {
    write("xio-setup: nothing to add (already present or no ids given)\n");
    return 0;
  }
  const applied = await applyAndWrite(path, content, ids, write);
  return applied ? 0 : 1;
}

/** Remove sections surgically: only the target table blocks go; validate before writing. */
async function runRemove(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  write: (chunk: string) => void,
): Promise<number> {
  if (args.length === 0) {
    write("xio-setup: remove requires section id(s)\n");
    write(`Known: ${CONFIG_SECTIONS.map((section) => section.id).join(" ")}\n`);
    return 1;
  }
  const unknown = args.filter((id) => !getConfigSection(id));
  if (unknown.length > 0) {
    write(`xio-setup: unknown section(s): ${unknown.join(", ")}\n`);
    write(`Known: ${CONFIG_SECTIONS.map((section) => section.id).join(" ")}\n`);
    return 1;
  }
  const { path, content } = await ensureConfigFile(env, { write });
  const ids = args as ConfigSectionId[];
  const present = ids.filter((id) => hasConfigSection(content, id));
  const absent = ids.filter((id) => !hasConfigSection(content, id));
  if (absent.length > 0) {
    write(`not present (nothing to remove): ${absent.join(", ")}\n`);
  }
  if (present.length === 0) return 0;
  const next = removeConfigSections(content, present);
  try {
    parseXioConfig(next);
  } catch (error) {
    write(`xio-setup: refusing to write — config after removal fails to parse: ${String(error)}\n`);
    return 1;
  }
  await writePrivateFile(path, next);
  write(`removed: ${present.join(", ")} → ${path}\n`);
  return 0;
}

/** Distribute starter templates: workspace root only, allowlisted paths, confirm before write. */
async function runTemplates(
  args: readonly string[],
  write: (chunk: string) => void,
  options: SetupCliOptions,
): Promise<number> {
  const root = options.cwd ?? process.cwd();
  const [sub, ...restArgs] = args;
  if (sub === undefined || sub === "list") {
    const plan = await planTemplates(root, SETUP_TEMPLATES);
    write(formatTemplatePlan(root, plan.pending, plan.skippedExisting, plan.rejected));
    write("write missing: xio-setup templates add [id...] [--yes]\n");
    return 0;
  }
  if (sub !== "add") {
    write(`xio-setup: unknown templates subcommand: ${sub}\n`);
    return 1;
  }
  const yes = restArgs.includes("--yes");
  const ids = restArgs.filter((arg) => arg !== "--yes");
  let templates: readonly SetupTemplate[];
  if (ids.length === 0) {
    templates = SETUP_TEMPLATES;
  } else {
    const unknown = ids.filter((id) => !getSetupTemplate(id));
    if (unknown.length > 0) {
      write(`xio-setup: unknown template(s): ${unknown.join(", ")}\n`);
      write(`Known: ${SETUP_TEMPLATES.map((template) => template.id).join(" ")}\n`);
      return 1;
    }
    templates = ids.map((id) => getSetupTemplate(id)!);
  }
  if (!(await isWorkspaceRoot(root))) {
    write(`xio-setup: ${root} does not look like a workspace root (no .git/package.json/.trellis) — run from your project root.\n`);
    return 1;
  }
  const plan = await planTemplates(root, templates);
  write(formatTemplatePlan(root, plan.pending, plan.skippedExisting, plan.rejected));
  if (plan.pending.length === 0) {
    write("nothing to write.\n");
    return plan.rejected.length > 0 ? 1 : 0;
  }
  if (!yes) {
    const isTty = options.isTty ?? process.stdin.isTTY === true;
    if (!options.ask && !isTty) {
      write("xio-setup: refusing to write without confirmation — re-run with --yes or in a TTY.\n");
      return 1;
    }
    const { createInterface } = await import("node:readline/promises");
    const rl = options.ask
      ? undefined
      : createInterface({ input: process.stdin, output: process.stdout });
    const ask = options.ask ?? (async (question: string) => rl!.question(question));
    try {
      const answer = (await ask(`write ${plan.pending.length} file(s) into ${root}? [y/N]: `)).trim();
      if (!/^y(es)?$/i.test(answer)) {
        write("aborted — nothing written.\n");
        return 0;
      }
    } finally {
      rl?.close();
    }
  }
  const result = await distributeTemplates(root, templates);
  if (result.written.length > 0) {
    write(`written: ${result.written.join(", ")}\n`);
  }
  if (result.rejected.length > 0) {
    for (const entry of result.rejected) {
      write(`rejected: ${entry.template.relativePath} — ${entry.reason}\n`);
    }
    return 1;
  }
  return 0;
}

function formatTemplatePlan(
  root: string,
  pending: readonly SetupTemplate[],
  skippedExisting: readonly SetupTemplate[],
  rejected: readonly { template: SetupTemplate; reason: string }[],
): string {
  const lines = [`project templates (workspace: ${root}):`];
  for (const template of pending) {
    lines.push(`  · ${template.relativePath.padEnd(26, " ")} ${template.title}`);
  }
  for (const template of skippedExisting) {
    lines.push(`  ✓ ${template.relativePath.padEnd(26, " ")} exists — never overwritten`);
  }
  for (const entry of rejected) {
    lines.push(`  ✗ ${entry.template.relativePath.padEnd(26, " ")} rejected: ${entry.reason}`);
  }
  return `${lines.join("\n")}\n`;
}

async function runMenu(
  env: NodeJS.ProcessEnv,
  write: (chunk: string) => void,
  askOverride?: (question: string) => Promise<string>,
): Promise<number> {
  const { path, content: initial } = await ensureConfigFile(env, { write });
  let content = initial;
  const { createInterface } = await import("node:readline/promises");
  const rl = askOverride
    ? undefined
    : createInterface({ input: process.stdin, output: process.stdout });
  const ask = askOverride ?? (async (question: string) => rl!.question(question));
  try {
    write(`config: ${path}\n`);
    for (;;) {
      write(`\n${formatSectionList(content)}`);
      const answer = (await ask("add section [number/id], a = all missing, q = quit: ")).trim();
      if (answer === "q" || answer === "quit" || answer === "") {
        return 0;
      }
      let ids: ConfigSectionId[] = [];
      if (answer === "a" || answer === "all") {
        ids = listSectionStatus(content)
          .filter((status) => !status.present)
          .map((status) => status.section.id);
      } else {
        const byIndex = /^\d+$/.test(answer)
          ? CONFIG_SECTIONS[Number(answer) - 1]
          : undefined;
        const section = byIndex ?? getConfigSection(answer);
        if (!section) {
          write(`unknown section: ${answer}\n`);
          continue;
        }
        ids = [section.id];
      }
      if (ids.length === 0) {
        write("nothing missing — all sections present.\n");
        continue;
      }
      const applied = await applyAndWrite(path, content, ids, write);
      if (applied) content = applied;
    }
  } finally {
    rl?.close();
  }
}

/** Validate with the real parser before writing — a broken config.toml is worse than no-op. */
async function applyAndWrite(
  path: string,
  content: string,
  ids: readonly ConfigSectionId[],
  write: (chunk: string) => void,
): Promise<string | undefined> {
  const next = applyConfigSections(content, ids);
  if (next === content) {
    write(`already present: ${ids.join(", ")}\n`);
    return content;
  }
  try {
    parseXioConfig(next);
  } catch (error) {
    write(`xio-setup: refusing to write — merged config fails to parse: ${String(error)}\n`);
    return undefined;
  }
  await writePrivateFile(path, next);
  write(`added: ${ids.join(", ")} → ${path}\n`);
  return next;
}

export function formatSectionList(content: string): string {
  const rows = listSectionStatus(content).map((status, index) => {
    const mark = status.present ? "✓" : "·";
    const id = status.section.id.padEnd(14, " ");
    return ` ${String(index + 1).padStart(2, " ")}. ${mark} ${id} ${status.section.title}`;
  });
  return `optional sections (✓ = present in config.toml):\n${rows.join("\n")}\n`;
}
