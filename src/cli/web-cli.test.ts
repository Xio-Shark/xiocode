import { describe, it, expect, vi, afterEach } from "vitest";

import { CliUsageError } from "./cli-args.ts";
import {
  WEB_USAGE,
  describePortFallback,
  describeStartFailure,
  parseWebCliArgs,
  planWebBinding,
  runWebCli,
} from "./web-cli.ts";

function addrInUse(port: number): NodeJS.ErrnoException {
  return Object.assign(new Error(`listen EADDRINUSE: address already in use 127.0.0.1:${port}`), {
    code: "EADDRINUSE",
    errno: -48,
  });
}

describe("xio web argument parsing", () => {
  it("defaults to the implicit port with no flags", () => {
    expect(parseWebCliArgs([])).toEqual({ port: undefined, host: undefined, open: true, strictPort: false });
  });

  it("accepts --port 0 for an OS-assigned port", () => {
    expect(parseWebCliArgs(["--port", "0"]).port).toBe(0);
    expect(parseWebCliArgs(["--port=0"]).port).toBe(0);
  });

  it.each([
    ["abc", "not a number"],
    ["0.5", "fractional"],
    ["70000", "out of range"],
    ["-1", "negative"],
    ["0308", "zero padded"],
  ])("rejects --port %s (%s) as a usage error", (value) => {
    try {
      parseWebCliArgs(["--port", value]);
      expect.unreachable(`--port ${value} should have thrown`);
    } catch (error) {
      expect(error).toBeInstanceOf(CliUsageError);
      expect((error as CliUsageError).exitCode).toBe(2);
      expect((error as Error).message).toContain("between 0 and 65535");
      expect((error as Error).message).toContain(WEB_USAGE);
    }
  });

  it("rejects a flag without its value", () => {
    expect(() => parseWebCliArgs(["--port"])).toThrow(/requires a value/);
    expect(() => parseWebCliArgs(["--host", "--no-open"])).toThrow(/requires a value/);
  });

  it("rejects unknown flags with a suggestion instead of silently ignoring them", () => {
    expect(() => parseWebCliArgs(["--prot", "3099"])).toThrow(/Unknown option for 'xio web': '--prot'.*Did you mean "--port"\?/);
    expect(() => parseWebCliArgs(["serve"])).toThrow(CliUsageError);
  });

  it("parses --host, --no-open and --strict-port", () => {
    expect(parseWebCliArgs(["--host=127.0.0.1", "--no-open", "--strict-port"])).toEqual({
      port: undefined,
      host: "127.0.0.1",
      open: false,
      strictPort: true,
    });
  });
});

describe("xio web port binding policy", () => {
  it("scans next ports only for the implicit default", () => {
    expect(planWebBinding({})).toEqual({ port: 3080, portAttempts: 10, source: "default" });
  });

  it("treats --strict-port as a one-shot keep-the-default request", () => {
    expect(planWebBinding({ strictPort: true })).toEqual({ port: 3080, portAttempts: 1, source: "strict" });
  });

  it("treats an explicit port as a contract", () => {
    expect(planWebBinding({ port: 4000 })).toEqual({ port: 4000, portAttempts: 1, source: "explicit" });
    expect(planWebBinding({ port: 0 })).toEqual({ port: 0, portAttempts: 1, source: "explicit" });
  });
});

describe("xio web failure messages", () => {
  it("names the scanned range when the default port family is exhausted", () => {
    const message = describeStartFailure(addrInUse(3080), { port: 3080, portAttempts: 10, source: "default" });
    expect(message).toContain("no free port between 3080 and 3089");
    expect(message).toContain("--port 0");
  });

  it("points at the strict flag when --strict-port blocked the fallback", () => {
    const message = describeStartFailure(addrInUse(3080), { port: 3080, portAttempts: 1, source: "strict" });
    expect(message).toContain("port 3080 is already in use");
    expect(message).toContain("--strict-port");
  });

  it("tells an explicit-port caller how to recover", () => {
    const message = describeStartFailure(addrInUse(4000), { port: 4000, portAttempts: 1, source: "explicit" });
    expect(message).toContain("port 4000 is already in use");
    expect(message).toContain("--port 0");
  });

  it("keeps the original detail for non-port failures", () => {
    const message = describeStartFailure(new Error("EACCES: permission denied"), { port: 3080, portAttempts: 10, source: "default" });
    expect(message).toBe("Failed to start Web Console: EACCES: permission denied");
  });

  it("reports the fallback once, in one line", () => {
    expect(describePortFallback(3080, 3081)).toBe("Port 3080 is in use, using 3081.");
  });
});

describe("runWebCli usage handling", () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    spies.push(vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }));
    spies.push(vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    }));
    return {
      out: () => out.join(""),
      err: () => err.join(""),
    };
  }

  it("exits 2 with usage on an invalid flag instead of throwing a stack trace", async () => {
    const io = capture();
    const code = await runWebCli(["--port", "abc"]);
    expect(code).toBe(2);
    expect(io.err()).toContain("between 0 and 65535");
    expect(io.err()).toContain(WEB_USAGE);
  });

  it("answers --help without binding a port", async () => {
    const io = capture();
    const code = await runWebCli(["--help"]);
    expect(code).toBe(0);
    expect(io.out()).toContain(WEB_USAGE);
  });
});
