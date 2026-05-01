import { describe, it, expect } from "vitest";
import { createInMemoryQueue } from "./in-memory-queue.js";

describe("createInMemoryQueue", () => {
  it("buffers sends and reports size", async () => {
    const q = createInMemoryQueue<{ kind: string }>();
    expect(q.size()).toBe(0);
    await q.send({ kind: "a" });
    await q.send({ kind: "b" });
    expect(q.size()).toBe(2);
  });

  it("drain returns and clears", async () => {
    const q = createInMemoryQueue<number>();
    await q.send(1);
    await q.send(2);
    expect(q.drain()).toEqual([1, 2]);
    expect(q.size()).toBe(0);
  });

  it("peek returns without clearing", async () => {
    const q = createInMemoryQueue<string>();
    await q.send("x");
    expect(q.peek()).toEqual(["x"]);
    expect(q.size()).toBe(1);
  });
});
