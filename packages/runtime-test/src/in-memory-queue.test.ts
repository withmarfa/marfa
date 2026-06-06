import { describe, it, expect } from "vitest";
import { createInMemoryQueue, createMessage } from "./in-memory-queue.js";

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

  it("drainMessages wraps every payload in a Message<T> envelope", async () => {
    const q = createInMemoryQueue<{ kind: string }>();
    await q.send({ kind: "a" });
    await q.send({ kind: "b" });
    const messages = q.drainMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0]!.body).toEqual({ kind: "a" });
    expect(messages[1]!.body).toEqual({ kind: "b" });
    // Fresh envelopes start at attempts = 1, neither acked nor retried.
    for (const m of messages) {
      expect(m.acked()).toBe(false);
      expect(m.retried()).toBe(false);
      expect(m.attempts).toBe(1);
    }
    // drainMessages clears the buffer just like drain().
    expect(q.size()).toBe(0);
  });

  it("drain and drainMessages are exclusive — using one empties the buffer for the other", async () => {
    const q = createInMemoryQueue<number>();
    await q.send(1);
    await q.send(2);
    expect(q.drain()).toEqual([1, 2]);
    expect(q.drainMessages()).toEqual([]);
  });
});

describe("createMessage / Message<T>", () => {
  it("ack() flips acked() to true; idempotent", () => {
    const m = createMessage({ kind: "x" });
    expect(m.acked()).toBe(false);
    m.ack();
    expect(m.acked()).toBe(true);
    m.ack();
    expect(m.acked()).toBe(true);
  });

  it("retry() flips retried() to true and bumps attempts", () => {
    const m = createMessage({ kind: "x" });
    expect(m.retried()).toBe(false);
    expect(m.attempts).toBe(1);
    m.retry();
    expect(m.retried()).toBe(true);
    expect(m.attempts).toBe(2);
  });

  it("retry({ delaySeconds }) captures the delay for assertions", () => {
    const m = createMessage({ kind: "x" });
    m.retry({ delaySeconds: 7 });
    expect(m.retryDelaySeconds()).toBe(7);
  });

  it("retry() with no opts leaves retryDelaySeconds undefined", () => {
    const m = createMessage({ kind: "x" });
    m.retry();
    expect(m.retryDelaySeconds()).toBeUndefined();
  });

  it("createMessage(body, attempts) seeds a redelivered envelope", () => {
    const m = createMessage({ kind: "x" }, 3);
    expect(m.attempts).toBe(3);
    m.retry();
    expect(m.attempts).toBe(4);
  });

  it("ack and retry are independent counters — neither affects the other directly", () => {
    const m = createMessage({ kind: "x" });
    m.retry();
    expect(m.acked()).toBe(false);
    expect(m.retried()).toBe(true);
  });
});
