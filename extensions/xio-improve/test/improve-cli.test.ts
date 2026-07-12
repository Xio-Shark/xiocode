import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseImproveArgs, resolveImproveArgs } from "../../../src/cli/improve-cli.ts";
import { RegressionCaseStore } from "../../xio-regress/src/index.ts";

describe("parseImproveArgs", () => {
  it("parses max and check append", () => {
    expect(parseImproveArgs(["--max", "3", "--check", "npm test"])).toEqual({
      max: 3,
      help: false,
      verifierCommands: ["npm test"],
      noBuiltinSeeds: false,
      capabilityGate: false,
      capabilityGateFromFlag: false,
      privateCaseFromFlag: false,
    });
  });

  it("parses help and no-builtin-seeds", () => {
    expect(parseImproveArgs(["--help", "--no-builtin-seeds"])).toEqual({
      max: 1,
      help: true,
      verifierCommands: [],
      noBuiltinSeeds: true,
      capabilityGate: false,
      capabilityGateFromFlag: false,
      privateCaseFromFlag: false,
    });
  });

  it("parses trusted capability gate opt-in", () => {
    const parsed = parseImproveArgs(["--capability-gate"]);
    expect(parsed.capabilityGate).toBe(true);
    expect(parsed.capabilityGateFromFlag).toBe(true);
  });

  it("parses --private-case", () => {
    expect(parseImproveArgs(["--private-case", "abc", "--capability-gate"])).toMatchObject({
      privateCaseId: "abc",
      capabilityGate: true,
      privateCaseFromFlag: true,
      capabilityGateFromFlag: true,
    });
    expect(parseImproveArgs(["--private-case=abc"]).privateCaseId).toBe("abc");
  });
});

describe("resolveImproveArgs", () => {
  it("applies config defaults when CLI flags are omitted", async () => {
    const caseId = "a".repeat(64);
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-improve-defaults-"));
    try {
      const store = new RegressionCaseStore(root);
      await store.writeLastCaseId(caseId);
      const resolved = await resolveImproveArgs(
        parseImproveArgs([]),
        { capabilityGate: true, privateCase: "last" },
        {},
        store,
      );
      expect(resolved.capabilityGate).toBe(true);
      expect(resolved.privateCaseId).toBe(caseId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets explicit CLI flags override config", async () => {
    const caseId = "b".repeat(64);
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-improve-override-"));
    try {
      const store = new RegressionCaseStore(root);
      await store.writeLastCaseId("c".repeat(64));
      const resolved = await resolveImproveArgs(
        parseImproveArgs(["--capability-gate", "--private-case", caseId]),
        { capabilityGate: false, privateCase: "last" },
        {},
        store,
      );
      expect(resolved.capabilityGate).toBe(true);
      expect(resolved.privateCaseId).toBe(caseId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when private_case=last has no pointer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-improve-missing-last-"));
    try {
      const store = new RegressionCaseStore(root);
      await expect(resolveImproveArgs(
        parseImproveArgs([]),
        { capabilityGate: true, privateCase: "last" },
        {},
        store,
      )).rejects.toThrow(/no last-captured private case/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
