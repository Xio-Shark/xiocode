#!/usr/bin/env node
/**
 * Seeds a throwaway environment for `xio web` screenshots: a git repository
 * with uncommitted edits (the diff view) and a session store whose sessions
 * exercise markdown, every tool family and a failed command.
 *
 * Nothing here reads the user's real sessions or config, so baseline shots
 * are reproducible and carry no personal paths.
 *
 *   node scripts/web-demo-fixture.ts <dir>
 *
 * Prints JSON: { repo, xioHome, config } for the caller to pass as cwd,
 * XIO_HOME and XIO_CONFIG.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SessionStore } from "../src/runtime/session-store.ts";
import { TIMELINE_FILE, hashPrompt, type TimelineRecord } from "../src/runtime/session-timeline.ts";
import type { ChatMessage } from "../src/runtime/types.ts";

const root = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  process.stderr.write("usage: web-demo-fixture.ts <dir>\n");
  process.exit(2);
}

const repo = path.join(root, "acme-api");
const xioHome = path.join(root, "xio-home");
const config = path.join(xioHome, "config.toml");

function git(...args: string[]): void {
  execFileSync("git", args, {
    cwd: repo,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "demo",
      GIT_AUTHOR_EMAIL: "demo@example.invalid",
      GIT_COMMITTER_NAME: "demo",
      GIT_COMMITTER_EMAIL: "demo@example.invalid",
    },
  });
}

function write(rel: string, content: string): void {
  const file = path.join(repo, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function seedRepo(): void {
  mkdirSync(repo, { recursive: true });
  git("init", "-q", "-b", "main");
  write("src/config.ts", [
    "export type Config = { port: number; theme?: string };",
    "",
    "export function parseConfig(raw: Record<string, unknown>): Config {",
    "  const port = Number(raw.port ?? 3000);",
    "  return { port, theme: raw.theme as string | undefined };",
    "}",
    "",
  ].join("\n"));
  write("src/server.ts", [
    "import { parseConfig } from \"./config.ts\";",
    "",
    "export function start(raw: Record<string, unknown>) {",
    "  const config = parseConfig(raw);",
    "  console.log(\"listening on\", config.port);",
    "}",
    "",
  ].join("\n"));
  write("README.md", "# acme-api\n\nSmall demo service.\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");

  write("src/config.ts", [
    "export type Theme = \"light\" | \"dark\" | \"system\";",
    "export type Config = { port: number; theme: Theme };",
    "",
    "const THEMES: readonly Theme[] = [\"light\", \"dark\", \"system\"];",
    "",
    "export function parseConfig(raw: Record<string, unknown>): Config {",
    "  const port = Number(raw.port ?? 3000);",
    "  if (!Number.isInteger(port) || port < 1 || port > 65535) {",
    "    throw new Error(`port must be 1-65535, got ${String(raw.port)}`);",
    "  }",
    "  const theme = (raw.theme ?? \"system\") as Theme;",
    "  if (!THEMES.includes(theme)) {",
    "    throw new Error(`theme must be one of ${THEMES.join(\", \")}`);",
    "  }",
    "  return { port, theme };",
    "}",
    "",
  ].join("\n"));
  write("src/config.test.ts", [
    "import { expect, it } from \"vitest\";",
    "import { parseConfig } from \"./config.ts\";",
    "",
    "it(\"rejects an unknown theme\", () => {",
    "  expect(() => parseConfig({ theme: \"neon\" })).toThrow(/theme must be/);",
    "});",
    "",
  ].join("\n"));
  // Intent-to-add: the new file shows up in `git diff` like the agent's other edits.
  git("add", "-N", "src/config.test.ts");
}

const ANSWER = [
  "改好了。`parseConfig` 现在会校验 `port` 和 `theme`，非法值直接抛错，不再静默回落。",
  "",
  "## 改动",
  "",
  "1. **`src/config.ts`**：新增 `Theme` 联合类型；`port` 必须是 1–65535 的整数。",
  "2. **`src/config.test.ts`**：补了一条未知主题的用例。",
  "",
  "| 输入 | 之前 | 现在 |",
  "| --- | --- | --- |",
  "| `port: \"abc\"` | `NaN` | 抛错 |",
  "| `theme: \"neon\"` | 原样透传 | 抛错 |",
  "",
  "```ts",
  "if (!THEMES.includes(theme)) {",
  "  throw new Error(`theme must be one of ${THEMES.join(\", \")}`);",
  "}",
  "```",
  "",
  "> 第一次跑测试失败是因为 `vitest` 没装，`npm install` 之后 **3 个用例全部通过**。",
].join("\n");

function mainSession(cwd: string): ChatMessage[] {
  return [
    { role: "user", content: "给 parseConfig 加上 port 和 theme 的校验，非法值要报错" },
    {
      role: "assistant",
      content: "先看一下现在的实现和调用方。",
      toolCalls: [
        { id: "c1", name: "read", arguments: { path: "src/config.ts" } },
        { id: "c2", name: "grep", arguments: { pattern: "parseConfig", path: "src" } },
      ],
    },
    { role: "tool", toolCallId: "c1", name: "read", content: "1\texport type Config = { port: number; theme?: string };\n2\t\n3\texport function parseConfig(raw: Record<string, unknown>): Config {\n4\t  const port = Number(raw.port ?? 3000);\n5\t  return { port, theme: raw.theme as string | undefined };\n6\t}" },
    { role: "tool", toolCallId: "c2", name: "grep", content: "src/server.ts:1:import { parseConfig } from \"./config.ts\";\nsrc/server.ts:4:  const config = parseConfig(raw);" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "c3", name: "edit", arguments: { path: "src/config.ts", old_string: "const port = Number(raw.port ?? 3000);", new_string: "const port = Number(raw.port ?? 3000);\n  if (!Number.isInteger(port) …" } },
        { id: "c4", name: "write", arguments: { path: "src/config.test.ts", content: "import { expect, it } from \"vitest\";\n…" } },
        { id: "c5", name: "bash", arguments: { command: "npx vitest run src/config.test.ts" } },
      ],
    },
    { role: "tool", toolCallId: "c3", name: "edit", content: "Edited src/config.ts (+12 −2)" },
    { role: "tool", toolCallId: "c4", name: "write", content: "Wrote src/config.test.ts (7 lines)" },
    { role: "tool", toolCallId: "c5", name: "bash", content: "exit_code=1\nsh: vitest: command not found" },
    {
      role: "assistant",
      content: "测试依赖没装，先装依赖再跑。",
      toolCalls: [{ id: "c6", name: "bash", arguments: { command: "npm install && npx vitest run" } }],
    },
    { role: "tool", toolCallId: "c6", name: "bash", content: "exit_code=0\n ✓ src/config.test.ts (3 tests) 4ms\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)" },
    { role: "assistant", content: ANSWER },
    { role: "user", content: FOLLOW_UP },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c7", name: "edit", arguments: { path: "README.md", old_string: "Small demo service.", new_string: "Small demo service.\n\n`theme`: light | dark | system" } }],
    },
    { role: "tool", toolCallId: "c7", name: "edit", content: "Edited README.md (+2)" },
    { role: "assistant", content: "README 已补上 `theme` 的取值说明。" },
  ].map((m) => ({ ...m })) as ChatMessage[];
}

const FOLLOW_UP = "顺便把 README 里的配置说明也更新一下";

/**
 * What the recorder would have written for mainSession: two parallel reads, a failed
 * test run, a retry, then a follow-up two hours later.
 */
function mainTimeline(t0: number): TimelineRecord[] {
  let seq = 0;
  const r = (sec: number, event: string, extra: Partial<TimelineRecord> = {}): TimelineRecord =>
    ({ at: new Date(t0 + sec * 1000).toISOString(), event, run: "demo", seq: seq++, ...extra });
  const usage = (input: number, output: number, cacheRead: number) =>
    ({ inputTokens: input, outputTokens: output, cacheTokens: null, cacheReadTokens: cacheRead, reasoningTokens: null });
  const later = 2 * 3600 + 14 * 60;
  return [
    r(0, "turn.start", { promptHash: hashPrompt("给 parseConfig 加上 port 和 theme 的校验，非法值要报错") }),
    r(0.3, "provider.request"), r(4.1, "provider.done", { usage: usage(5200, 140, 0) }),
    r(4.2, "tool.call", { toolCallId: "c1" }), r(4.2, "tool.call", { toolCallId: "c2" }),
    r(4.6, "tool.result", { toolCallId: "c1" }), r(5.3, "tool.result", { toolCallId: "c2" }),
    r(5.4, "provider.request"), r(13.8, "provider.done", { usage: usage(6100, 820, 4800) }),
    r(13.9, "tool.call", { toolCallId: "c3" }), r(14.2, "tool.result", { toolCallId: "c3" }),
    r(14.3, "tool.call", { toolCallId: "c4" }), r(14.5, "tool.result", { toolCallId: "c4" }),
    r(14.6, "tool.call", { toolCallId: "c5" }), r(17.9, "tool.error", { toolCallId: "c5" }),
    r(18.0, "provider.request"), r(20.6, "provider.done", { usage: usage(7300, 60, 5900) }),
    r(20.7, "tool.call", { toolCallId: "c6" }), r(39.5, "tool.result", { toolCallId: "c6" }),
    r(39.6, "provider.request"), r(48.2, "provider.done", { usage: usage(7900, 410, 7100) }),
    r(48.3, "turn.end", { outcome: "success" }),
    r(later, "turn.start", { promptHash: hashPrompt(FOLLOW_UP) }),
    r(later + 0.2, "provider.request"), r(later + 3.9, "provider.done", { usage: usage(8600, 120, 7800) }),
    r(later + 4.0, "tool.call", { toolCallId: "c7" }), r(later + 4.3, "tool.result", { toolCallId: "c7" }),
    r(later + 4.4, "provider.request"), r(later + 6.1, "provider.done", { usage: usage(8800, 40, 8500) }),
    r(later + 6.2, "turn.end", { outcome: "success" }),
  ];
}

async function seedSessions(): Promise<void> {
  const store = new SessionStore({ root: path.join(xioHome, "sessions") });
  const model = { provider: "deepseek", id: "deepseek-chat" };
  // The main session started 2.5 hours ago; its last turn ended just now.
  const t0 = Date.now() - (2 * 3600 + 14 * 60 + 7) * 1000;
  const sessions: Array<{ cwd: string; messages: ChatMessage[]; timeline?: TimelineRecord[]; createdAt?: string }> = [
    { cwd: path.join(root, "web-dashboard"), messages: [
      { role: "user", content: "把图表的颜色换成设计系统里的 token" },
      { role: "assistant", content: "已替换 6 处硬编码颜色。" },
    ] },
    { cwd: repo, messages: [
      { role: "user", content: "解释一下 server.ts 的启动流程" },
      { role: "assistant", content: "`start` 先调用 `parseConfig` 解析配置，然后打印监听端口。" },
    ] },
    { cwd: repo, messages: mainSession(repo), timeline: mainTimeline(t0), createdAt: new Date(t0).toISOString() },
  ];
  for (const s of sessions) {
    const id = store.createId();
    await store.save({ id, model, cwd: s.cwd, mainRoot: s.cwd, messages: s.messages, ...(s.createdAt ? { createdAt: s.createdAt } : {}) });
    if (s.timeline) await store.appendSideRecords(id, TIMELINE_FILE, s.timeline);
    // Distinct updated_at so the list order is stable.
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

seedRepo();
mkdirSync(xioHome, { recursive: true });
writeFileSync(config, "[general]\ndefault_provider = \"deepseek\"\ndefault_model = \"deepseek-chat\"\n");
await seedSessions();
process.stdout.write(JSON.stringify({ repo, xioHome, config }) + "\n");
