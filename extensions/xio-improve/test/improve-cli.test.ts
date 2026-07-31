import { describe, expect, it } from "vitest";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertMaintainerRepo,
  MAINTAINER_PACKAGE_NAME,
  parseImproveArgs,
  resolveImproveArgs,
  runImproveCli,
} from "../../../src/cli/improve-cli.ts";
import { RegressionCaseStore } from "../../xio-regress/src/index.ts";
import { gitOk } from "../../xio-sandbox/src/git.ts";

describe("parseImproveArgs", () => {
  it("parses max and check append", () => {
    expect(parseImproveArgs(["--max", "3", "--check", "npm test"])).toEqual({
      command: "run",
      json: false,
      max: 3,
      help: false,
      verifierCommands: ["npm test"],
      noBuiltinSeeds: false,
      capabilityGate: false,
      capabilityGateFromFlag: false,
      privateCaseFromFlag: false,
      evalRepeat: 1,
      evalRepeatFromFlag: false,
    });
  });

  it("parses help and no-builtin-seeds", () => {
    expect(parseImproveArgs(["--help", "--no-builtin-seeds"])).toEqual({
      command: "run",
      json: false,
      max: 1,
      help: true,
      verifierCommands: [],
      noBuiltinSeeds: true,
      capabilityGate: false,
      capabilityGateFromFlag: false,
      privateCaseFromFlag: false,
      evalRepeat: 1,
      evalRepeatFromFlag: false,
    });
  });

  it("parses ledger subcommands and their flags", () => {
    expect(parseImproveArgs(["status", "--json"])).toMatchObject({ command: "status", json: true });
    expect(parseImproveArgs(["status", "run-1"])).toMatchObject({ command: "status", runId: "run-1" });
    expect(parseImproveArgs(["resume", "run-1"])).toMatchObject({ command: "resume", runId: "run-1" });
    expect(parseImproveArgs(["retry", "run-1", "--override-reason", "investigated"]))
      .toMatchObject({ command: "retry", runId: "run-1", overrideReason: "investigated" });
    expect(parseImproveArgs(["abandon", "run-1", "--reason", "dead end"]))
      .toMatchObject({ command: "abandon", runId: "run-1", abandonReason: "dead end" });
    expect(() => parseImproveArgs(["resume"])).toThrow(/requires a RUN id/);
    expect(() => parseImproveArgs(["bogus"])).toThrow(/unknown improve subcommand/);
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

  it("parses --eval-repeat within eval bounds", () => {
    expect(parseImproveArgs(["--eval-repeat", "3"])).toMatchObject({ evalRepeat: 3, evalRepeatFromFlag: true });
    expect(parseImproveArgs(["--eval-repeat=5"])).toMatchObject({ evalRepeat: 5, evalRepeatFromFlag: true });
    expect(() => parseImproveArgs(["--eval-repeat", "0"])).toThrow(/between 1 and 10/);
    expect(() => parseImproveArgs(["--eval-repeat", "11"])).toThrow(/between 1 and 10/);
    expect(() => parseImproveArgs(["--eval-repeat"])).toThrow(/missing value for --eval-repeat/i);
  });

  it("fails closed on unknown options and missing values", () => {
    expect(() => parseImproveArgs(["--nope"])).toThrow(/unknown improve option/i);
    expect(() => parseImproveArgs(["--max"])).toThrow(/missing value for --max/i);
    expect(() => parseImproveArgs(["--max", "0"])).toThrow(/invalid --max/i);
    expect(() => parseImproveArgs(["--check"])).toThrow(/missing value for --check/i);
    expect(() => parseImproveArgs(["--private-case"])).toThrow(/missing value for --private-case/i);
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
        { capabilityGate: true, privateCase: "last", evalRepeat: 4 },
        {},
        store,
      );
      expect(resolved.capabilityGate).toBe(true);
      expect(resolved.privateCaseId).toBe(caseId);
      expect(resolved.evalRepeat).toBe(4);
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
        parseImproveArgs(["--capability-gate", "--private-case", caseId, "--eval-repeat", "2"]),
        { capabilityGate: false, privateCase: "last", evalRepeat: 7 },
        {},
        store,
      );
      expect(resolved.capabilityGate).toBe(true);
      expect(resolved.privateCaseId).toBe(caseId);
      expect(resolved.evalRepeat).toBe(2);
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

describe("maintainer mode identity guard", () => {
  async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(path.join(os.tmpdir(), "xio-improve-identity-"));
    try {
      await run(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  async function gitInit(root: string): Promise<void> {
    await gitOk(root, ["init"]);
  }

  function cliOptions(root: string): {
    cwd: string;
    env: NodeJS.ProcessEnv;
    write: (chunk: string) => void;
    output: () => string;
  } {
    const chunks: string[] = [];
    return {
      cwd: root,
      env: {
        XIO_HOME: path.join(root, ".xio-home"),
        XIO_CONFIG: path.join(root, "no-config.toml"),
      },
      write: (chunk: string) => {
        chunks.push(chunk);
      },
      output: () => chunks.join(""),
    };
  }

  it("rejects a non-XioCode git repository with expected and detected identity", async () => {
    await withTempDir(async (root) => {
      await gitInit(root);
      await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "other-project" }), "utf8");
      const options = cliOptions(root);
      const code = await runImproveCli([], options);
      expect(code).toBe(2);
      expect(options.output()).toContain(MAINTAINER_PACKAGE_NAME);
      expect(options.output()).toContain("other-project");
      expect(options.output()).toMatch(/maintainer self-improve/i);
    });
  });

  it("fails closed when package.json is missing", async () => {
    await withTempDir(async (root) => {
      await gitInit(root);
      const options = cliOptions(root);
      const code = await runImproveCli([], options);
      expect(code).toBe(2);
      expect(options.output()).toContain("<no package.json>");
    });
  });

  it("fails closed when package.json is malformed", async () => {
    await withTempDir(async (root) => {
      await gitInit(root);
      await writeFile(path.join(root, "package.json"), "{not json", "utf8");
      const options = cliOptions(root);
      const code = await runImproveCli([], options);
      expect(code).toBe(2);
      expect(options.output()).toContain("<unreadable package.json>");
    });
  });

  it("passes the guard in a XioCode-identity repository", async () => {
    await withTempDir(async (root) => {
      await gitInit(root);
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: MAINTAINER_PACKAGE_NAME }),
        "utf8",
      );
      await expect(assertMaintainerRepo(root)).resolves.toBe(await realpath(root));
      // Full CLI reaches goal selection (empty store) instead of the guard error.
      const options = cliOptions(root);
      const code = await runImproveCli(["--no-builtin-seeds"], options);
      expect(code).toBe(1);
      expect(options.output()).toContain("No goals to run.");
    });
  });

  it("shows help without any repository identity", async () => {
    await withTempDir(async (root) => {
      const options = cliOptions(root);
      const code = await runImproveCli(["--help"], options);
      expect(code).toBe(0);
      expect(options.output()).toMatch(/maintainer-only/i);
      expect(options.output()).toMatch(/status \[RUN\]/);
    });
  });

  it("status reports an empty ledger and json array", async () => {
    await withTempDir(async (root) => {
      await gitInit(root);
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: MAINTAINER_PACKAGE_NAME }),
        "utf8",
      );
      const text = cliOptions(root);
      expect(await runImproveCli(["status"], text)).toBe(0);
      expect(text.output()).toContain("No improvement runs recorded.");
      const json = cliOptions(root);
      expect(await runImproveCli(["status", "--json"], json)).toBe(0);
      expect(JSON.parse(json.output())).toEqual([]);
    });
  });

  it("resume/abandon fail closed on unknown run ids", async () => {
    await withTempDir(async (root) => {
      await gitInit(root);
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: MAINTAINER_PACKAGE_NAME }),
        "utf8",
      );
      const options = cliOptions(root);
      expect(await runImproveCli(["abandon", "nope", "--reason", "x"], options)).toBe(2);
      expect(options.output()).toMatch(/error:/);
    });
  });
});
