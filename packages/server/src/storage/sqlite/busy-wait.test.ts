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
import { LibsqlError } from "@libsql/client";
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

  it("stops waiting once the budget is spent, and the refusal is the lock's", async () => {
    let attempts = 0;
    const started = Date.now();
    await expect(
      untilNotBusy(() => {
        attempts += 1;
        return Promise.reject(busy());
      }, 60),
    ).rejects.toMatchObject({ code: "SQLITE_BUSY" });
    // The whole budget, then one last try at the deadline.
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(attempts).toBeGreaterThan(2);
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
