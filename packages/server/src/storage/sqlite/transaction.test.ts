/**
 * Proves `runInTransaction` is genuinely transactional on SQLite.
 *
 * With libsql + the AsyncLocalStorage routing in `request-context.ts`,
 * every store call inside `fn` flows through the active transaction
 * and rolls back together on throw.
 *
 * Three tests cover the contract:
 *   1. Throw mid-tx → both writes roll back.
 *   2. Successful tx → both writes persist.
 *   3. Every transaction gives back the file handles it opened.
 */

import { itemWrites } from "../item-writes.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, setBusyBudgetMs, type RawDb } from "./connection.js";
import { createSqliteStorage } from "./index.js";
import type { Storage } from "../interface.js";

describe("SqliteStorage.runInTransaction", () => {
  let tmpDir: string;
  let storage: Storage;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "marfa-tx-test-"));
    storage = await createSqliteStorage(join(tmpDir, "tx.db"));
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rolls back every write inside an async transaction body when the body throws", async () => {
    await expect(
      storage.runInTransaction(async () => {
        await itemWrites(storage).create({
          writer: null,
          id: "019d1111-1111-7111-a111-111111111111",
          type: "core.note",
          properties: { body: "rollback-alpha" },
        });
        await itemWrites(storage).create({
          writer: null,
          id: "019d1111-1111-7111-a111-111111111112",
          type: "core.note",
          properties: { body: "rollback-bravo" },
        });
        throw new Error("force rollback");
      }),
    ).rejects.toThrow(/force rollback/);

    expect(
      await storage.items.get("019d1111-1111-7111-a111-111111111111"),
    ).toBeNull();
    expect(
      await storage.items.get("019d1111-1111-7111-a111-111111111112"),
    ).toBeNull();
  });

  it("commits every write when the transaction body resolves", async () => {
    await storage.runInTransaction(async () => {
      await itemWrites(storage).create({
        writer: null,
        id: "019d2222-2222-7222-a222-222222222221",
        type: "core.note",
        properties: { body: "commit-alpha" },
      });
      await itemWrites(storage).create({
        writer: null,
        id: "019d2222-2222-7222-a222-222222222222",
        type: "core.note",
        properties: { body: "commit-bravo" },
      });
    });

    const a = await storage.items.get("019d2222-2222-7222-a222-222222222221");
    const b = await storage.items.get("019d2222-2222-7222-a222-222222222222");
    expect(a?.properties.body).toBe("commit-alpha");
    expect(b?.properties.body).toBe("commit-bravo");
  });

  it("gives back the connection each transaction opened, committed or rolled back", async () => {
    // Counted on the process's descriptor table rather than asked of the
    // driver: a connection the driver has let go of but not closed keeps
    // the database and its log open until the collector finds it, and only
    // the table shows that.
    const open = () => readdirSync("/dev/fd").length;
    const write = (n: number) =>
      itemWrites(storage).create({
        writer: null,
        id: `019d3333-3333-7333-a333-${String(n).padStart(12, "0")}`,
        type: "core.note",
        properties: { body: `handle-${String(n)}` },
      });

    await storage.runInTransaction(() => write(0));
    const before = open();
    for (let n = 1; n <= 100; n++) {
      await storage.runInTransaction(() => write(n));
      await expect(
        storage.runInTransaction(async () => {
          await write(1000 + n);
          throw new Error("force rollback");
        }),
      ).rejects.toThrow(/force rollback/);
    }
    const after = open();

    // The transactions ran: every commit landed and no rollback did.
    expect(
      await storage.items.get("019d3333-3333-7333-a333-000000000100"),
    ).not.toBeNull();
    expect(
      await storage.items.get("019d3333-3333-7333-a333-000000001100"),
    ).toBeNull();
    // Two hundred transactions each holding the file open would add
    // hundreds; a few is the slack for whatever else the worker opens.
    expect(after - before).toBeLessThanOrEqual(4);
  });
});

describe("a raw transaction", () => {
  let tmpDir: string;
  let raw: RawDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "marfa-rawtx-test-"));
    ({ raw, close } = await createConnection(join(tmpDir, "tx.db")));
    await raw.execute("CREATE TABLE probe (n INTEGER NOT NULL)");
  });

  afterEach(async () => {
    await close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const values = async () =>
    (await raw.execute("SELECT n FROM probe ORDER BY n")).rows.map(
      (row) => row.n,
    );

  it("waits for another to finish, and both land", async () => {
    const first = await raw.transaction("write");
    await first.execute("INSERT INTO probe (n) VALUES (1)");
    const second = raw.transaction("write").then(async (tx) => {
      await tx.execute("INSERT INTO probe (n) VALUES (2)");
      await tx.commit();
    });
    setTimeout(() => {
      void first.commit();
    }, 50);
    await second;
    expect(await values()).toEqual([1, 2]);
  });

  it("waits for another of this process without opening a connection per try", async () => {
    const open = () => readdirSync("/dev/fd").length;
    const warm = await raw.transaction("write");
    await warm.commit();
    const before = open();
    const first = await raw.transaction("write");
    await first.execute("INSERT INTO probe (n) VALUES (1)");
    setTimeout(() => {
      void first.commit();
    }, 500);
    const second = await raw.transaction("write");
    await second.execute("INSERT INTO probe (n) VALUES (2)");
    await second.commit();
    expect(await values()).toEqual([1, 2]);
    // A wait spent retrying a refused `BEGIN` leaves a connection behind
    // for every try, which half a second of backoff makes a dozen or more.
    expect(open() - before).toBeLessThanOrEqual(4);
  });

  it("gives up waiting once the budget is spent, and the next still gets its turn", async () => {
    setBusyBudgetMs(50);
    try {
      const first = await raw.transaction("write");
      await first.execute("INSERT INTO probe (n) VALUES (1)");
      await expect(raw.transaction("write")).rejects.toMatchObject({
        code: "write_contention",
        status: 503,
      });
      await first.commit();
      const third = await raw.transaction("write");
      await third.execute("INSERT INTO probe (n) VALUES (3)");
      await third.commit();
      expect(await values()).toEqual([1, 3]);
    } finally {
      setBusyBudgetMs(5_000);
    }
  });

  it("refuses to begin once the client is closed", async () => {
    const tx = await raw.transaction("write");
    await tx.commit();
    raw.close();
    await expect(raw.transaction("write")).rejects.toMatchObject({
      code: "CLIENT_CLOSED",
    });
  });

  it("rolls back on close and serves the next transaction", async () => {
    const open = () => readdirSync("/dev/fd").length;
    const warm = await raw.transaction("write");
    await warm.commit();
    const before = open();
    for (let n = 0; n < 50; n++) {
      const tx = await raw.transaction("write");
      await tx.execute({ sql: "INSERT INTO probe (n) VALUES (?)", args: [n] });
      tx.close();
      expect(tx.closed).toBe(true);
    }
    const tx = await raw.transaction("write");
    await tx.execute("INSERT INTO probe (n) VALUES (99)");
    await tx.commit();
    expect(await values()).toEqual([99]);
    expect(open() - before).toBeLessThanOrEqual(4);
  });

  it("refuses a statement once SQLite has ended the transaction", async () => {
    const tx = await raw.transaction("write");
    await tx.execute("INSERT INTO probe (n) VALUES (1)");
    // Ends the transaction behind the object's back, as a full disk can.
    await tx.execute("ROLLBACK");
    await expect(tx.execute("SELECT nothing FROM nowhere")).rejects.toThrow();
    expect(tx.closed).toBe(true);
    // Run, it would have committed on its own outside any transaction.
    await expect(
      tx.execute("INSERT INTO probe (n) VALUES (2)"),
    ).rejects.toMatchObject({ code: "TRANSACTION_CLOSED" });
    await tx.rollback();
    expect(await values()).toEqual([]);
  });
});
