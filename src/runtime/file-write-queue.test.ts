import { mkdir, mkdtemp, readFile, symlink, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileWriteQueue, resolveWriteQueueKey } from "./file-write-queue.ts";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
    expect(await readFile(target, "utf8")).toBe("v0+A+B\n");
  });

  it("preserves call order when canonical key resolution completes out of order", async () => {
    const firstKey = deferred<string>();
    const secondKey = deferred<string>();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const keys = [firstKey, secondKey];
    let keyIndex = 0;
    const queue = new FileWriteQueue(() => keys[keyIndex++]!.promise);
    const order: string[] = [];

    const first = queue.run("alias-a.ts", async () => {
      order.push("a-start");
      firstStarted.resolve(undefined);
      await releaseFirst.promise;
      order.push("a-end");
    });
    const second = queue.run("alias-b.ts", async () => {
      order.push("b-start");
      order.push("b-end");
    });

    secondKey.resolve("/canonical/shared.ts");
    await Promise.resolve();
    expect(order).toEqual([]);

    firstKey.resolve("/canonical/shared.ts");
    await firstStarted.promise;
    expect(order).toEqual(["a-start"]);

    releaseFirst.resolve(undefined);
    await Promise.all([first, second]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("preserves enqueue order under reverse key-resolution pressure", async () => {
    const count = 64;
    const keys = Array.from({ length: count }, () => deferred<string>());
    let keyIndex = 0;
    const queue = new FileWriteQueue(() => keys[keyIndex++]!.promise);
    const order: number[] = [];
    const runs = Array.from({ length: count }, (_, index) =>
      queue.run(`alias-${index}.ts`, async () => {
        order.push(index);
      }),
    );

    for (let index = count - 1; index >= 0; index -= 1) {
      keys[index]!.resolve("/canonical/shared.ts");
    }

    await Promise.all(runs);
    expect(order).toEqual(Array.from({ length: count }, (_, index) => index));
  });

  it("continues admission after key resolution rejects", async () => {
    let keyCalls = 0;
    const queue = new FileWriteQueue(() => {
      keyCalls += 1;
      if (keyCalls === 1) {
        throw new Error("canonicalization failed");
      }
      return Promise.resolve("/canonical/next.ts");
    });
    const first = queue.run("bad.ts", async () => "unexpected");
    const second = queue.run("next.ts", async () => "ok");

    await expect(first).rejects.toThrow("canonicalization failed");
    await expect(second).resolves.toBe("ok");
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
