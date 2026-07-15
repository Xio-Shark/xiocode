import { afterEach, describe, expect, it, vi } from "vitest";

import { exitCli, scheduleForceExit } from "./process-exit.ts";

describe("exitCli", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls process.exit with the status code", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    exitCli(3, {});
    expect(exit).toHaveBeenCalledWith(3);
    expect(process.exitCode).toBe(3);
  });

  it("skips process.exit when XIO_NO_FORCE_EXIT is set", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    exitCli(0, { XIO_NO_FORCE_EXIT: "1" });
    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });
});

describe("scheduleForceExit", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("schedules process.exit after grace ms", () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    scheduleForceExit(7, 100, {});
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(exit).toHaveBeenCalledWith(7);
  });

  it("is disabled by XIO_NO_FORCE_EXIT", () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    scheduleForceExit(0, 10, { XIO_NO_FORCE_EXIT: "1" });
    vi.advanceTimersByTime(50);
    expect(exit).not.toHaveBeenCalled();
  });
});
