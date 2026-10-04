/**
 * Background commands (dev servers, watchers) as kernel services.
 *
 * Since kernel 0.7.0 a foreground command's leftovers are reaped when it ends,
 * so `nohup server >log 2>&1 &` no longer survives the bash call. A background
 * job is the supported way: the kernel supervises it (intent before spawn,
 * confirmed stop, adopted by crash recovery), it takes no workspace write lease,
 * its combined output goes to a log file, and the session stops it at the end.
 */

import fs from "node:fs";
import path from "node:path";

import type { ServiceHandle, ServiceSpec } from "@xioflow/kernel";

/** How long `start` waits for early output (or an early exit) before returning. */
const DEFAULT_SETTLE_MS = 1_500;
const STOP_GRACE_MS = 1_000;
const DEFAULT_TAIL_BYTES = 4_096;

export type BackgroundJobState = "running" | "exited" | "stopped" | "stop_unconfirmed";

export type BackgroundJobInfo = Readonly<{
  id: string;
  command: string;
  cwd: string;
  startedAt: string;
  state: BackgroundJobState;
  exit?: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;
  logPath: string;
  /** Kernel operation of the running instance (for /kernel and adjudication). */
  opId: string;
}>;

export type BackgroundJobsDeps = Readonly<{
  startService: (
    name: string,
    spec: Omit<ServiceSpec, "runId" | "artifactsDir" | "serviceId">,
  ) => Promise<ServiceHandle>;
  /** Final result status the kernel recorded for an operation; undefined while it has none. */
  operationOutcome: (opId: string) => string | undefined;
  logDir: string;
}>;

type Job = {
  info: Omit<BackgroundJobInfo, "state" | "exit" | "opId">;
  handle: ServiceHandle;
  state: BackgroundJobState;
  exit?: BackgroundJobInfo["exit"];
  log: fs.WriteStream;
};

export class BackgroundJobs {
  readonly #deps: BackgroundJobsDeps;
  readonly #jobs = new Map<string, Job>();
  #sequence = 0;

  constructor(deps: BackgroundJobsDeps) {
    this.#deps = deps;
  }

  /** Starts `command` under `/bin/sh -c`, stderr merged into stdout, and returns its first output. */
  async start(input: Readonly<{
    command: string;
    cwd: string;
    env: Readonly<Record<string, string>>;
    settleMs?: number;
  }>): Promise<Readonly<{ job: BackgroundJobInfo; output: string }>> {
    const id = `job-${++this.#sequence}`;
    fs.mkdirSync(this.#deps.logDir, { recursive: true, mode: 0o700 });
    const logPath = path.join(this.#deps.logDir, `${id}.log`);
    const log = fs.createWriteStream(logPath, { flags: "a", mode: 0o600 });
    let handle: ServiceHandle;
    try {
      handle = await this.#deps.startService(`bg-${id}`, {
        command: {
          execPath: "/bin/sh",
          args: ["-c", `exec 2>&1\n${input.command}`],
          cwd: input.cwd,
          envWhiteList: { ...input.env },
          inheritEnv: false,
        },
        readiness: "spawned",
        // A crashed dev server is reported, not silently restarted under the model.
        restart: "never",
        graceMs: STOP_GRACE_MS,
      });
    } catch (error) {
      log.end();
      throw error;
    }
    const job: Job = {
      info: { id, command: input.command, cwd: input.cwd, startedAt: new Date().toISOString(), logPath },
      handle,
      state: "running",
      log,
    };
    this.#jobs.set(id, job);
    handle.stdout.pipe(log);
    void handle.onInstanceExit.then((exit) => {
      if (job.state === "running") job.state = "exited";
      job.exit = { code: exit.exitCode, signal: exit.signal };
    });
    await handle.ready;
    await Promise.race([
      handle.onInstanceExit,
      new Promise((resolve) => setTimeout(resolve, input.settleMs ?? DEFAULT_SETTLE_MS).unref()),
    ]);
    return { job: this.#info(job), output: this.output(id) };
  }

  list(): readonly BackgroundJobInfo[] {
    return [...this.#jobs.values()].map((job) => this.#info(job));
  }

  get(id: string): BackgroundJobInfo | undefined {
    const job = this.#jobs.get(id);
    return job ? this.#info(job) : undefined;
  }

  /** The last `maxBytes` of the job's log (whole lines when the log is longer). */
  output(id: string, maxBytes = DEFAULT_TAIL_BYTES): string {
    const job = this.#require(id);
    let text: string;
    try {
      text = fs.readFileSync(job.info.logPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
    if (Buffer.byteLength(text) <= maxBytes) return text;
    const tail = Buffer.from(text).subarray(-maxBytes).toString("utf8");
    const newline = tail.indexOf("\n");
    return `[… earlier output in ${job.info.logPath}]\n${newline >= 0 ? tail.slice(newline + 1) : tail}`;
  }

  /** Confirmed stop through the kernel; a stop the kernel could not confirm is reported as such. */
  async stop(id: string): Promise<BackgroundJobInfo> {
    const job = this.#require(id);
    if (job.state === "running") {
      const opId = job.handle.currentInstanceOpId;
      await job.handle.stop(STOP_GRACE_MS);
      job.state = this.#deps.operationOutcome(opId) === "indeterminate" ? "stop_unconfirmed" : "stopped";
    }
    return this.#info(job);
  }

  /** Stops every running job; used when the session ends. Returns the jobs that could not be confirmed stopped. */
  async stopAll(): Promise<readonly BackgroundJobInfo[]> {
    const running = [...this.#jobs.values()].filter((job) => job.state === "running");
    const stopped = await Promise.all(running.map((job) => this.stop(job.info.id)));
    for (const job of this.#jobs.values()) job.log.end();
    return stopped.filter((info) => info.state === "stop_unconfirmed");
  }

  #require(id: string): Job {
    const job = this.#jobs.get(id);
    if (!job) {
      const known = [...this.#jobs.keys()];
      throw new Error(`no background job ${id}${known.length > 0 ? ` (known: ${known.join(", ")})` : ""}`);
    }
    return job;
  }

  #info(job: Job): BackgroundJobInfo {
    return {
      ...job.info,
      state: job.state,
      ...(job.exit ? { exit: job.exit } : {}),
      opId: job.handle.currentInstanceOpId,
    };
  }
}
