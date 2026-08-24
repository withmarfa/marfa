/**
 * `reserveWithTimeout`'s contract, driven with a fake pool so the cases are
 * the ones that matter rather than the ones a real pool happens to produce.
 *
 * The case that earns the second ask is a reservation that is never granted
 * at all while the pool has a free slot. postgres.js hands the head of its
 * queue to a reconnecting connection as that connection's initial query,
 * and drops it on the floor if it is a reservation; the promise is neither
 * resolved nor rejected. Measured against 3.4.9 on a two-slot pool with no
 * other caller: the first ask never settles and a fresh ask is served in
 * about fifteen milliseconds.
 *
 * Which is why the first ask gets a short probe rather than the caller's
 * whole budget. Waiting out a reservation that will never be granted is
 * pure loss, and three of the callers sit on a request path.
 */
import { describe, expect, it, vi } from "vitest";
import { reserveWithTimeout } from "./reserve-timeout.js";
import type { PgClient } from "./connection.js";

type Reserved = Awaited<ReturnType<PgClient["reserve"]>>;

/** What postgres.js rejects a queued reservation with when its connection
 *  is going away rather than when the database has refused us. */
function lifecycleRejection(): Error {
  return Object.assign(new Error("write CONNECTION_DESTROYED"), {
    code: "CONNECTION_DESTROYED",
  });
}

/** A reserved connection that records whether it was released. */
function fakeReserved(): Reserved & { released: () => boolean } {
  let released = false;
  const conn = {
    release: () => {
      released = true;
    },
    released: () => released,
  };
  return conn as unknown as Reserved & { released: () => boolean };
}

/**
 * A pool whose `reserve()` answers are scripted, one per call. `null`
 * scripts a reservation that is never granted, which is the shape the race
 * produces: not a rejection, not a slow grant, simply nothing.
 */
function fakePool(script: (Reserved | null)[]): {
  client: PgClient;
  calls: () => number;
} {
  let calls = 0;
  const client = {
    reserve: () => {
      const next = script[calls];
      calls += 1;
      return next === null || next === undefined
        ? new Promise<Reserved>(() => {
            // Never settles. The point of the test.
          })
        : Promise.resolve(next);
    },
  };
  return { client: client as unknown as PgClient, calls: () => calls };
}

describe("reserveWithTimeout", () => {
  it("returns the connection on the first ask, without asking twice", async () => {
    const conn = fakeReserved();
    const pool = fakePool([conn]);
    const outcome = await reserveWithTimeout(pool.client, 50);
    expect(outcome.connection).toBe(conn);
    expect(outcome.attempts).toBe(1);
    expect(pool.calls()).toBe(1);
  });

  it("asks again when the first reservation is never granted, and succeeds", async () => {
    const conn = fakeReserved();
    const pool = fakePool([null, conn]);
    const outcome = await reserveWithTimeout(pool.client, 50);
    expect(outcome.connection).toBe(conn);
    expect(outcome.attempts).toBe(2);
    expect(pool.calls()).toBe(2);
  });

  it("gives up after two asks rather than three", async () => {
    const conn = fakeReserved();
    const pool = fakePool([null, null, conn]);
    const outcome = await reserveWithTimeout(pool.client, 400);
    expect(outcome.connection).toBeNull();
    expect(outcome.attempts).toBe(2);
    expect(pool.calls()).toBe(2);
  });

  it("spends a short probe on the first ask, not the whole budget", async () => {
    // The property the callers depend on: a lost first ask costs a
    // fraction of the budget, so the second one still has almost all of
    // it and the caller's worst case is unchanged.
    const conn = fakeReserved();
    const pool = fakePool([null, conn]);
    const started = performance.now();
    const outcome = await reserveWithTimeout(pool.client, 10_000);
    const elapsed = performance.now() - started;
    expect(outcome.connection).toBe(conn);
    expect(outcome.attempts).toBe(2);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("never exceeds the budget it was given", async () => {
    const pool = fakePool([null, null]);
    const started = performance.now();
    const outcome = await reserveWithTimeout(pool.client, 600);
    const elapsed = performance.now() - started;
    expect(outcome.connection).toBeNull();
    // Two asks inside one budget of 600, so a regression to spending the
    // budget per ask lands near 1200 and this sits clearly below it.
    expect(elapsed).toBeLessThan(1_000);
    expect(outcome.waitedMs).toBeLessThan(1_000);
  });

  it("treats a rejected reservation as a lost ask, not as a throw", async () => {
    // A reservation caught by a shutdown is the one rejection worth
    // absorbing: the caller has already decided what to do about having no
    // connection, and an exception from a different layer turns a shutdown
    // race into a 500. A socket error is not that, and the test below
    // asserts it is not treated as one.
    const conn = fakeReserved();
    let calls = 0;
    const client = {
      reserve: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(lifecycleRejection())
          : Promise.resolve(conn);
      },
    } as unknown as PgClient;

    const outcome = await reserveWithTimeout(client, 400);
    expect(outcome.connection).toBe(conn);
    expect(outcome.attempts).toBe(2);
  });

  it("returns nothing when both asks reject", async () => {
    const client = {
      reserve: () => Promise.reject(lifecycleRejection()),
    } as unknown as PgClient;
    const outcome = await reserveWithTimeout(client, 400);
    expect(outcome.connection).toBeNull();
    expect(outcome.attempts).toBe(2);
  });

  it("rethrows a rejection that is not the connection going away", async () => {
    // The database refusing us is not contention, and every caller here
    // says something specific about capacity when it gets nothing back.
    // Swallowing these made a rejected credential, an unreachable host and
    // the server's own connection ceiling all arrive as "no capacity right
    // now", with the cause logged nowhere.
    const refusal = Object.assign(new Error("too many connections for role"), {
      code: "53300",
    });
    let calls = 0;
    const client = {
      reserve: () => {
        calls += 1;
        return Promise.reject(refusal);
      },
    } as unknown as PgClient;
    await expect(reserveWithTimeout(client, 400)).rejects.toBe(refusal);
    // And it is not asked twice. Retrying against the ceiling this cites
    // would double the pressure on the thing that refused.
    expect(calls).toBe(1);
  });

  it("reports the wait it measured, not the timeout it was given", async () => {
    const conn = fakeReserved();
    const slow = new Promise<Reserved>((resolve) => {
      setTimeout(() => {
        resolve(conn);
      }, 10);
    });
    let calls = 0;
    const client = {
      reserve: () => {
        calls += 1;
        return slow;
      },
    } as unknown as PgClient;

    const outcome = await reserveWithTimeout(client, 5_000);
    expect(outcome.connection).toBe(conn);
    expect(calls).toBe(1);
    // The wait is what happened, well under the budget it was allowed.
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(5);
    expect(outcome.waitedMs).toBeLessThan(5_000);
  });

  it("reports a wait that spans both asks", async () => {
    const pool = fakePool([null, null]);
    const outcome = await reserveWithTimeout(pool.client, 500);
    expect(outcome.connection).toBeNull();
    // The probe plus what was left of the budget. The old shape reported
    // the budget it was given rather than the wait it took.
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(400);
  });

  it("releases an abandoned reservation that is granted after the fact", async () => {
    const conn = fakeReserved();
    let grant: ((c: Reserved) => void) | undefined;
    const late = new Promise<Reserved>((resolve) => {
      grant = resolve;
    });
    const second = fakeReserved();
    let calls = 0;
    const client = {
      reserve: () => {
        calls += 1;
        return calls === 1 ? late : Promise.resolve(second);
      },
    } as unknown as PgClient;

    const outcome = await reserveWithTimeout(client, 20);
    expect(outcome.connection).toBe(second);
    expect(conn.released()).toBe(false);

    // The pool frees a slot long after the caller gave up on the first ask.
    grant?.(conn);
    await vi.waitFor(() => {
      expect(conn.released()).toBe(true);
    });
  });
});
