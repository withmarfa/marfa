import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorage } from "./index.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const modes = [
  {
    name: "file path",
    journal: "wal",
    path: (dir: string) => join(dir, "test.db"),
  },
  {
    name: "file URL",
    journal: "wal",
    path: (dir: string) => `file:${join(dir, "test.db")}`,
  },
  { name: "memory", journal: "memory", path: () => ":memory:" },
  {
    name: "shared memory URL",
    journal: "memory",
    path: () => "file::memory:?cache=shared",
  },
];
let storage: Awaited<ReturnType<typeof createSqliteStorage>> | undefined;
let directory: string | undefined;

afterEach(async () => {
  await storage?.close();
  storage = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

it.each(
  modes.flatMap((mode) => [
    { ...mode, outcome: "commit" },
    { ...mode, outcome: "rollback" },
  ]),
)(
  "$name captures committed settings around a held writer's $outcome",
  async (mode) => {
    directory = mkdtempSync(join(tmpdir(), "marfa-snapshot-modes-"));
    const db = (storage = await createSqliteStorage(mode.path(directory)));
    expect(await db.__sqliteAll("PRAGMA journal_mode")).toMatchObject([
      { journal_mode: mode.journal },
    ]);
    await db.settings.set("snapshot.probe", "before");
    const entered = gate(),
      release = gate();
    const rollback = new Error("rollback witness");
    const writer = db
      .runInTransaction(async () => {
        await db.settings.set("snapshot.probe", "after");
        entered.resolve();
        await release.promise;
        if (mode.outcome === "rollback") throw rollback;
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await entered.promise;
    let state: unknown = "pending";
    const reading = db
      .runInReadSnapshot(() => db.settings.get("snapshot.probe"))
      .then(
        (value) => {
          state = "fulfilled";
          return { value };
        },
        (error: unknown) => {
          state = error;
          return { error };
        },
      );
    try {
      if (mode.journal === "wal") {
        expect(await reading).toEqual({ value: "before" });
      } else {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(state).toBe("pending");
      }
    } finally {
      release.resolve();
      expect(await writer).toBe(
        mode.outcome === "rollback" ? rollback : undefined,
      );
      await reading;
    }
    const settled = mode.outcome === "commit" ? "after" : "before";
    expect(await reading).toEqual({
      value: mode.journal === "wal" ? "before" : settled,
    });
    expect(
      await db.runInReadSnapshot(() => db.settings.get("snapshot.probe")),
    ).toBe(settled);
  },
);

it.each(modes.filter((mode) => mode.journal === "memory"))(
  "$name releases a canceled capture's place behind a held writer",
  async (mode) => {
    directory = mkdtempSync(join(tmpdir(), "marfa-snapshot-modes-"));
    const db = (storage = await createSqliteStorage(mode.path(directory)));
    const entered = gate(),
      release = gate(),
      canceled = new AbortController();
    const writer = db.runInTransaction(async () => {
      await db.settings.set("snapshot.cancel", "committed");
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let calls = 0;
    const read = () => {
      calls++;
      return db.settings.get("snapshot.cancel");
    };
    const reading = db.runInReadSnapshot(read, { signal: canceled.signal });
    const rejected = expect(reading).rejects.toThrow("unavailable");
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      canceled.abort();
      await rejected;
    } finally {
      release.resolve();
      await writer;
    }
    expect(calls).toBe(0);
    expect(await db.runInReadSnapshot(read)).toBe("committed");
    expect(calls).toBe(1);
    await db.runInTransaction(() =>
      db.settings.set("snapshot.cancel", "healthy"),
    );
    expect(await db.runInReadSnapshot(read)).toBe("healthy");
  },
);
