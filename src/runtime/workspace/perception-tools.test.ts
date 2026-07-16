import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ExtensionHost } from "../extension-host.ts";
import {
  createPerceptionTools,
  QUERY_WORKSPACE_TOOL_NAME,
  READ_EVIDENCE_TOOL_NAME,
} from "./perception-tools.ts";
import { registerPerceptionCapability } from "./register.ts";
import { WorkspacePerceptionService } from "./service.ts";

import type { WorkspaceIndexAdapter } from "./types.ts";

async function fixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "xio-perception-tools-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "hello.ts"),
    "export function greet(name: string) {\n  return name;\n}\n",
    "utf8",
  );
  return root;
}

function unavailableAdapter(): WorkspaceIndexAdapter {
  return {
    name: "gitnexus",
    async isAvailable() {
      return false;
    },
    async queryStructure() {
      return { kind: "unavailable", reason: "gitnexus index absent" };
    },
  };
}

describe("createPerceptionTools", () => {
  it("registers query_workspace and read_evidence product tools", async () => {
    const root = await fixtureRepo();
    const service = new WorkspacePerceptionService({
      root,
      gitnexus: unavailableAdapter(),
    });
    await service.ensureWarm();
    const tools = createPerceptionTools({ service });
    expect(tools.map((t) => t.name).sort()).toEqual(
      [QUERY_WORKSPACE_TOOL_NAME, READ_EVIDENCE_TOOL_NAME].sort(),
    );

    const query = tools.find((t) => t.name === QUERY_WORKSPACE_TOOL_NAME)!;
    const queryResult = await query.execute("c1", { path_prefix: "src", limit: 20 });
    expect(queryResult.isError).toBeFalsy();
    const queryText = queryResult.content[0]?.text ?? "";
    expect(queryText).toMatch(/claims=/);
    expect(queryText).toMatch(/src\/hello\.ts/);
    expect(queryText).toMatch(/cite=/);

    // Prefer structured service result for citation round-trip (tool text is compact).
    const structured = await service.queryStructure({ pathPrefix: "src", limit: 20 });
    const citation = structured.claims[0]?.citations[0];
    expect(citation).toBeTruthy();

    const read = tools.find((t) => t.name === READ_EVIDENCE_TOOL_NAME)!;
    const evidence = await read.execute("c2", {
      path: citation!.path,
      start_line: citation!.startLine,
      end_line: citation!.endLine,
      hash: citation!.hash,
    });
    if (evidence.isError) {
      throw new Error(`unexpected read_evidence error: ${evidence.content[0]?.text}`);
    }
    expect(evidence.content[0]?.text).toMatch(/hash=/);
    expect((evidence.content[0]?.text ?? "").length).toBeGreaterThan(10);

    const stale = await read.execute("c3", {
      path: citation!.path,
      start_line: citation!.startLine,
      end_line: citation!.endLine,
      hash: "not-the-real-hash",
    });
    expect(stale.isError).toBe(true);
    expect(stale.content[0]?.text).toMatch(/stale|missing|error/i);
  });

  it("registerPerceptionCapability installs tools on the host", async () => {
    const root = await fixtureRepo();
    const service = new WorkspacePerceptionService({
      root,
      gitnexus: unavailableAdapter(),
    });
    const host = new ExtensionHost({
      initialModel: { provider: "test", id: "m", name: "m" },
    });
    registerPerceptionCapability(host, { service, injectPrompt: false });
    const names = host.listTools().map((t) => t.name);
    expect(names).toContain(QUERY_WORKSPACE_TOOL_NAME);
    expect(names).toContain(READ_EVIDENCE_TOOL_NAME);
  });
});
