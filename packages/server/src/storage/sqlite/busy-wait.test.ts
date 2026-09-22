/**
 * A write that meets the write lock waits for it without holding the
 * process, and stops waiting once the budget is spent.
 *
 * The holder in the first case is a transaction on another connection of
 * the same process, between two of its statements: the shape every request
 * transaction and every housekeeping run has while its body awaits. Such a
 * holder needs the event loop to finish, so a wait that blocks the loop
 * can only end by giving up; the heartbeat below is what tells a wait that
 * yields from one that blocks.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, LibsqlError } from "@libsql/client";
import { createConnection, untilNotBusy } from "./connection.js";

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "marfa-busy-"));
  dirs.push(dir);
  return join(dir, "marfa.db");
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function busy(): LibsqlError {
  return new LibsqlError("database is locked", "SQLITE_BUSY", undefined, 5);
}

describe("a write that meets the write lock", () => {
  it("waits for a transaction of the same process to finish, with the event loop free", async () => {
    const { raw, close } = await createConnection(scratch());
    await raw.execute("CREATE TABLE probe (n INTEGER NOT NULL)");
    await raw.execute("INSERT INTO probe (n) VALUES (0)");

    // The holder: a transaction that has written and now waits on a timer
    // before committing, as a body awaiting anything real does.
    const holder = await raw.transaction("write");
    await holder.execute("UPDATE probe SET n = n + 1");
    let committedAt = 0;
    const held = new Promise<void>((resolve) => {
      setTimeout(() => {
        void holder.commit().then(() => {
          committedAt = Date.now();
          resolve();
        });
      }, 300);
    });

    const ticks: number[] = [];
    const beat = setInterval(() => ticks.push(Date.now()), 20);
    const started = Date.now();
    await raw.execute("UPDATE probe SET n = n + 10");
    const finished = Date.now();
    clearInterval(beat);
    await held;

    // The write landed after the commit, not instead of it: both are in.
    expect(committedAt).toBeGreaterThan(0);
    expect(finished).toBeGreaterThanOrEqual(committedAt);
    const rows = (await raw.execute("SELECT n FROM probe")).rows;
    expect(rows[0]?.n).toBe(11);
    // The loop turned while the write waited. A blocking wait records no
    // tick between `started` and `finished`, because nothing runs until
    // it gives up.
    expect(
      ticks.filter((t) => t > started && t < finished).length,
    ).toBeGreaterThanOrEqual(5);
    await close();
  });

  it("lands a write the lock refused once where every connection can see it, and stays sound after", async () => {
    // The holder is another client on the file, as a sidecar's checkpoint
    // or another process is: the refusal is immediate and the connection
    // it happened on is the shared one. A connection left as the refusal
    // leaves it would take the retried write into a transaction nothing
    // can see or end, answer success, and hold the lock against everyone.
    const path = scratch();
    const { raw, close } = await createConnection(path);
    await raw.execute("CREATE TABLE probe (n INTEGER NOT NULL)");
    const other = createClient({ url: `file:${path}` });
    const holder = await other.transaction("write");
    await holder.execute("INSERT INTO probe (n) VALUES (1)");
    setTimeout(() => {
      void holder.commit();
    }, 100);
    await raw.execute("INSERT INTO probe (n) VALUES (2)");
    // Visible from a connection that took no part: the write committed.
    const witness = createClient({ url: `file:${path}` });
    const seen = (await witness.execute("SELECT n FROM probe ORDER BY n")).rows;
    expect(seen.map((row) => row.n)).toEqual([1, 2]);
    // The lock is free for others, and the wrapper's own connection opens
    // a transaction with a savepoint, which the refusal had broken.
    const theirs = await other.transaction("write");
    await theirs.execute("INSERT INTO probe (n) VALUES (3)");
    await theirs.commit();
    const ours = await raw.transaction("write");
    await ours.execute("SAVEPOINT sp0");
    await ours.execute("INSERT INTO probe (n) VALUES (4)");
    await ours.execute("RELEASE sp0");
    await ours.commit();
    const all = (await witness.execute("SELECT n FROM probe ORDER BY n")).rows;
    expect(all.map((row) => row.n)).toEqual([1, 2, 3, 4]);
    witness.close();
    other.close();
    await close();
  });

  it("lands every one of several writes that met the lock together", async () => {
    // Writes issued in one tick, so their retries interleave: none may run
    // on the connection another's refusal has just spoiled.
    const path = scratch();
    const { raw, close } = await createConnection(path);
    await raw.execute("CREATE TABLE probe (n INTEGER NOT NULL)");
    const other = createClient({ url: `file:${path}` });
    const holder = await other.transaction("write");
    await holder.execute("INSERT INTO probe (n) VALUES (0)");
    setTimeout(() => {
      void holder.commit();
    }, 60);
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        raw.execute({ sql: "INSERT INTO probe (n) VALUES (?)", args: [n] }),
      ),
    );
    const witness = createClient({ url: `file:${path}` });
    const seen = (await witness.execute("SELECT n FROM probe ORDER BY n")).rows;
    expect(seen.map((row) => row.n)).toEqual([0, 1, 2, 3, 4, 5]);
    witness.close();
    other.close();
    await close();
  });

  it("stops waiting once the budget is spent, and names the contention", async () => {
    let attempts = 0;
    const started = Date.now();
    await expect(
      untilNotBusy(() => {
        attempts += 1;
        return Promise.reject(busy());
      }, 60),
    ).rejects.toMatchObject({
      // Not the driver's `SQLITE_BUSY`, which reached the error handler
      // as something it had no code for and became a `500` — the one
      // failure that clears itself, reported as the instance being
      // broken.
      code: "write_contention",
      status: 503,
      details: { budget_ms: 60 },
    });
    // The whole budget, then one last try at the deadline.
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(attempts).toBeGreaterThan(2);
  });

  it("sees the lock through a wrapper that re-threw it", async () => {
    // Drizzle wraps every statement's failure in a `DrizzleQueryError`
    // carrying the original as `cause`, and the check used to read the
    // top-level `code` alone — so a busy refusal arriving through a
    // Drizzle call was never retried at all, and the loop looked like it
    // worked because the refusals that did reach it came through the raw
    // client.
    let attempts = 0;
    await expect(
      untilNotBusy(() => {
        attempts += 1;
        return Promise.reject(
          Object.assign(new Error("Failed query: insert into ..."), {
            cause: busy(),
          }),
        );
      }, 60),
    ).rejects.toMatchObject({ code: "write_contention" });
    expect(attempts, "a wrapped busy refusal was not retried").toBeGreaterThan(
      2,
    );
  });

  it("does not retry a refusal that is not the lock", async () => {
    let attempts = 0;
    await expect(
      untilNotBusy(() => {
        attempts += 1;
        return Promise.reject(
          new LibsqlError(
            "UNIQUE constraint failed",
            "SQLITE_CONSTRAINT",
            undefined,
            19,
          ),
        );
      }, 60),
    ).rejects.toMatchObject({ code: "SQLITE_CONSTRAINT" });
    expect(attempts).toBe(1);
  });
});
