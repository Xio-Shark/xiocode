import os from "node:os";
import path from "node:path";

import { SessionStore } from "../runtime/session-store.ts";

import type { SessionMetadata, StoredSession } from "../runtime/session-store.ts";

export type ResumeRequest =
  | Readonly<{ action: "latest" }>
  | Readonly<{ action: "load"; id: string }>
  | Readonly<{ action: "list" }>
  | Readonly<{ action: "delete"; id: string }>;

export function parseResumeRequest(args: readonly string[]): Readonly<{
  request?: ResumeRequest;
  remaining: readonly string[];
}> {
  if (args[0] === "resume") {
    return { request: parseResumeSubcommand(args.slice(1)), remaining: [] };
  }
  if (args.includes("--continue")) {
    return { request: { action: "latest" }, remaining: args.filter((arg) => arg !== "--continue") };
  }
  return { remaining: args };
}

export function createSessionStore(env: NodeJS.ProcessEnv): SessionStore {
  const root = env.XIO_HOME ? expandHome(env.XIO_HOME) : path.join(os.homedir(), ".xiocode");
  return new SessionStore({ root: path.join(root, "sessions") });
}

export async function resolveResume(input: Readonly<{
  store: SessionStore;
  request?: ResumeRequest;
  mainRoot: string;
  select: (sessions: readonly SessionMetadata[]) => Promise<string | undefined>;
}>): Promise<StoredSession | undefined> {
  const request = input.request;
  if (!request) return undefined;
  if (request.action === "load") return input.store.load(request.id);
  if (request.action === "latest") {
    const latest = await input.store.latest(input.mainRoot);
    if (!latest) throw new Error(`no saved session found for ${input.mainRoot}`);
    return latest;
  }
  if (request.action === "delete") throw new Error("delete requests must be handled before launch");
  const sessions = (await input.store.list()).filter((session) => path.resolve(session.main_root) === path.resolve(input.mainRoot));
  if (sessions.length === 0) throw new Error(`no saved session found for ${input.mainRoot}`);
  const selected = await input.select(sessions);
  return selected ? input.store.load(selected) : undefined;
}

function parseResumeSubcommand(args: readonly string[]): ResumeRequest {
  if (args.length === 0) return { action: "latest" };
  if (args[0] === "--list" && args.length === 1) return { action: "list" };
  if (args[0] === "--delete" && args.length === 2 && args[1]) return { action: "delete", id: args[1] };
  if (args.length === 1 && args[0] && !args[0].startsWith("-")) return { action: "load", id: args[0] };
  throw new Error("usage: xio resume [session-id | --list | --delete session-id]");
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}
