import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runFlowSetupCommand } from "../src/flow-setup.ts";

describe("xio-setup flow", () => {
  it("prints status when no flow.json exists", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "xio-flow-test-"));
    let output = "";
    try {
      const code = await runFlowSetupCommand([], {
        cwd: tmp,
        write: (c) => { output += c; },
      });
      expect(code).toBe(0);
      expect(output).toContain("no .xio/flow.json found");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("initializes starter flow and validates it", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "xio-flow-test-"));
    let output = "";
    try {
      const initCode = await runFlowSetupCommand(["init"], {
        cwd: tmp,
        write: (c) => { output += c; },
      });
      expect(initCode).toBe(0);
      expect(output).toContain("created starter flow template");

      output = "";
      const valCode = await runFlowSetupCommand(["validate"], {
        cwd: tmp,
        write: (c) => { output += c; },
      });
      expect(valCode).toBe(0);
      expect(output).toContain("validation PASSED");

      output = "";
      const planCode = await runFlowSetupCommand(["plan"], {
        cwd: tmp,
        write: (c) => { output += c; },
      });
      expect(planCode).toBe(0);
      expect(output).toContain("Execution Plan");
      expect(output).toContain("Wave 1");
      expect(output).toContain("Wave 2");
      expect(output).toContain("Wave 3");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
