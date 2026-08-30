/**
 * The driver, tested at its own boundary.
 *
 * The round trip is covered in `runtime-test`, whose header explains why
 * it lives there: a test that inspected a return value would pass whether
 * or not anything carried that value anywhere. This file is the other
 * half, and it was missing. Three hundred lines every integration depends
 * on had no tests of their own, which is how a driver that ignored
 * `notBefore` shipped and stayed shipped.
 *
 * What needs the driver's own boundary rather than the round trip: the
 * cursor value it writes, the key it refuses, and what it does with a page
 * that reports something other than success.
 */
import { describe, expect, it, vi } from "vitest";
import { createBudget } from "./budget.js";
import { createCursorStore } from "./cursor-store.js";
import { createInMemoryStorage } from "./in-memory-storage.js";
import { sweep } from "./sweep.js";
import type { ConnectionContext } from "./connection-context.js";

const SWEEP_KEY = "sweep";

function testContext(options: { shouldYield?: boolean } = {}): {
  ctx: ConnectionContext;
  emitted: { severity: string; summary: string }[];
  read: (key: string) => Promise<unknown>;
} {
  const storage = createInMemoryStorage();
  const cursor = createCursorStore(storage);
  const emitted: { severity: string; summary: string }[] = [];
  const { budget } = createBudget({
    startedAtMs: 0,
    softLimitMs: options.shouldYield === true ? 0 : 600_000,
    now: () => 0,
  });
  const ctx = {
    connection_id: "conn_a",
    integration_name: "marfa.sweep-test",
    cursor,
    activity: {
      emit: (activity: { severity: string; summary: string }) => {
        emitted.push(activity);
        return Promise.resolve();
      },
    },
    budget,
  } as unknown as ConnectionContext;
  return { ctx, emitted, read: (key) => cursor.read(key) };
}

describe("the cursor key a sweep is given", () => {
  it("is refused when it already holds something else", async () => {
    // The whole defect in one fixture: a package keeps a mapping table
    // under its own key and hands that key to the driver. Every exit
    // writes the whole value, so the table would be gone after page one.
    const { ctx } = testContext();
    await ctx.cursor.write("main", {
      watermark: "w1",
      highlight_mappings: { "ext-1": "itm_1" },
    });

    await expect(
      sweep(
        ctx,
        {},
        { key: "main", page: () => Promise.resolve({ outcome: "done" }) },
      ),
    ).rejects.toThrow(/highlight_mappings/);
  });

  it("names the key and every field it would have discarded", async () => {
    const { ctx } = testContext();
    await ctx.cursor.write("main", { sync_token: "t", channel_id: "c" });

    await expect(
      sweep(
        ctx,
        {},
        { key: "main", page: () => Promise.resolve({ outcome: "done" }) },
      ),
    ).rejects.toThrow(/"main".*sync_token, channel_id/s);
  });

  it("admits a key holding only state the driver put there", async () => {
    // The control. Without it the guard could refuse everything and pass
    // both tests above.
    const { ctx } = testContext();
    await ctx.cursor.write(SWEEP_KEY, { watermark: "w1", last_sweep_id: "s1" });

    const result = await sweep(
      ctx,
      {},
      { key: SWEEP_KEY, page: () => Promise.resolve({ outcome: "done" }) },
    );
    expect(result).toEqual({ ok: true, done: true });
  });
});

describe("a page that fails", () => {
  it("is reported as a failure rather than as a finished sweep", async () => {
    const { ctx } = testContext();
    const result = await sweep(
      ctx,
      {},
      {
        key: SWEEP_KEY,
        page: () =>
          Promise.resolve({
            outcome: "failed" as const,
            reason: "the provider answered 500",
            retry: true,
          }),
      },
    );
    expect(result).toEqual({
      ok: false,
      retry: true,
      reason: "the provider answered 500",
    });
  });

  it("keeps the watermark of whatever it did write", async () => {
    // A page can fail having written some of what it read, and a
    // watermark thrown away here is work re-read on the next tick.
    const { ctx, read } = testContext();
    await sweep(
      ctx,
      {},
      {
        key: SWEEP_KEY,
        page: () =>
          Promise.resolve({
            outcome: "failed" as const,
            reason: "died halfway",
            retry: true,
            watermark: "w7",
            processed: 4,
          }),
      },
    );
    expect(await read(SWEEP_KEY)).toMatchObject({ watermark: "w7" });
  });
});

describe("a position that must survive an abandoned chain", () => {
  it("is not kept on the cursor by default", async () => {
    const { ctx, read } = testContext({ shouldYield: true });
    await sweep(
      ctx,
      {},
      {
        key: SWEEP_KEY,
        resumeAcrossSlices: true,
        page: () =>
          Promise.resolve({
            outcome: "continue" as const,
            next: "page-2",
            processed: 1,
          }),
      },
    );
    expect(await read(SWEEP_KEY)).not.toHaveProperty("position");
  });

  it("is kept, and read back by a chain that starts fresh", async () => {
    // The case the queue-payload checkpoint cannot serve: the chain was
    // abandoned, so there is no continuation to carry anything, and
    // without this the sweep walks back from the watermark.
    const { ctx, read } = testContext({ shouldYield: true });
    const spec = {
      key: SWEEP_KEY,
      resumeAcrossChains: true,
      page: () =>
        Promise.resolve({
          outcome: "continue" as const,
          next: "page-2",
          processed: 1,
        }),
    };
    await sweep(ctx, {}, spec);
    expect(await read(SWEEP_KEY)).toMatchObject({ position: "page-2" });

    const seen: unknown[] = [];
    await sweep(
      ctx,
      {},
      {
        ...spec,
        page: (input) => {
          seen.push(input.resume);
          return Promise.resolve({ outcome: "done" as const });
        },
      },
    );
    expect(seen).toEqual(["page-2"]);
  });

  it("is cleared when the sweep finishes, so the next chain starts over", async () => {
    const { ctx, read } = testContext();
    await sweep(
      ctx,
      {},
      {
        key: SWEEP_KEY,
        resumeAcrossChains: true,
        page: () =>
          Promise.resolve({ outcome: "done" as const, watermark: "w2" }),
      },
    );
    expect(await read(SWEEP_KEY)).not.toHaveProperty("position");
  });
});

describe("a source served as one document", () => {
  const atomic = {
    key: SWEEP_KEY,
    atomicUnit: true,
    // Writes nothing and parks: the shape of a slice whose whole budget
    // went on fetching the document.
    page: () =>
      Promise.resolve({
        outcome: "continue" as const,
        next: "same",
        processed: 0,
      }),
  };

  it("is not reported on a single empty attempt", async () => {
    // A provider having one bad interval looks exactly like a document
    // that will never fit. Reporting the first would make the alert mean
    // "might be nothing".
    const { ctx, emitted, read } = testContext({ shouldYield: true });
    await sweep(ctx, {}, atomic);
    expect(emitted).toEqual([]);
    expect(await read(SWEEP_KEY)).toMatchObject({ zero_progress_parks: 1 });
  });

  it("is reported once it has recurred, and only once", async () => {
    const { ctx, emitted } = testContext({ shouldYield: true });
    for (let i = 0; i < 5; i++) await sweep(ctx, {}, atomic);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.severity).toBe("action_required");
  });

  it("forgets the run of empty attempts as soon as one writes anything", async () => {
    // What separates a transient cause from a structural one. A provider
    // that recovers must not carry its two bad attempts towards an alert.
    const { ctx, emitted, read } = testContext({ shouldYield: true });
    await sweep(ctx, {}, atomic);
    await sweep(ctx, {}, atomic);
    await sweep(
      ctx,
      {},
      {
        ...atomic,
        page: () =>
          Promise.resolve({
            outcome: "continue" as const,
            next: "same",
            processed: 12,
          }),
      },
    );

    expect(await read(SWEEP_KEY)).not.toHaveProperty("zero_progress_parks");

    await sweep(ctx, {}, atomic);
    await sweep(ctx, {}, atomic);
    expect(emitted).toEqual([]);
  });

  it("says nothing about a source that is not served whole", async () => {
    // The control for the whole block: an ordinary paged sweep parks with
    // nothing written all the time, and it means nothing.
    const { ctx, emitted, read } = testContext({ shouldYield: true });
    const paged = { ...atomic, atomicUnit: false };
    for (let i = 0; i < 5; i++) await sweep(ctx, {}, paged);

    expect(emitted).toEqual([]);
    expect(await read(SWEEP_KEY)).not.toHaveProperty("zero_progress_parks");
  });
});

describe("a sweep with nothing that advances", () => {
  it("asks to be bounded by the ceilings instead", async () => {
    const { ctx } = testContext({ shouldYield: true });
    const result = await sweep(
      ctx,
      {},
      {
        key: SWEEP_KEY,
        stallGuard: "ceilings",
        page: () =>
          Promise.resolve({
            outcome: "continue" as const,
            next: 1,
            processed: 5,
          }),
      },
    );
    expect(result).toMatchObject({
      ok: true,
      done: false,
      continuation: { stallGuard: "ceilings" },
    });
  });

  it("reports the position it carried, so one that does advance is seen to", async () => {
    // The reason a watermark was mandatory in practice: without this a
    // fixed per-slice cap reports the same fingerprint every slice.
    const { ctx } = testContext({ shouldYield: true });
    const result = await sweep(
      ctx,
      {},
      {
        key: SWEEP_KEY,
        resumeAcrossSlices: true,
        page: () =>
          Promise.resolve({
            outcome: "continue" as const,
            next: "cursor-abc",
            processed: 5,
          }),
      },
    );
    expect(result).toMatchObject({
      continuation: { progress: { processed: 5, position: "cursor-abc" } },
    });
  });
});

describe("a page that answers a rate limit", () => {
  it("is not called again inside the same slice", async () => {
    // Pinned at the round trip as well, because the continuation has to
    // carry the delay onwards. Pinned here because this is where the loop
    // is: the driver used to collect `notBefore` and act on it only after
    // the loop, so a page answering a 429 was called until the allowance
    // ran out.
    const { ctx } = testContext();
    let calls = 0;
    const result = await sweep(
      ctx,
      {},
      {
        key: SWEEP_KEY,
        page: () => {
          calls += 1;
          return Promise.resolve({
            outcome: "continue" as const,
            next: calls,
            processed: 1,
            notBefore: 5_000,
          });
        },
      },
    );

    expect(calls).toBe(1);
    expect(result).toMatchObject({ continuation: { notBefore: 5_000 } });
  });
});

describe("the abort signal", () => {
  it("is the budget's, so a call in flight at the deadline is stopped", () => {
    // The signal reaching the wire is `ConnectionClient`'s half; what this
    // pins is that the budget hands out one that actually fires.
    const { budget, arm } = createBudget({ startedAtMs: 0, softLimitMs: 0 });
    vi.useFakeTimers();
    const cancel = arm();
    vi.advanceTimersByTime(1);
    expect(budget.signal.aborted).toBe(true);
    cancel();
    vi.useRealTimers();
  });
});
