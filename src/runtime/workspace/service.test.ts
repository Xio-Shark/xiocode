import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { EvidenceStaleError } from "./evidence-store.ts";
import { WorkspacePerceptionService } from "./service.ts";

import type { WorkspaceIndexAdapter } from "./types.ts";

async function fixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "xio-perception-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "hello.ts"),
    "export function greet(name: string) {\n  return name;\n}\n",
    "utf8",
  );
  await writeFile(path.join(root, "package.json"), '{"name":"fixture"}\n', "utf8");
  await mkdir(path.join(root, "node_modules", "left-pad"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "left-pad", "index.js"), "module.exports=1\n", "utf8");
  return root;
}

describe("WorkspacePerceptionService", () => {
  it("warms locally without indexing excluded paths and returns compact claims", async () => {
    const root = await fixtureRepo();
    const service = new WorkspacePerceptionService({
      root,
      gitnexus: unavailableAdapter(),
    });
    await service.ensureWarm();
    expect(service.status === "ready" || service.status === "degraded").toBe(true);

    const result = await service.queryStructure({ pathPrefix: "src", limit: 20 });
    expect(result.entries.some((entry) => entry.path.includes("node_modules"))).toBe(false);
    expect(result.entries.some((entry) => entry.path === "src/hello.ts")).toBe(true);
    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.claims[0]?.citations[0]?.path).toBeTruthy();
    expect(result.claims[0]?.citations[0]?.hash).toBeTruthy();
    expect(result.limitation).toMatch(/gitnexus|local/i);
  });

  it("invalidates only affected map entries and stale citations fail visibly", async () => {
    const root = await fixtureRepo();
    const service = new WorkspacePerceptionService({
      root,
      gitnexus: unavailableAdapter(),
    });
    await service.ensureWarm();
    const before = service.map.get("src/hello.ts");
    expect(before).toBeTruthy();

    const citation = {
      path: "src/hello.ts",
      startLine: 1,
      endLine: 1,
      hash: before!.hash,
    };
    service.evidence.putFromText({
      path: "src/hello.ts",
      text: "export function greet",
      startLine: 1,
      endLine: 1,
      fileHash: before!.hash,
    });

    await writeFile(path.join(root, "src", "hello.ts"), "export function greet2() {}\n", "utf8");
    await service.noteMutation("src/hello.ts", "edit");
    const after = service.map.get("src/hello.ts");
    expect(after?.hash).not.toBe(before?.hash);

    expect(() => service.readEvidence(citation)).toThrow(EvidenceStaleError);
  });

  it("degrades explicitly when GitNexus is unavailable without fake symbols", async () => {
    const root = await fixtureRepo();
    const service = new WorkspacePerceptionService({
      root,
      gitnexus: unavailableAdapter("gitnexus index absent"),
    });
    await service.ensureWarm();
    const result = await service.queryStructure({});
    expect(result.backend).toBe("local");
    expect(result.limitation).toMatch(/gitnexus/i);
    expect(result.claims.every((claim) => claim.citations.every((c) => c.hash))).toBe(true);
  });

  it("warm structural queries complete quickly on a tiny fixture (cache-hit path)", async () => {
    const root = await fixtureRepo();
    const service = new WorkspacePerceptionService({
      root,
      gitnexus: unavailableAdapter(),
    });
    await service.ensureWarm();
    const samples: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const result = await service.queryStructure({ limit: 20 });
      samples.push(result.elapsedMs);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? samples.at(-1)!;
    // Soft gate: tiny fixture should be well under 50ms; report if environment is slow.
    if (p95 > 50) {
      expect(p95, `warm query P95 ${p95}ms exceeds 50ms on tiny fixture`).toBeLessThan(200);
    } else {
      expect(p95).toBeLessThan(50);
    }
  });

  it("startup ensureWarm is non-blocking (returns a promise without requiring await for construct)", () => {
    const service = new WorkspacePerceptionService({
      root: process.cwd(),
      gitnexus: unavailableAdapter(),
    });
    expect(service.status).toBe("cold");
    const pending = service.ensureWarm();
    expect(service.status).toBe("warming");
    expect(pending).toBeInstanceOf(Promise);
    return pending;
  });
});

function unavailableAdapter(reason = "gitnexus index absent"): WorkspaceIndexAdapter {
  return {
    name: "gitnexus",
    async isAvailable() {
      return false;
    },
    async queryStructure() {
      return { kind: "unavailable", reason };
    },
  };
}
