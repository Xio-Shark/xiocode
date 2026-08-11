import { spawn } from "node:child_process";

export type PtyAction = Readonly<{
  waitFor: string;
  send?: string;
  timeoutMs?: number;
}>;

export type PtyScenarioResult = Readonly<{
  output: string;
  exitCode: number;
  milestonesMs: readonly number[];
}>;

export async function runPtyScenario(options: Readonly<{
  command: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  actions: readonly PtyAction[];
  exitTimeoutMs?: number;
}>): Promise<PtyScenarioResult> {
  const payload = {
    command: options.command,
    cwd: options.cwd,
    env: options.env,
    actions: options.actions.map((action) => ({
      waitFor: action.waitFor,
      sendBase64: action.send === undefined
        ? undefined
        : Buffer.from(action.send, "utf8").toString("base64"),
      timeoutMs: action.timeoutMs ?? 5_000,
    })),
    exitTimeoutMs: options.exitTimeoutMs ?? 5_000,
  };
  const child = spawn("python3", ["-c", PYTHON_PTY_DRIVER, JSON.stringify(payload)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const diagnostic = Buffer.concat(stderr).toString("utf8");
  if (code !== 0) {
    throw new Error(`PTY driver failed (${code ?? "signal"}): ${diagnostic}`);
  }
  const line = Buffer.concat(stdout).toString("utf8").trim().split("\n").at(-1);
  if (!line) throw new Error(`PTY driver returned no result: ${diagnostic}`);
  const result = JSON.parse(line) as {
    output?: unknown;
    exitCode?: unknown;
    milestonesMs?: unknown;
    error?: unknown;
  };
  if (typeof result.error === "string" && result.error.length > 0) {
    throw new Error(`${result.error}\nPTY output:\n${String(result.output ?? "")}`);
  }
  if (
    typeof result.output !== "string"
    || typeof result.exitCode !== "number"
    || !Array.isArray(result.milestonesMs)
    || !result.milestonesMs.every((value) => typeof value === "number")
  ) {
    throw new Error(`PTY driver returned invalid result: ${line}`);
  }
  return {
    output: result.output,
    exitCode: result.exitCode,
    milestonesMs: result.milestonesMs,
  };
}

const PYTHON_PTY_DRIVER = String.raw`
import base64
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

cfg = json.loads(sys.argv[1])
pid = None
fd = None
waited = False
status = None
chunks = bytearray()
milestones = []
started = time.monotonic()

ansi = re.compile(
    r"\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])"
)

def clean_output():
    text = chunks.decode("utf-8", errors="replace")
    text = ansi.sub("", text)
    return text.replace("\r", "").replace("\b", "")

def read_once(timeout):
    global waited, status
    if fd is not None:
        ready, _, _ = select.select([fd], [], [], timeout)
        if ready:
            try:
                data = os.read(fd, 65536)
                if data:
                    chunks.extend(data)
            except OSError:
                pass
    if pid is not None and not waited:
        ended, child_status = os.waitpid(pid, os.WNOHANG)
        if ended == pid:
            waited = True
            status = child_status

def wait_for(needle, timeout_ms):
    deadline = time.monotonic() + timeout_ms / 1000.0
    while needle not in clean_output():
        read_once(0.02)
        if waited:
            raise RuntimeError("child exited before expected text: " + needle)
        if time.monotonic() >= deadline:
            raise RuntimeError("timed out waiting for: " + needle)
    milestones.append(round((time.monotonic() - started) * 1000))

def cleanup():
    global waited, status
    if pid is None or waited:
        return
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        _, status = os.waitpid(pid, 0)
        waited = True
    except ChildProcessError:
        waited = True

def exit_code():
    if status is None:
        return -1
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return -1

result = {}
try:
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cfg["cwd"])
        os.execvpe(cfg["command"][0], cfg["command"], cfg["env"])

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
    for action in cfg["actions"]:
        wait_for(action["waitFor"], action["timeoutMs"])
        encoded = action.get("sendBase64")
        if encoded is not None:
            os.write(fd, base64.b64decode(encoded))

    deadline = time.monotonic() + cfg["exitTimeoutMs"] / 1000.0
    while not waited and time.monotonic() < deadline:
        read_once(0.02)
    if not waited:
        raise RuntimeError("timed out waiting for child exit")
except Exception as exc:
    result["error"] = str(exc)
finally:
    cleanup()
    result["output"] = clean_output()
    result["exitCode"] = exit_code()
    result["milestonesMs"] = milestones
    print(json.dumps(result, ensure_ascii=False))
`;
