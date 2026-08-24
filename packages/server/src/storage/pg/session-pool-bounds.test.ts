/**
 * The session pool's exhaustion behavior, driven rather than reasoned
 * about: real clients, real reservations, every slot genuinely held.
 *
 * The pool is five slots shared by streams and job-lock ticks, and it
 * once served an unbounded queue — the reactive-run drainer held one
 * slot for the process lifetime, four concurrent streams took the rest,
 * and then every background tick and the on-request token refresh
 * waited forever. The bounds under test: a job tick that cannot reserve
 * skips (`undefined`, its normal contention shape), a stream request
 * fails with the typed exhaustion error the routes turn into 503, and
 * both recover as soon as a slot frees. The permanent holder now lives
 * on its own single-connection client, covered last.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { PgCoordinationStore } from "./coordination-store.js";
import { acquireStreamRls, StreamPoolExhaustedError } from "./streaming-rls.js";
import type { PgClient } from "./connection.js";

const isPg = process.env.DB_DIALECT === "pg";
// Everything under test is connection mechanics — reservations, advisory
// locks, session GUCs — none of which needs the marfa schema. The admin URL
// always resolves under test:pg, and `marfa_app` (a cluster-wide role) exists
// once the global setup has built the test template.
const databaseUrl =
  process.env.MARFA_TEST_PG_ADMIN_URL ?? process.env.DATABASE_URL ?? "";

describe.skipIf(!isPg || databaseUrl === "")("session pool bounds", () => {
  let tiny: PgClient;

  beforeAll(() => {
    tiny = postgres(databaseUrl, { max: 1 });
  });

  afterAll(async () => {
    await (tiny as unknown as { end: () => Promise<void> }).end();
  });

  it("a job tick skips rather than queueing behind an exhausted pool, and runs once a slot frees", async () => {
    const store = new PgCoordinationStore(
      tiny,
      drizzle(tiny) as never,
      tiny,
      tiny,
      200,
    );
    const holder = await tiny.reserve();
    try {
      const skipped = await store.withJobLock("bounds-probe", () =>
        Promise.resolve("ran"),
      );
      expect(skipped).toBeUndefined();
    } finally {
      holder.release();
    }
    const ran = await store.withJobLock("bounds-probe", () =>
      Promise.resolve("ran"),
    );
    expect(ran).toBe("ran");
  });

  it("a stream reservation fails typed on exhaustion, and acquires once a slot frees", async () => {
    const holder = await tiny.reserve();
    try {
      await expect(
        acquireStreamRls(tiny, "bounds-space", { reserveTimeoutMs: 200 }),
      ).rejects.toBeInstanceOf(StreamPoolExhaustedError);
    } finally {
      holder.release();
    }
    const ctx = await acquireStreamRls(tiny, "bounds-space", {
      reserveTimeoutMs: 200,
    });
    await ctx.release();
  });

  it("timed-out reservations do not leak the slots they gave up waiting for", async () => {
    const holder = await tiny.reserve();
    const attempt = acquireStreamRls(tiny, "bounds-space", {
      reserveTimeoutMs: 100,
    });
    await expect(attempt).rejects.toBeInstanceOf(StreamPoolExhaustedError);
    // Free the slot AFTER the timeouts. Both abandoned reservations, one
    // per ask, are granted in turn and must release themselves, or this
    // second acquire would hang behind whichever still held one.
    holder.release();
    const ctx = await acquireStreamRls(tiny, "bounds-space", {
      reserveTimeoutMs: 2_000,
    });
    await ctx.release();
  });

  it("the long-lived holder gives up rather than waiting forever", async () => {
    // The election loop that drives this has no timer of its own: it calls,
    // waits, and retries when it gets nothing. An unbounded reserve here
    // therefore does not delay an election, it ends them, and the only
    // symptom is that the reactive bridge quietly stops draining with no
    // takeover when the elected process dies.
    const jobHolder = postgres(databaseUrl, { max: 1 });
    try {
      // No reserve timeout argument: it feeds the ordinary job lock, and
      // the holder carries its own constant.
      const store = new PgCoordinationStore(
        tiny,
        drizzle(tiny) as never,
        tiny,
        jobHolder,
      );
      // Nothing else can reserve from a one-connection client that is
      // already fully reserved, which is what a destroyed reservation
      // leaves behind from the caller's point of view.
      const held = await jobHolder.reserve();
      try {
        const started = Date.now();
        const result = await store.withLongLivedJobLock("bounds-holder", () =>
          Promise.resolve("held"),
        );
        expect(result).toBeUndefined();
        // Bounded, and comfortably inside the election's own retry period.
        expect(Date.now() - started).toBeLessThan(20_000);
      } finally {
        held.release();
      }
      // And it elects normally once the client is free again.
      expect(
        await store.withLongLivedJobLock("bounds-holder", () =>
          Promise.resolve("held"),
        ),
      ).toBe("held");
    } finally {
      await (jobHolder as unknown as { end: () => Promise<void> }).end();
    }
  }, 30_000);

  it("the long-lived holder takes nothing from the shared pool", async () => {
    const jobHolder = postgres(databaseUrl, { max: 1 });
    try {
      const store = new PgCoordinationStore(
        tiny,
        drizzle(tiny) as never,
        tiny,
        jobHolder,
        200,
      );
      // Exhaust the shared pool the way concurrent streams would.
      const holder = await tiny.reserve();
      try {
        // The permanent holder still elects: its reservation comes from
        // its own client, not the exhausted shared pool.
        let elected = false;
        const result = await store.withLongLivedJobLock(
          "bounds-drainer",
          () => {
            elected = true;
            return Promise.resolve("held");
          },
        );
        expect(result).toBe("held");
        expect(elected).toBe(true);
        // And an ordinary tick still skips, proving the shared pool really
        // was exhausted throughout.
        expect(
          await store.withJobLock("bounds-probe", () => Promise.resolve("x")),
        ).toBeUndefined();
      } finally {
        holder.release();
      }
    } finally {
      await (jobHolder as unknown as { end: () => Promise<void> }).end();
    }
  });
});
