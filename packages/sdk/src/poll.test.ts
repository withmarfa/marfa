/**
 * The poll helper, driven against a stub rather than a server.
 *
 * The property under test is the one that made a bulk action report failure
 * for work that succeeded: asking about a job is not the job, so a failed
 * question has to be waited out rather than ended on. A real server would
 * add latency and prove none of this any better — what it could not do at
 * all is make one status response slow on demand, which is the whole case.
 */
import { describe, expect, it, vi } from "vitest";
import { PollTimeoutError, pollUntilTerminal } from "./poll.js";

type Step = { throws: Error } | { done: boolean };

/** A `fetchOnce` that plays a fixed script: each entry either throws or
 *  returns, and the last entry repeats forever. Keeps every test below
 *  about the sequence rather than about the mock. */
function scripted(steps: Step[]): () => Promise<{ done: boolean }> {
  let i = 0;
  return () => {
    const step = steps[Math.min(i, steps.length - 1)] ?? { done: true };
    i += 1;
    if ("throws" in step) return Promise.reject(step.throws);
    return Promise.resolve({ done: step.done });
  };
}

const fast = { pollIntervalMs: 1, maxPollIntervalMs: 1 } as const;
const isDone = (r: { done: boolean }) => r.done;

describe("pollUntilTerminal", () => {
  it("waits out a failure the caller calls transient, and returns the answer after it", async () => {
    const result = await pollUntilTerminal({
      fetchOnce: scripted([
        { throws: new Error("slow") },
        { throws: new Error("slow") },
        { done: true },
      ]),
      isTerminal: isDone,
      isRetryable: () => true,
      ...fast,
    });
    expect(result).toEqual({ done: true });
  });

  it("ends on a failure the caller does not call transient", async () => {
    const fatal = new Error("job is gone");
    await expect(
      pollUntilTerminal({
        fetchOnce: scripted([{ throws: fatal }]),
        isTerminal: isDone,
        isRetryable: () => false,
        ...fast,
      }),
    ).rejects.toBe(fatal);
  });

  it("ends on any failure when the caller says nothing, which is the old behavior", async () => {
    const boom = new Error("boom");
    await expect(
      pollUntilTerminal({
        fetchOnce: scripted([{ throws: boom }]),
        isTerminal: isDone,
        ...fast,
      }),
    ).rejects.toBe(boom);
  });

  it("surfaces the last real failure when the budget runs out, not a poll timeout", async () => {
    // A `PollTimeoutError` here would say the job took too long, when what
    // happened is that every attempt to ask about it failed. The caller
    // needs the second answer to know whether to look at the job at all.
    const why = new Error("connection refused");
    let asked = 0;
    await expect(
      pollUntilTerminal({
        fetchOnce: () => {
          asked += 1;
          return Promise.reject(why);
        },
        isTerminal: isDone,
        isRetryable: () => true,
        pollIntervalMs: 1,
        maxPollIntervalMs: 1,
        maxWaitMs: 30,
      }),
    ).rejects.toBe(why);
    // The count is what makes this a test of the budget path rather than of
    // the first throw: giving up immediately rejects with the same error.
    expect(asked).toBeGreaterThan(1);
  });

  it("still reports a poll timeout when the job itself never finishes", async () => {
    await expect(
      pollUntilTerminal({
        fetchOnce: scripted([{ done: false }]),
        isTerminal: isDone,
        isRetryable: () => true,
        pollIntervalMs: 1,
        maxPollIntervalMs: 1,
        maxWaitMs: 5,
      }),
    ).rejects.toBeInstanceOf(PollTimeoutError);
  });

  it("backs off between failures rather than re-asking at the first interval", async () => {
    // The mutant this exists for: deleting the doubling on the failure path
    // left every test green, because they all pinned the interval at 1ms.
    // The bound is derived from the schedule rather than from the clock —
    // 10, 20, 40, 40 … inside 400ms is at most 9 attempts, where a flat 10ms
    // is about 40. A loaded machine only makes the sleeps longer and the
    // count smaller, so load cannot turn this red.
    let asked = 0;
    await expect(
      pollUntilTerminal({
        fetchOnce: () => {
          asked += 1;
          return Promise.reject(new Error("still bad"));
        },
        isTerminal: isDone,
        isRetryable: () => true,
        pollIntervalMs: 10,
        maxPollIntervalMs: 40,
        maxWaitMs: 400,
      }),
    ).rejects.toThrow("still bad");
    expect(asked).toBeLessThan(15);
  });

  it("does not call onProgress for a failure, which is not progress", async () => {
    const progress = vi.fn();
    await pollUntilTerminal({
      fetchOnce: scripted([{ throws: new Error("slow") }, { done: true }]),
      isTerminal: isDone,
      isRetryable: () => true,
      onProgress: progress,
      ...fast,
    });
    expect(progress).not.toHaveBeenCalled();
  });
});
