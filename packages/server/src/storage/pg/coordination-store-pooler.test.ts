/**
 * The property `coordination-store.test.ts` cannot observe: the
 * Connection lifecycle lock must still exclude when the app talks to a
 * transaction-mode pooler.
 *
 * `coordination-store.test.ts` runs against a direct Postgres, where a
 * reserved connection owns a backend for its whole life and every shape
 * of advisory lock behaves identically. The hosted container does not
 * run that way — it declares `MARFA_DB_POOL_MODE=transaction` — and
 * behind PgBouncer a reserved link is not a backend. A server connection
 * is assigned per transaction, and a bare statement is its own
 * transaction, so a session-scoped `pg_advisory_lock` lands on whichever
 * backend was free and the matching unlock need not reach it.
 *
 * Two things follow, both measured below rather than argued: two callers
 * hold one lock at the same time, and a lock outlives the client that
 * took it. For a lock whose whole purpose is serializing a runtime
 * credential mint against the uninstall that revokes it, the first is
 * the race left open; the second is a request that blocks forever
 * holding a pool slot.
 *
 * The first case pins the premise by hand — the session-scoped shape the
 * store used to have — so the guard rests on the database's behavior
 * rather than on a comment. The rest exercise the store itself.
 *
 * Opt-in. Ordinary CI has no PgBouncer, so the suite skips unless both
 * URLs are present. To run it, put a PgBouncer in `pool_mode =
 * transaction` in front of a Postgres instance and point the two
 * variables at the pooled and unpooled endpoints of the same database:
 *
 *   MARFA_TEST_PGBOUNCER_URL=postgres://…@pooler-host:6432/db
 *   MARFA_TEST_PGBOUNCER_DIRECT_URL=postgres://…@pg-host:5432/db
 *
 * Set `default_pool_size = 1`. The premise case needs the two clients to
 * share a backend, and with a larger pool they get one each — a session-
 * scoped lock then excludes correctly and the case fails, reporting a
 * pooler-safe database rather than a misconfigured fixture.
 */
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { PgCoordinationStore } from "./coordination-store.js";
import type { PgClient, PgDb } from "./connection.js";

/**
 * Every case here exercises `withExclusiveLock`, which holds its own
 * connection and never consults the Drizzle instance. The instance is still
 * built over the same client so the store is constructed the way production
 * constructs it.
 */
const storeOn = (client: PgClient): PgCoordinationStore =>
  new PgCoordinationStore(client, drizzle(client));

/**
 * Run `fn` inside a Drizzle transaction with `name` locked on it, which is
 * what a quota reservation does: production reaches the same object through
 * the request-context proxy, which resolves to the ambient Drizzle
 * transaction. `tx` satisfies the `execute` surface the store uses; the cast
 * is because Drizzle types a transaction as its own narrower type.
 */
async function withLockOnTransaction<T>(
  client: PgClient,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const db = drizzle(client);
  return await db.transaction(async (tx) => {
    await new PgCoordinationStore(
      client,
      tx as unknown as PgDb,
    ).lockInTransaction(name);
    return await fn();
  });
}

const pooledUrl = process.env.MARFA_TEST_PGBOUNCER_URL ?? "";
const directUrl = process.env.MARFA_TEST_PGBOUNCER_DIRECT_URL ?? "";
const enabled = pooledUrl !== "" && directUrl !== "";

/**
 * Lock names are unique per run. A stranded lock is the thing being
 * measured, and it survives on the pooler's backend for as long as that
 * backend lives — so a second run against the same PgBouncer would start
 * against locks the first run left, and a blocking acquire on a reused
 * name would wait forever.
 */
const RUN = Math.random().toString(36).slice(2, 10);
const LOCK_NAME = `connection-lifecycle:pooler-probe-${RUN}`;

function pool(url: string): PgClient {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  return postgres(url, { max: 10, onnotice: () => {} });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * The shape the store used to have: reserve, lock, run, unlock, release.
 * Kept here and nowhere else, so the assertion below is about what a
 * pooler does to it rather than about what the store happens to contain.
 */
async function withSessionScopedLock<T>(
  client: PgClient,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `marfa:${name}`;
  const conn = await client.reserve();
  try {
    await conn`SELECT pg_advisory_lock(hashtextextended(${key}, 0))`;
    try {
      return await fn();
    } finally {
      await conn`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`;
    }
  } finally {
    conn.release();
  }
}

/** Highest number of callers inside one lock at the same moment. */
async function peakConcurrentHolders(
  take: <T>(client: PgClient, name: string, fn: () => Promise<T>) => Promise<T>,
  url: string,
  name: string,
): Promise<number> {
  // Two clients against one database stand in for two server processes.
  const a = pool(url);
  const b = pool(url);
  let inFlight = 0;
  let peak = 0;
  const work = async (): Promise<void> => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await sleep(300);
    inFlight -= 1;
  };
  try {
    await Promise.all([take(a, name, work), take(b, name, work)]);
  } finally {
    await a.end();
    await b.end();
  }
  return peak;
}

/**
 * Whether anything on the server still holds this lock, asked from the
 * direct endpoint so the question reaches a session of its own.
 *
 * A try-acquire rather than a `pg_locks` count: it is specific to the
 * key, so it cannot be confused by a lock some other case left behind,
 * and it needs no reconstruction of the 64-bit key from the two oid
 * columns `pg_locks` splits it across.
 */
async function lockIsHeld(name: string): Promise<boolean> {
  const key = `marfa:${name}`;
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  const admin = postgres(directUrl, { max: 1, onnotice: () => {} });
  try {
    const rows = await admin<{ got: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtextextended(${key}, 0)) AS got
    `;
    const got = rows[0]?.got === true;
    if (got) {
      await admin`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`;
    }
    return !got;
  } finally {
    await admin.end();
  }
}

describe.skipIf(!enabled)(
  "the Connection lifecycle lock over a transaction-mode pooler",
  () => {
    it("does not exclude when the lock is session-scoped", async () => {
      // Why the store cannot take a session-scoped lock here. Every
      // observable signal reads healthy — the statements succeed, the
      // reservation is genuine — and two callers are inside the critical
      // section anyway.
      expect(
        await peakConcurrentHolders(
          withSessionScopedLock,
          pooledUrl,
          `${LOCK_NAME}:session`,
        ),
      ).toBeGreaterThan(1);
    });

    it("strands a session-scoped lock past the client that took it", async () => {
      // The second failure, and the one with no symptom until something
      // blocks on it: a real session drops its locks when the client
      // disconnects, and a pooled backend outlives the client entirely.
      const name = `${LOCK_NAME}:strand`;
      const key = `marfa:${name}`;
      expect(await lockIsHeld(name)).toBe(false);

      const held = pool(pooledUrl);
      const conn = await held.reserve();
      await conn`SELECT pg_advisory_lock(hashtextextended(${key}, 0))`;
      conn.release();
      await held.end();
      await sleep(500);

      expect(await lockIsHeld(name)).toBe(true);
    });

    it("excludes concurrent holders", async () => {
      // The store's own lock, over the endpoint the hosted container
      // actually points at. A transaction is the unit a pooler keeps on
      // one backend, so a transaction-scoped lock is acquired and
      // released on the same one by construction.
      const take = <T>(
        client: PgClient,
        name: string,
        fn: () => Promise<T>,
      ): Promise<T> => storeOn(client).withExclusiveLock(name, fn);
      expect(await peakConcurrentHolders(take, pooledUrl, LOCK_NAME)).toBe(1);
    });

    it("excludes concurrent holders when the lock rides the caller's transaction", async () => {
      // The shape a quota reservation uses: the caller owns the
      // transaction, the lock is taken inside it as a statement, and it
      // releases on that transaction's commit. Same pooler-safety argument
      // as `withExclusiveLock` — the transaction is the unit a pooler keeps
      // on one backend — but it has to be measured, not assumed, because a
      // session-scoped lock in this position would also succeed at every
      // statement while excluding nothing.
      expect(
        await peakConcurrentHolders(
          withLockOnTransaction,
          pooledUrl,
          `${LOCK_NAME}:in-tx`,
        ),
      ).toBe(1);
    });

    it("releases a transaction-scoped lock on commit and on rollback", async () => {
      // A reservation that stranded its lock would wedge every later write
      // of the same resource in that space, and the throw path is the one
      // that matters: refusing a write over quota is the ordinary outcome,
      // not the exceptional one.
      const name = `${LOCK_NAME}:in-tx-release`;
      const client = pool(pooledUrl);
      try {
        await withLockOnTransaction(client, name, () => Promise.resolve());
        expect(await lockIsHeld(name)).toBe(false);

        await expect(
          withLockOnTransaction(client, name, () => {
            throw new Error("quota_exceeded");
          }),
        ).rejects.toThrow("quota_exceeded");
        expect(await lockIsHeld(name)).toBe(false);
      } finally {
        await client.end();
      }
    });

    it("leaves no lock behind, on either exit path", async () => {
      // A lock stranded by the blocking gate is the failure that hangs a
      // request holding a pool slot, so both exits have to release: the
      // ordinary one and the throw a mint's own state check produces.
      const name = `${LOCK_NAME}:release`;
      const client = pool(pooledUrl);
      const store = storeOn(client);
      try {
        await store.withExclusiveLock(name, () => Promise.resolve());
        expect(await lockIsHeld(name)).toBe(false);

        await expect(
          store.withExclusiveLock(name, () => {
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
        expect(await lockIsHeld(name)).toBe(false);
      } finally {
        await client.end();
      }
    });
  },
);
