import { describe, expect, it } from "vitest";
import {
  detectScopeConflicts,
  partitionWaves,
  patternsOverlap,
  readyWave,
  scopesOverlap,
  topoSort,
  validateFlow,
} from "../src/index.ts";
import type { FlowConfig, FlowTask } from "../src/types.ts";

describe("xio-flow DAG scheduler", () => {
  const linearTasks: FlowTask[] = [
    { id: "A", name: "Step A" },
    { id: "B", name: "Step B", depends_on: ["A"] },
    { id: "C", name: "Step C", depends_on: ["B"] },
  ];

  const diamondTasks: FlowTask[] = [
    { id: "root", name: "Root" },
    { id: "branchA", name: "Branch A", depends_on: ["root"], write_scope: ["src/a/**"] },
    { id: "branchB", name: "Branch B", depends_on: ["root"], write_scope: ["src/b/**"] },
    { id: "merge", name: "Merge", depends_on: ["branchA", "branchB"], write_scope: ["src/**"] },
  ];

  it("calculates readyWave correctly", () => {
    const wave0 = readyWave(diamondTasks, new Set(), new Set());
    expect(wave0.ready).toEqual(["root"]);
    expect(wave0.blocked).toEqual([]);

    const wave1 = readyWave(diamondTasks, new Set(["root"]), new Set());
    expect([...wave1.ready].sort()).toEqual(["branchA", "branchB"]);
    expect(wave1.blocked).toEqual([]);

    const waveBlocked = readyWave(diamondTasks, new Set(), new Set(["root"]));
    expect(waveBlocked.ready).toEqual([]);
    expect([...waveBlocked.blocked].sort()).toEqual(["branchA", "branchB"]);
  });

  it("performs topological sort on valid DAGs", () => {
    const order = topoSort(diamondTasks);
    expect(order.indexOf("root")).toBeLessThan(order.indexOf("branchA"));
    expect(order.indexOf("root")).toBeLessThan(order.indexOf("branchB"));
    expect(order.indexOf("branchA")).toBeLessThan(order.indexOf("merge"));
    expect(order.indexOf("branchB")).toBeLessThan(order.indexOf("merge"));
  });

  it("detects circular dependencies", () => {
    const cyclicTasks: FlowTask[] = [
      { id: "task1", depends_on: ["task2"] },
      { id: "task2", depends_on: ["task1"] },
    ];
    expect(() => topoSort(cyclicTasks)).toThrow(/Circular dependency detected/);
  });

  it("detects unknown dependency references", () => {
    const broken: FlowTask[] = [
      { id: "A", depends_on: ["non_existent"] },
    ];
    expect(() => topoSort(broken)).toThrow(/depends on unknown task/);
  });

  it("detects duplicate task IDs", () => {
    const dupes: FlowTask[] = [
      { id: "dup" },
      { id: "dup" },
    ];
    expect(() => topoSort(dupes)).toThrow(/Duplicate task ID/);
  });

  it("partitions tasks into sequential concurrent waves", () => {
    const waves = partitionWaves(diamondTasks);
    expect(waves).toHaveLength(3);
    expect(waves[0]).toEqual(["root"]);
    expect([...waves[1]!].sort()).toEqual(["branchA", "branchB"]);
    expect(waves[2]).toEqual(["merge"]);
  });
});

describe("xio-flow write scope conflict detection", () => {
  it("detects pattern overlap correctly", () => {
    expect(patternsOverlap("src/**", "src/foo.ts")).toBe(true);
    expect(patternsOverlap("src/a/**", "src/b/**")).toBe(false);
    expect(patternsOverlap("docs/**", "src/**")).toBe(false);
    expect(patternsOverlap("**", "src/any.ts")).toBe(true);
    expect(patternsOverlap("src/app.ts", "src/app.ts")).toBe(true);
  });

  it("checks scope overlap between tasks", () => {
    expect(scopesOverlap(["src/a/**"], ["src/b/**"]).overlap).toBe(false);
    expect(scopesOverlap(["src/**"], ["src/a/file.ts"]).overlap).toBe(true);
  });

  it("identifies concurrent scope conflicts in the same wave", () => {
    const conflictingTasks: FlowTask[] = [
      { id: "taskA", write_scope: ["src/shared/**"] },
      { id: "taskB", write_scope: ["src/shared/utils.ts"] },
    ];
    const waves = [["taskA", "taskB"]];
    const conflicts = detectScopeConflicts(conflictingTasks, waves);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.taskA).toBe("taskA");
    expect(conflicts[0]?.taskB).toBe("taskB");
  });

  it("allows overlapping scopes across different sequential waves", () => {
    const sequentialTasks: FlowTask[] = [
      { id: "step1", write_scope: ["src/**"] },
      { id: "step2", depends_on: ["step1"], write_scope: ["src/**"] },
    ];
    const waves = [["step1"], ["step2"]];
    const conflicts = detectScopeConflicts(sequentialTasks, waves);
    expect(conflicts).toHaveLength(0);
  });

  it("validates flow configuration and returns summary", () => {
    const config: FlowConfig = {
      version: "1.0",
      name: "Feature Pipeline",
      tasks: [
        { id: "prepare", write_scope: ["dist/**"] },
        { id: "buildFront", depends_on: ["prepare"], write_scope: ["src/web/**"] },
        { id: "buildBack", depends_on: ["prepare"], write_scope: ["src/runtime/**"] },
        { id: "package", depends_on: ["buildFront", "buildBack"], write_scope: ["dist/**"] },
      ],
    };

    const res = validateFlow(config);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.warnings).toHaveLength(0);
    expect(res.waves).toHaveLength(3);
  });
});
