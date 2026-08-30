/**
 * The contract driven end to end: a handler parks, the runtime enqueues
 * the next slice, and the slice that arrives can pick up where the last
 * one stopped.
 *
 * These live here rather than in `runtime-sdk` because the thing worth
 * proving is the round trip, and the harness is the only place a
 * continuation actually goes back onto a queue and comes off it again. A
 * test that called `sweep()` directly and inspected its return value
 * would pass whether or not anything carried that return value anywhere.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetHandlers,
  registerScheduleHandler,
  sweep,
  type ConnectionContext,
  type ScheduleMessage,
} from "@withmarfa/runtime-sdk";
import { createTestHarness } from "./harness.js";

const INTEGRATION = "marfa.resumption-test";

function scheduleMessage(connectionId: string): ScheduleMessage {
  return {
    kind: "schedule",
    integration_name: INTEGRATION,
    connection_id: connectionId,
    scheduled_for_ms: 1_000,
  };
}

beforeEach(() => {
  _resetHandlers();
});

describe("a handler that parks", () => {
  it("has its continuation enqueued rather than acked away", async () => {
    // softLimitMs: 0 — the budget is already spent when the handler
    // starts, which is a real state a backed-up queue produces. So the
    // sweep yields after its first page.
    const harness = createTestHarness({
      integrationName: INTEGRATION,
      softLimitMs: 0,
    });
    registerScheduleHandler((ctx, message) =>
      sweep(ctx, message, {
        key: "main",
        page: ({ resume }) =>
          Promise.resolve({
            next: ((resume as number | undefined) ?? 0) + 1,
            watermark: `w${String(((resume as number | undefined) ?? 0) + 1)}`,
            processed: 1,
          }),
        resumeAcrossSlices: true,
      }),
    );

    await harness.connection("conn_a").send(scheduleMessage("conn_a"));
    const outcome = await harness.consume();

    // Acked — the slice itself is finished with. The ack is NOT what
    // distinguishes a parked sweep from a completed one, which is why
    // the continuation is asserted separately below.
    expect(outcome.acked).toBe(1);
    expect(harness.continuations).toHaveLength(1);

    const enqueued = harness.continuations[0]?.message;
    expect(enqueued?.kind).toBe("schedule");
    expect((enqueued as ScheduleMessage | undefined)?.continuation?.slice).toBe(
      1,
    );
    expect(
      (enqueued as ScheduleMessage | undefined)?.continuation?.resume,
    ).toBe(1);
  });

  it("delivers the resume payload to the next slice, and the chain id agrees", async () => {
    // The regression this exists for: the driver recorded one chain id in
    // the cursor while the runtime stamped a different one on the
    // envelope, so slice two was rejected as a straggler from an
    // abandoned chain. A single-slice test cannot see it — the ids only
    // meet on the second delivery.
    const harness = createTestHarness({
      integrationName: INTEGRATION,
      softLimitMs: 0,
    });
    const seen: {
      resume: unknown;
      sweepId: string;
      slice: number;
    }[] = [];
    registerScheduleHandler((ctx: ConnectionContext, message) =>
      sweep(ctx, message, {
        key: "main",
        page: ({ resume, sweepId, slice }) => {
          const at = (resume as number | undefined) ?? 0;
          seen.push({ resume, sweepId, slice });
          // Ends on the third page, so the chain terminates rather than
          // running to the harness's slice ceiling.
          return Promise.resolve(
            at >= 2
              ? { watermark: `w${String(at)}`, processed: 1 }
              : { next: at + 1, watermark: `w${String(at + 1)}`, processed: 1 },
          );
        },
        resumeAcrossSlices: true,
      }),
    );

    await harness.connection("conn_a").send(scheduleMessage("conn_a"));
    const outcomes = await harness.consumeUntilDone();

    // Three deliveries: the original plus two continuations.
    expect(outcomes).toHaveLength(3);
    expect(seen.map((s) => s.resume)).toEqual([undefined, 1, 2]);
    expect(seen.map((s) => s.slice)).toEqual([0, 1, 2]);

    // One chain, one id, across every slice. This is the assertion the
    // defect would have failed.
    const ids = new Set(seen.map((s) => s.sweepId));
    expect(ids.size).toBe(1);

    // No failures anywhere — a rejected straggler would surface here.
    expect(outcomes.every((o) => o.failed === 0)).toBe(true);

    // Finished: the watermark is kept, the open-chain marker is cleared so
    // the next tick starts fresh, and the finished chain's id is retained
    // so a slice arriving late from it is recognised as belonging to a
    // chain that is over rather than reopening one.
    const state = (await harness
      .connection("conn_a")
      .storage.get("cursor:main")) as {
      watermark?: string;
      signpost?: string;
      sweep_id?: string;
      last_sweep_id?: string;
    };
    expect(state.watermark).toBe("w2");
    expect(state.sweep_id).toBeUndefined();
    expect(state.signpost).toBeUndefined();
    expect(state.last_sweep_id).toBe(seen[0]?.sweepId);
  });

  it("drops a provider page token across a slice unless the author opts in", async () => {
    // The default. A token valid for hours and one valid for five minutes
    // have the same type, so the driver re-derives from the watermark
    // rather than carrying something it cannot reason about.
    const harness = createTestHarness({
      integrationName: INTEGRATION,
      softLimitMs: 0,
    });
    const resumes: unknown[] = [];
    registerScheduleHandler((ctx, message) =>
      sweep(ctx, message, {
        key: "main",
        page: ({ resume, watermark }) => {
          resumes.push(resume);
          // Finish once the watermark says the first page landed, so the
          // chain is two slices rather than unbounded.
          return Promise.resolve(
            watermark === "w1"
              ? { watermark: "w1", processed: 0 }
              : { next: "provider-token", watermark: "w1", processed: 1 },
          );
        },
      }),
    );

    await harness.connection("conn_a").send(scheduleMessage("conn_a"));
    await harness.consumeUntilDone();

    // Slice two got no token — it re-derives from the committed watermark.
    expect(resumes).toEqual([undefined, undefined]);
    expect(harness.continuations[0]?.message).toBeDefined();
    expect(
      (harness.continuations[0]?.message as ScheduleMessage | undefined)
        ?.continuation?.resume,
    ).toBeNull();
  });

  it("carries a notBefore through to the enqueued slice", async () => {
    const harness = createTestHarness({
      integrationName: INTEGRATION,
      softLimitMs: 0,
    });
    registerScheduleHandler((ctx, message) =>
      sweep(ctx, message, {
        key: "main",
        page: () =>
          Promise.resolve({
            next: 1,
            processed: 0,
            notBefore: 5_000,
          }),
      }),
    );

    await harness.connection("conn_a").send(scheduleMessage("conn_a"));
    await harness.consume();

    expect(harness.continuations[0]?.notBefore).toBe(5_000);
  });

  it("stops calling a page that has asked not to be resumed yet", async () => {
    // A real budget, rather than the `softLimitMs: 0` its sibling above
    // uses, is what makes this a test about `notBefore` at all: with the
    // budget already spent the loop breaks on the yield check whatever the
    // page returned, so that test passes against a driver which ignores
    // `notBefore` entirely.
    const harness = createTestHarness({ integrationName: INTEGRATION });
    let calls = 0;
    registerScheduleHandler((ctx, message) =>
      sweep(ctx, message, {
        key: "main",
        page: () => {
          calls += 1;
          return Promise.resolve({
            next: calls,
            processed: 1,
            notBefore: 5_000,
          });
        },
      }),
    );

    await harness.connection("conn_a").send(scheduleMessage("conn_a"));
    await harness.consume();

    // The case this exists for is a 429, where calling the provider again
    // inside the same slice is the one response that cannot help.
    expect(calls).toBe(1);
    expect(harness.continuations[0]?.notBefore).toBe(5_000);
  });

  it("a sweep that finishes inside one slice never enqueues anything", async () => {
    // The control. Without it, a driver that parked unconditionally would
    // pass every test above.
    const harness = createTestHarness({ integrationName: INTEGRATION });
    registerScheduleHandler((ctx, message) =>
      sweep(ctx, message, {
        key: "main",
        page: () => Promise.resolve({ watermark: "w9", processed: 3 }),
      }),
    );

    await harness.connection("conn_a").send(scheduleMessage("conn_a"));
    const outcome = await harness.consume();

    expect(outcome.acked).toBe(1);
    expect(harness.continuations).toHaveLength(0);
  });
});
