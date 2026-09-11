import { describe, expect, it } from "vitest";

import { SerialQueue } from "./serial-queue.ts";

describe("SerialQueue", () => {
  it("runs same-key tasks one at a time in enqueue order", async () => {
    const queue = new SerialQueue();
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const task = (id: string) => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(`${id}:start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`${id}:end`);
      inFlight -= 1;
      return id;
    };

    const results = await Promise.all([
      queue.run("browser", task("1")),
      queue.run("browser", task("2")),
      queue.run("browser", task("3")),
    ]);

    expect(results).toEqual(["1", "2", "3"]);
    expect(order).toEqual(["1:start", "1:end", "2:start", "2:end", "3:start", "3:end"]);
    expect(maxInFlight).toBe(1);
  });

  it("lets different keys run concurrently", async () => {
    const queue = new SerialQueue();
    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const run = (key: string) =>
      queue.run(key, async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate;
        inFlight -= 1;
      });

    const both = Promise.all([run("a"), run("b")]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(maxInFlight).toBe(2);
    release();
    await both;
  });

  it("keeps the queue usable after a task rejects", async () => {
    const queue = new SerialQueue();
    const failing = queue.run("k", async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    await expect(queue.run("k", async () => "ok")).resolves.toBe("ok");
  });
});
