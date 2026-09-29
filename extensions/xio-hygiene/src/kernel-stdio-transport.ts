/**
 * MCP stdio transport on a kernel service: the server process is a supervised
 * operation (intent recorded before spawn, stderr bounded and spilled by the
 * kernel, stop confirmed by the driver, adopted by crash recovery).
 *
 * Framing and serialization are the SDK's own (`ReadBuffer`/`serializeMessage`);
 * shutdown follows the SDK stdio transport: close stdin, give the server a
 * moment to exit, then the kernel's confirmed stop pipeline.
 */

import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { ServiceHandle } from "@xioflow/kernel";

import type { KernelSession } from "../../../src/runtime/process/index.ts";

/**
 * Close budget: the MCP bridge bounds a whole close at 1.5s, so the server gets
 * 500ms to exit on stdin EOF, then a 500ms SIGTERM grace before SIGKILL.
 */
const STDIN_CLOSE_GRACE_MS = 500;
const STOP_GRACE_MS = 500;

export type KernelStdioServer = Readonly<{
  name: string;
  command: string;
  args: readonly string[];
  cwd: string;
  /** Complete child environment (the kernel never merges the host env). */
  env: Readonly<Record<string, string>>;
}>;

export class KernelStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  readonly #session: KernelSession;
  readonly #server: KernelStdioServer;
  readonly #readBuffer = new ReadBuffer();
  #handle: ServiceHandle | undefined;
  #closed = false;

  constructor(session: KernelSession, server: KernelStdioServer) {
    this.#session = session;
    this.#server = server;
  }

  async start(): Promise<void> {
    if (this.#handle) {
      throw new Error("KernelStdioTransport already started");
    }
    const handle = await this.#session.startService(`mcp-${this.#server.name}`, {
      command: {
        execPath: this.#server.command,
        args: [...this.#server.args],
        cwd: this.#server.cwd,
        envWhiteList: { ...this.#server.env },
        inheritEnv: false,
        stdinMode: "stream",
      },
      readiness: "spawned",
      // A restarted server has lost the client's MCP session; let the client reconnect instead.
      restart: "never",
      graceMs: STOP_GRACE_MS,
    });
    this.#handle = handle;
    handle.stdout.on("data", (chunk: Buffer) => {
      try {
        this.#readBuffer.append(chunk);
        this.#drain();
      } catch (error) {
        this.onerror?.(toError(error));
        void this.close();
      }
    });
    handle.stdout.on("error", (error: Error) => this.onerror?.(error));
    handle.stdin.on("error", (error: Error) => this.onerror?.(error));
    void handle.onInstanceExit.then(() => this.#finish());
    await handle.ready;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.#handle?.stdin;
    if (!stdin || this.#closed) {
      throw new Error("Not connected");
    }
    const json = serializeMessage(message);
    await new Promise<void>((resolve) => {
      if (stdin.write(json)) resolve();
      else stdin.once("drain", () => resolve());
    });
  }

  async close(): Promise<void> {
    const handle = this.#handle;
    if (!handle || this.#closed) return;
    try {
      handle.stdin.end();
    } catch {
      // Already closed by the server exiting; the stop below still confirms it.
    }
    const exited = await Promise.race([
      handle.onInstanceExit.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), STDIN_CLOSE_GRACE_MS).unref()),
    ]);
    if (!exited) {
      await handle.stop(STOP_GRACE_MS);
    }
    this.#finish();
  }

  /**
   * Immediate confirmed stop, for a server that hangs during connect or close.
   * Joins a stop already in progress; resolves once the kernel recorded it.
   */
  async forceStop(): Promise<void> {
    const handle = this.#handle;
    if (!handle) return;
    try {
      await handle.stop(0);
    } finally {
      this.#finish();
    }
  }

  #drain(): void {
    while (true) {
      let message: JSONRPCMessage | null;
      try {
        message = this.#readBuffer.readMessage();
      } catch (error) {
        this.onerror?.(toError(error));
        continue;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#readBuffer.clear();
    this.onclose?.();
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
