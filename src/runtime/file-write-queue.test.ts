import { mkdir, mkdtemp, readFile, symlink, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileWriteQueue, resolveWriteQueueKey } from "./file-write-queue.ts";

describe("FileWriteQueue", () => {
  let root = "";

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("serializes concurrent same-path tasks so the last write wins without interleaving", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "xio-write-queue-"));
    const target = path.join(root, "shared.ts");
    await writeFile(target, "v0\n", "utf8");
    const queue = new FileWriteQueue();
    const order: string[] = [];

    await Promise.all([
      queue.run(target, async () => {
        order.push("a-start");
        const cur = await readFile(target, "utf8");
        await new Promise((r) => setTimeout(r, 40));
        await writeFile(target, `${cur.trim()}+A\n`, "utf8");
        order.push("a-end");
      }),
      queue.run(target, async () => {
        order.push("b-start");
        const cur = await readFile(target, "utf8");
        await new Promise((r) => setTimeout(r, 10));
        await writeFile(target, `${cur.trim()}+B\n`, "utf8");
        order.push("b-end");
      }),
    ]);

    expect(order[0]).toMatch(/^[ab]-start$/);
    expect(order).toEqual([
      order[0],
      order[0]!.replace("-start", "-end"),
      order[0]!.startsWith("a") ? "b-start" : "a-start",
      order[0]!.startsWith("a") ? "b-end" : "a-end",
    ]);
    // Whichever ran second appended last; both mutations applied without interleaving.
    const final = await readFile(target, "utf8");
    expect(final === "v0+A+B\n" || final === "v0+B+A\n").toBe(true);
  });

  it("aliases symlink and realpath onto the same queue key", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "xio-write-queue-link-"));
    const real = path.join(root, "real.ts");
    await writeFile(real, "x\n", "utf8");
    const link = path.join(root, "link.ts");
    await symlink(real, link);

    expect(await resolveWriteQueueKey(link)).toBe(await resolveWriteQueueKey(real));

    const queue = new FileWriteQueue();
    let maxInFlight = 0;
    let inFlight = 0;
    await Promise.all([
      queue.run(real, async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight -= 1;
      }),
      queue.run(link, async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight -= 1;
      }),
    ]);
    expect(maxInFlight).toBe(1);
  });

  it("allows different real paths to run concurrently", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "xio-write-queue-par-"));
    await mkdir(root, { recursive: true });
    const a = path.join(root, "a.ts");
    const b = path.join(root, "b.ts");
    await writeFile(a, "a\n", "utf8");
    await writeFile(b, "b\n", "utf8");
    const queue = new FileWriteQueue();
    let maxInFlight = 0;
    let inFlight = 0;

    await Promise.all([
      queue.run(a, async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 40));
        inFlight -= 1;
      }),
      queue.run(b, async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 40));
        inFlight -= 1;
      }),
    ]);
    expect(maxInFlight).toBe(2);
  });
});
