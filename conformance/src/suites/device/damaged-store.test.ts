import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  SCRIPTED_INSTANCE,
  answers,
  refusal,
  wireItem,
} from "../../device/marfa-answers.js";
import { CliDevice } from "../../device/cli-adapter.js";
import type { QueuedWrite } from "../../device/protocol.js";
import { BUILT_FOR } from "../../device/scripted-server.js";
import {
  KEY,
  damageTable,
  hydratedHarness,
  requireBinary,
  scriptHydration,
  scriptWrites,
  startHarness,
  type Harness,
} from "./harness.js";

/**
 * A store SQLite cannot read, damaged here by overwriting the page that
 * holds a table's rows, as a failing disk or a copy taken while it was
 * written leaves one. No door or fault damages a store.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/**
 * Runs `sql` on the store so that what it wrote is in the store's log alone,
 * as a process that ended without closing the store leaves it.
 */
function inLogOnly(store: string, sql: string): void {
  const db = new DatabaseSync(store);
  db.exec("PRAGMA wal_autocheckpoint = 0");
  db.exec(sql);
  copyFileSync(store, `${store}.kept`);
  copyFileSync(`${store}-wal`, `${store}.kept-wal`);
  db.close();
  renameSync(`${store}.kept`, store);
  renameSync(`${store}.kept-wal`, `${store}-wal`);
  rmSync(`${store}-shm`, { force: true });
}

function digest(name: string): string {
  return createHash("sha256").update(readFileSync(name)).digest("hex");
}

/** What carries a write to the server and what it says, from its row. */
function sent(write: QueuedWrite): unknown[] {
  return [
    write.id,
    write.idempotency_key,
    write.kind,
    write.base_version,
    write.item_id,
  ];
}

function bodies(store: string): unknown[] {
  const db = new DatabaseSync(store, { readOnly: true });
  try {
    return db.prepare("SELECT id, payload FROM queue ORDER BY id").all();
  } finally {
    db.close();
  }
}

/** A hydrated store holding `count` creates the server has not taken. */
async function storeWith(
  label: string,
  count: number,
): Promise<{ harness: Harness; queued: QueuedWrite[] }> {
  harness = await hydratedHarness(label);
  for (let n = 0; n < count; n += 1) {
    const created = await harness.device.create({
      type: "core.note",
      properties: { title: `typed ${String(n)}`, body: "offline" },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
  }
  const queued = await harness.device.queue();
  expect(queued.ok && queued.value.length).toBe(count);
  if (!queued.ok) throw new Error("unreachable");
  return { harness, queued: queued.value };
}

function writes(harness: Harness): Array<{ key: string | undefined }> {
  return harness.server.requests
    .filter(
      (request) =>
        request.method !== "GET" && request.pathname !== "/items/lookup",
    )
    .map((request) => ({ key: request.headers["idempotency-key"] }));
}

function verdicts(store: string, sql: string): void {
  const db = new DatabaseSync(store);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

/**
 * Puts back the page of `index` from `before`, as a copy taken while the
 * store was written leaves an index out of step with its rows.
 */
function indexFrom(store: string, before: Buffer, index: string): void {
  const db = new DatabaseSync(store, { readOnly: true });
  let size: number;
  let root: number;
  try {
    size = (db.prepare("PRAGMA page_size").get() as { page_size: number })
      .page_size;
    root = (
      db
        .prepare(
          "SELECT rootpage FROM sqlite_master WHERE type = 'index' AND name = ?",
        )
        .get(index) as { rootpage: number }
    ).rootpage;
  } finally {
    db.close();
  }
  const file = openSync(store, "r+");
  try {
    writeSync(file, before, (root - 1) * size, size, (root - 1) * size);
  } finally {
    closeSync(file);
  }
}

function cached(store: string): string[] {
  return readdirSync(`${store}.blobs`)
    .filter((name) => !name.startsWith("."))
    .sort();
}

describe("a store that cannot be read", () => {
  it("refuses a damaged store store_damaged, naming it and the writes its queue holds, and leaves it as it was", async () => {
    const { harness } = await storeWith("damaged-refused", 2);
    const { device } = harness;
    // The witness: the same store reads whole before it is damaged.
    const whole = await device.check();
    expect(whole.ok && whole.value.whole, JSON.stringify(whole)).toBe(true);

    damageTable(device.store, "items");
    inLogOnly(
      device.store,
      "INSERT INTO meta (key, value) VALUES ('logged', 'x')",
    );
    const before = digest(device.store);
    const log = digest(`${device.store}-wal`);
    for (const [named, refused] of [
      ["status", await device.status()],
      ["check", await device.check()],
    ] as const) {
      expect(refused.ok, `${named} read a damaged store`).toBe(false);
      if (refused.ok) continue;
      expect(refused.refusal.code, refused.refusal.raw).toBe("store_damaged");
      expect(refused.refusal.raw).toContain(device.store);
      expect(refused.refusal.raw).toContain(
        "holds 2 writes the server has not taken",
      );
      expect(refused.refusal.raw).not.toMatch(/delete/i);
    }
    expect(digest(device.store), "refusing the store changed it").toBe(before);
    expect(
      digest(`${device.store}-wal`),
      "refusing the store changed its log",
    ).toBe(log);
    expect(existsSync(`${device.store}.damaged-1`)).toBe(false);
  });

  it("refuses a store whose index is out of step with its rows store_damaged, naming it, and sets it aside", async () => {
    const { harness, queued } = await storeWith("damaged-index", 2);
    const { device } = harness;
    const before = readFileSync(device.store);
    verdicts(
      device.store,
      `UPDATE queue SET verdict = 'dead', answered_at = '2026-01-01T00:00:00Z' WHERE id = '${queued[1]?.id ?? ""}'`,
    );
    // The witness: the same store reads whole before its index goes back.
    const whole = await device.check();
    expect(whole.ok && whole.value.whole, JSON.stringify(whole)).toBe(true);

    indexFrom(device.store, before, "queue_verdict_seq");
    const refused = await device.check();
    expect(refused.ok, "a check read the store as whole").toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code, refused.refusal.raw).toBe("store_damaged");
    expect(refused.refusal.raw).toContain(device.store);
    expect(refused.refusal.raw).toContain("queue_verdict_seq");
    expect(refused.refusal.raw).toContain(
      "holds 2 writes the server has not taken",
    );

    const done = await device.setAside();
    expect(done.ok, JSON.stringify(done)).toBe(true);
    if (!done.ok) return;
    expect([done.value.carried, done.value.unread, done.value.whole]).toEqual([
      2,
      0,
      true,
    ]);
    const carried = await device.queue();
    expect(carried.ok && carried.value.map(sent)).toEqual(queued.map(sent));
    const now = await device.check();
    expect(now.ok, JSON.stringify(now)).toBe(true);
  });

  it("says a damaged store's queue cannot be read whole where its rows do not read", async () => {
    const { harness } = await storeWith("damaged-queue", 1);
    damageTable(harness.device.store, "queue");
    const refused = await harness.device.check();
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code).toBe("store_damaged");
    expect(refused.refusal.raw).toContain("cannot be read whole");
  });
});

describe("setting a damaged store aside", () => {
  it("sets a damaged store aside under the next free name, keeping its bytes, and carries each write under its id and key", async () => {
    const { harness, queued } = await storeWith("set-aside", 2);
    const { device } = harness;
    const before = bodies(device.store);
    writeFileSync(`${device.store}.damaged-1`, "taken");
    damageTable(device.store, "items");
    const damaged = digest(device.store);

    const done = await device.setAside();
    expect(done.ok, JSON.stringify(done)).toBe(true);
    if (!done.ok) return;
    const aside = `${device.store}.damaged-2`;
    expect(done.value).toEqual({
      set_aside: aside,
      carried: 2,
      unread: 0,
      unread_ids: [],
      whole: true,
      held: 0,
      record_unread: 0,
    });
    expect(digest(aside), "the store set aside is not the damaged one").toBe(
      damaged,
    );
    expect(
      readFileSync(`${device.store}.damaged-1`, "utf8"),
      "a file at a name already taken was overwritten",
    ).toBe("taken");

    const carried = await device.queue();
    expect(carried.ok, JSON.stringify(carried)).toBe(true);
    if (!carried.ok) return;
    expect(carried.value.map(sent)).toEqual(queued.map(sent));
    expect(bodies(device.store)).toEqual(before);
  });

  it("carries a write only the log a crash left holds, and moves the log with the store", async () => {
    const { harness } = await storeWith("set-aside-log", 1);
    const { store } = harness.device;
    damageTable(store, "items");
    inLogOnly(
      store,
      `INSERT INTO queue (id, kind, item_id, idempotency_key, payload, queued_at)
       VALUES ('logged', 'add_tag', 'n1', 'key-logged', '{"tag":"a"}', '2026-01-01T00:00:00Z')`,
    );
    const log = digest(`${store}-wal`);

    const done = await harness.device.setAside();
    expect(done.ok, JSON.stringify(done)).toBe(true);
    if (!done.ok) return;
    expect(done.value.carried).toBe(2);
    expect(digest(`${done.value.set_aside}-wal`)).toBe(log);
    const carried = await harness.device.queue();
    expect(
      carried.ok &&
        carried.value.find((write) => write.id === "logged")?.idempotency_key,
    ).toBe("key-logged");
  });

  it("counts the writes whose rows do not read, naming each by id", async () => {
    const { harness, queued } = await storeWith("set-aside-unread", 2);
    damageTable(harness.device.store, "queue");
    const done = await harness.device.setAside();
    expect(done.ok, JSON.stringify(done)).toBe(true);
    if (!done.ok) return;
    expect([done.value.carried, done.value.unread, done.value.whole]).toEqual([
      0,
      2,
      true,
    ]);
    expect([...done.value.unread_ids].sort()).toEqual(
      queued.map((write) => write.id).sort(),
    );
  });

  it("sends nothing from the new store until it is hydrated, then sends each carried write under its key", async () => {
    const { harness, queued } = await storeWith("set-aside-sends", 1);
    const { device, server } = harness;
    damageTable(device.store, "items");
    const done = await device.setAside();
    expect(done.ok && done.value.held, JSON.stringify(done)).toBe(0);

    const early = await device.drain();
    expect(early.ok, "a drain sent from a store never hydrated").toBe(false);
    if (!early.ok) expect(early.refusal.code).toBe("no_cursor");
    expect(writes(harness)).toEqual([]);

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const id = queued[0]?.item_id ?? "a";
    scriptWrites(server, {
      read: [answers.updated(wireItem({ id }))],
      create: [answers.created(wireItem({ id }))],
    });
    const drained = await device.drain();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    expect(writes(harness)).toEqual([{ key: queued[0]?.idempotency_key }]);
  });

  it("holds the carried writes when the new store is hydrated from another instance", async () => {
    harness = await startHarness("set-aside-instance");
    const { server, device } = harness;
    let instance = SCRIPTED_INSTANCE;
    server.copyAnswer("GET", "/", () =>
      answers.root(Number(BUILT_FOR), instance),
    );
    scriptHydration(server, { head: "1", instance: () => instance });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const created = await device.create({
      type: "core.note",
      properties: { title: "typed", body: "offline" },
    });
    expect(created.ok).toBe(true);
    damageTable(device.store, "items");
    expect((await device.setAside()).ok).toBe(true);
    // The witness: carried, the write waits.
    const waiting = await device.queue();
    expect(waiting.ok && waiting.value[0]?.verdict).toBe(null);

    instance = "00000000-0000-7000-8000-0000000000ff";
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const held = await device.queue();
    expect(held.ok, JSON.stringify(held)).toBe(true);
    if (!held.ok) return;
    expect([held.value[0]?.verdict, held.value[0]?.reason]).toEqual([
      "blocked",
      "instance_changed",
    ]);
  });

  it("holds the carried writes when the damaged store does not say which instance it was built from", async () => {
    const { harness, queued } = await storeWith("set-aside-meta", 1);
    damageTable(harness.device.store, "meta");
    const done = await harness.device.setAside();
    expect(done.ok, JSON.stringify(done)).toBe(true);
    if (!done.ok) return;
    expect([done.value.carried, done.value.held]).toEqual([1, 1]);
    const held = await harness.device.queue();
    expect(held.ok, JSON.stringify(held)).toBe(true);
    if (!held.ok) return;
    expect(held.value.map(sent)).toEqual(queued.map(sent));
    expect([held.value[0]?.verdict, held.value[0]?.reason]).toEqual([
      "blocked",
      "instance_changed",
    ]);
  });

  it("holds a carried write whose record of how it is sent does not read, until a person releases or withdraws it", async () => {
    const { harness, queued } = await storeWith("set-aside-record", 1);
    const { device } = harness;
    // The record an edit's body is read against once it is answered.
    damageTable(device.store, "body_checks");
    const done = await device.setAside();
    expect(done.ok, JSON.stringify(done)).toBe(true);
    if (!done.ok) return;
    expect([
      done.value.carried,
      done.value.record_unread,
      done.value.held,
      done.value.whole,
    ]).toEqual([1, 1, 0, false]);
    const id = queued[0]?.id ?? "a";
    const held = await device.queue();
    expect(held.ok && held.value.map(sent)).toEqual(queued.map(sent));
    expect(held.ok && [held.value[0]?.verdict, held.value[0]?.reason]).toEqual([
      "blocked",
      "record_unread",
    ]);

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const drained = await device.drain();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    expect(writes(harness), "a drain sent a write held record_unread").toEqual(
      [],
    );
    scriptWrites(harness.server, { read: [answers.itemNotFound()] });
    const withdrawn = await device.withdraw(id);
    expect(withdrawn.ok && withdrawn.value, JSON.stringify(withdrawn)).toBe(
      true,
    );
    const left = await device.queue();
    expect(left.ok && left.value).toEqual([]);
  });

  it("refuses to set aside a store beside a file no set-aside made, leaving both as they were", async () => {
    const { harness } = await storeWith("set-aside-not-made", 1);
    const { store } = harness.device;
    damageTable(store, "items");
    const before = digest(store);
    // Where the new store is made and marked, where it carries the writes,
    // and the log SQLite would read into a store made at either name.
    for (const name of [
      `${store}.carrying`,
      `${store}.carrying-wal`,
      `${store}.making`,
      `${store}.making-wal`,
    ]) {
      writeFileSync(name, "a person's file");
      const refused = await harness.device.setAside();
      expect(refused.ok, name).toBe(false);
      if (!refused.ok) {
        expect(refused.refusal.code).toBe("store");
        expect(refused.refusal.raw).toContain(name);
      }
      expect(readFileSync(name, "utf8")).toBe("a person's file");
      expect(digest(store)).toBe(before);
      expect(existsSync(`${store}.damaged-1`)).toBe(false);
      rmSync(name);
    }
    // The witness: with nothing standing there, the store is set aside.
    const done = await harness.device.setAside();
    expect(done.ok && done.value.carried, JSON.stringify(done)).toBe(1);
  });

  it("refuses to set aside a store that opens, leaving it as it was", async () => {
    const { harness } = await storeWith("set-aside-usable", 1);
    const before = digest(harness.device.store);
    const refused = await harness.device.setAside();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("invalid");
    expect(digest(harness.device.store)).toBe(before);
    expect(existsSync(`${harness.device.store}.damaged-1`)).toBe(false);
  });

  it("refuses to set aside a folder's store", async () => {
    const { harness } = await storeWith("set-aside-folder", 1);
    const db = new DatabaseSync(harness.device.store);
    try {
      db.exec("INSERT INTO meta (key, value) VALUES ('folder_id', 'f1')");
    } finally {
      db.close();
    }
    damageTable(harness.device.store, "items");
    const refused = await harness.device.setAside();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("invalid");
    expect(existsSync(`${harness.device.store}.damaged-1`)).toBe(false);
  });

  it("sets aside a device's own store kept in a folder named like a folder's state", async () => {
    const { harness } = await storeWith("set-aside-in-state", 1);
    damageTable(harness.device.store, "items");
    const state = join(
      mkdtempSync(join(realpathSync(tmpdir()), "marfa-device-state-")),
      ".marfa",
    );
    mkdirSync(state);
    const at = (name: string) => {
      const store = join(state, name);
      copyFileSync(harness.device.store, store);
      return new CliDevice({
        binary: requireBinary(),
        store,
        url: harness.server.url,
        key: KEY,
      });
    };
    // The witness: under a folder's store's name, it is refused as one.
    const folders = await at("core.sqlite").setAside();
    expect(folders.ok).toBe(false);
    if (!folders.ok) expect(folders.refusal.code).toBe("invalid");

    const own = at("device.sqlite");
    const done = await own.setAside();
    expect(done.ok, JSON.stringify(done)).toBe(true);
    if (!done.ok) return;
    expect([done.value.set_aside, done.value.carried]).toEqual([
      `${own.store}.damaged-1`,
      1,
    ]);
  });

  it("refuses a store whose set-aside stopped part way, and finishes it when asked again", async () => {
    const { harness, queued } = await storeWith("set-aside-stopped", 1);
    const { device } = harness;
    damageTable(device.store, "items");
    const crashed = device.hold(["set-aside"], "device", {
      MARFA_TEST_FAULT: "set-aside-crash=store",
    });
    await crashed.exited();
    expect(crashed.exitCode(), "the set-aside did not stop").not.toBe(0);
    expect(existsSync(device.store), "the store was not moved").toBe(false);

    const refused = await device.status();
    expect(refused.ok, "a writer opened a store whose set-aside stopped").toBe(
      false,
    );
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("store_damaged");
      expect(refused.refusal.raw).toContain("stopped part way");
    }

    const done = await device.setAside();
    expect(done.ok, JSON.stringify(done)).toBe(true);
    if (!done.ok) return;
    expect([done.value.set_aside, done.value.carried]).toEqual([
      `${device.store}.damaged-1`,
      1,
    ]);
    const carried = await device.queue();
    expect(carried.ok && carried.value.map(sent)).toEqual(queued.map(sent));
  });

  it("finishes a set-aside that ended while it made the new store, leaving nothing at the name it carries the writes in", async () => {
    for (const point of ["made", "making"]) {
      const { harness: made, queued } = await storeWith(
        `set-aside-making-${point}`,
        1,
      );
      const { device } = made;
      damageTable(device.store, "items");
      const damaged = digest(device.store);
      const crashed = device.hold(["set-aside"], "device", {
        MARFA_TEST_FAULT: `set-aside-crash=${point}`,
      });
      await crashed.exited();
      expect(
        crashed.exitCode(),
        `the set-aside did not stop at ${point}`,
      ).not.toBe(0);
      expect(
        existsSync(`${device.store}.carrying`),
        `a file stands where the writes are carried that no mark shows a set-aside made (${point})`,
      ).toBe(false);
      expect(digest(device.store)).toBe(damaged);

      const done = await device.setAside();
      expect(done.ok, JSON.stringify(done)).toBe(true);
      if (!done.ok) return;
      expect([done.value.set_aside, done.value.carried]).toEqual([
        `${device.store}.damaged-1`,
        1,
      ]);
      expect(existsSync(`${device.store}.making`)).toBe(false);
      const carried = await device.queue();
      expect(carried.ok && carried.value.map(sent)).toEqual(queued.map(sent));
      await made.stop();
      harness = undefined;
    }
  });

  it("answers a set-aside that ended after its new store took the path, when asked again", async () => {
    const { harness, queued } = await storeWith("set-aside-taken", 1);
    const { device } = harness;
    damageTable(device.store, "items");
    const crashed = device.hold(["set-aside"], "device", {
      MARFA_TEST_FAULT: "set-aside-crash=taken",
    });
    await crashed.exited();
    expect(crashed.exitCode(), "the set-aside did not stop").not.toBe(0);
    expect(existsSync(`${device.store}.carrying`)).toBe(false);
    expect(existsSync(`${device.store}.damaged-1`)).toBe(true);

    const done = await device.setAside();
    expect(done.ok, JSON.stringify(done)).toBe(true);
    if (!done.ok) return;
    expect(done.value).toEqual({
      set_aside: `${device.store}.damaged-1`,
      carried: 1,
      unread: 0,
      unread_ids: [],
      whole: true,
      held: 0,
      record_unread: 0,
    });
    const carried = await device.queue();
    expect(carried.ok && carried.value.map(sent)).toEqual(queued.map(sent));
    const again = await device.setAside();
    expect(again.ok, "a set-aside answered twice").toBe(false);
    if (!again.ok) expect(again.refusal.code).toBe("invalid");
  });

  it("keeps every byte the cache held when a set-aside could not read every write, until the store set aside is removed", async () => {
    for (const damaged of ["items", "queue"]) {
      const { harness: made } = await storeWith(
        `set-aside-bytes-${damaged}`,
        0,
      );
      const { device } = made;
      const file = join(realpathSync(tmpdir()), `marfa-offline-${damaged}.txt`);
      writeFileSync(file, `offline bytes ${damaged}`);
      expect((await device.addFile(file)).ok).toBe(true);
      expect((await device.fileBudget("0")).ok).toBe(true);
      const fetched = "0f".repeat(32);
      writeFileSync(join(`${device.store}.blobs`, fetched), "fetched bytes");
      const held = cached(device.store);
      expect(held.length).toBe(2);
      damageTable(device.store, damaged);

      const done = await device.setAside();
      expect(done.ok, JSON.stringify(done)).toBe(true);
      if (!done.ok) return;
      expect(await device.fileBudget("0", { trim: true })).toMatchObject({
        ok: true,
      });
      if (damaged === "items") {
        // The witness: a set-aside that read every write keeps only what
        // its writes name.
        expect(done.value.whole).toBe(true);
        expect(cached(device.store)).not.toContain(fetched);
      } else {
        expect(done.value.unread > 0 || !done.value.whole).toBe(true);
        expect(cached(device.store)).toEqual(held);
        rmSync(done.value.set_aside);
        expect((await device.fileBudget("0", { trim: true })).ok).toBe(true);
        expect(cached(device.store)).toEqual([]);
      }
      rmSync(file);
      await made.stop();
      harness = undefined;
    }
  });

  it("holds a carried write refused unsent whose record does not read, so releasing the write it waits for leaves it held", async () => {
    for (const damaged of ["items", "body_edges"]) {
      const { harness: made, queued } = await storeWith(
        `set-aside-refused-${damaged}`,
        2,
      );
      const { device } = made;
      const [source, target] = queued.map((write) => write.item_id ?? "");
      const edge = await device.createEdge({
        source: source ?? "",
        target: target ?? "",
        type: "about",
      });
      expect(edge.ok, JSON.stringify(edge)).toBe(true);
      if (!edge.ok) return;
      expect(edge.value.depends_on).toContain(queued[0]?.id);
      verdicts(
        device.store,
        `UPDATE queue SET verdict = 'dead', answered_at = '2026-01-01T00:00:00Z' WHERE id = '${queued[0]?.id ?? ""}';
         UPDATE queue SET verdict = 'refused', reason = 'the write it depends on died', sent = 0,
                answered_at = '2026-01-01T00:00:00Z' WHERE id = '${edge.value.id}';`,
      );
      damageTable(device.store, damaged);
      const done = await device.setAside();
      expect(done.ok, JSON.stringify(done)).toBe(true);
      if (!done.ok) return;

      const released = await device.release({ id: queued[0]?.id ?? "" });
      expect(released.ok, JSON.stringify(released)).toBe(true);
      const after = await device.queue();
      expect(after.ok, JSON.stringify(after)).toBe(true);
      if (!after.ok) return;
      const left = after.value.find((write) => write.id === edge.value.id);
      if (damaged === "items") {
        // The witness: with its record read, the edge goes with the write
        // it waits for.
        expect(done.value.record_unread).toBe(0);
        expect([left?.verdict, left?.reason]).toEqual([null, null]);
      } else {
        expect(done.value.record_unread).toBe(1);
        expect([left?.verdict, left?.reason]).toEqual([
          "blocked",
          "record_unread",
        ]);
      }
      await made.stop();
      harness = undefined;
    }
  });

  it("holds a carried write whose record does not read whatever its verdict, and a released one goes under its key and is judged again", async () => {
    const { harness, queued } = await storeWith("set-aside-record-spent", 1);
    const { device, server } = harness;
    const spentKey = () =>
      scriptWrites(server, {
        create: [
          refusal(422, "idempotency_key_reused", "answered for another body"),
        ],
      });
    spentKey();
    expect((await device.drain()).ok).toBe(true);
    const spent = await device.queue();
    // The witness: the write was blocked for another reason before.
    expect(
      spent.ok && [spent.value[0]?.verdict, spent.value[0]?.reason],
    ).toEqual(["blocked", "key_spent"]);

    damageTable(device.store, "body_checks");
    const done = await device.setAside();
    expect(done.ok, JSON.stringify(done)).toBe(true);
    if (!done.ok) return;
    expect([done.value.carried, done.value.record_unread]).toEqual([1, 1]);
    const held = await device.queue();
    expect(held.ok && [held.value[0]?.verdict, held.value[0]?.reason]).toEqual([
      "blocked",
      "record_unread",
    ]);

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const released = await device.release({ reason: "record_unread" });
    expect(released.ok && released.value, JSON.stringify(released)).toBe(1);
    const before = writes(harness).length;
    spentKey();
    expect((await device.drain()).ok).toBe(true);
    expect(writes(harness).slice(before)).toEqual([
      { key: queued[0]?.idempotency_key },
    ]);
    const again = await device.queue();
    expect(
      again.ok && [again.value[0]?.verdict, again.value[0]?.reason],
    ).toEqual(["blocked", "key_spent"]);
  });

  it("keeps a carried write held record_unread when the new store is hydrated from another instance", async () => {
    harness = await startHarness("set-aside-record-instance");
    const { server, device } = harness;
    let instance = SCRIPTED_INSTANCE;
    server.copyAnswer("GET", "/", () =>
      answers.root(Number(BUILT_FOR), instance),
    );
    scriptHydration(server, { head: "1", instance: () => instance });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const created = await device.create({
      type: "core.note",
      properties: { title: "typed", body: "offline" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const tagged = await device.addTag(created.value.item_id ?? "", "carried");
    expect(tagged.ok, JSON.stringify(tagged)).toBe(true);
    if (!tagged.ok) return;
    damageTable(device.store, "body_checks");
    const done = await device.setAside();
    expect(done.ok && done.value.record_unread, JSON.stringify(done)).toBe(1);

    instance = "00000000-0000-7000-8000-0000000000ff";
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const held = await device.queue();
    expect(held.ok, JSON.stringify(held)).toBe(true);
    if (!held.ok) return;
    const reason = (id: string) =>
      held.value.find((write) => write.id === id)?.reason;
    // The witness: the write that was waiting is held for the instance.
    expect(reason(tagged.value.id)).toBe("instance_changed");
    expect(reason(created.value.id)).toBe("record_unread");
  });

  it("holds a write released from record_unread for the instance when the new store was hydrated from another instance, and sends it on a second release", async () => {
    harness = await startHarness("set-aside-record-instance-release");
    const { server, device } = harness;
    let instance = SCRIPTED_INSTANCE;
    server.copyAnswer("GET", "/", () =>
      answers.root(Number(BUILT_FOR), instance),
    );
    scriptHydration(server, { head: "1", instance: () => instance });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const created = await device.create({
      type: "core.note",
      properties: { title: "typed", body: "offline" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    damageTable(device.store, "body_checks");
    const done = await device.setAside();
    expect(done.ok && done.value.record_unread, JSON.stringify(done)).toBe(1);

    instance = "00000000-0000-7000-8000-0000000000ff";
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const held = async () => {
      const queued = await device.queue();
      return queued.ok
        ? [queued.value[0]?.verdict, queued.value[0]?.reason]
        : queued;
    };
    expect(await held()).toEqual(["blocked", "record_unread"]);
    const first = await device.release({ id: created.value.id });
    expect(first.ok && first.value, JSON.stringify(first)).toBe(0);
    expect(await held()).toEqual(["blocked", "instance_changed"]);
    expect((await device.drain()).ok).toBe(true);
    expect(
      writes(harness),
      "a drain sent a write made against another instance",
    ).toEqual([]);

    // The witness: released again, the write is sent.
    const id = created.value.item_id ?? "a";
    scriptWrites(server, {
      read: [answers.updated(wireItem({ id }))],
      create: [answers.created(wireItem({ id }))],
    });
    const second = await device.release({ id: created.value.id });
    expect(second.ok && second.value, JSON.stringify(second)).toBe(1);
    expect((await device.drain()).ok).toBe(true);
    expect(writes(harness)).toEqual([{ key: created.value.idempotency_key }]);
  });

  it("holds a write released from record_unread for the instance after a later set-aside of a store hydrated from another instance", async () => {
    harness = await startHarness("set-aside-record-instance-later");
    const { server, device } = harness;
    let instance = SCRIPTED_INSTANCE;
    server.copyAnswer("GET", "/", () =>
      answers.root(Number(BUILT_FOR), instance),
    );
    scriptHydration(server, { head: "1", instance: () => instance });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const created = await device.create({
      type: "core.note",
      properties: { title: "typed", body: "offline" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    damageTable(device.store, "body_checks");
    const first = await device.setAside();
    expect(first.ok && first.value.record_unread, JSON.stringify(first)).toBe(
      1,
    );
    instance = "00000000-0000-7000-8000-0000000000ff";
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    damageTable(device.store, "items");
    const later = await device.setAside();
    expect(later.ok && later.value.carried, JSON.stringify(later)).toBe(1);
    const held = async () => {
      const queued = await device.queue();
      return queued.ok
        ? [queued.value[0]?.verdict, queued.value[0]?.reason]
        : queued;
    };
    expect(await held()).toEqual(["blocked", "record_unread"]);
    const released = await device.release({ id: created.value.id });
    expect(released.ok && released.value, JSON.stringify(released)).toBe(0);
    expect(await held()).toEqual(["blocked", "instance_changed"]);
    // The witness: released again, the write waits to be sent.
    const again = await device.release({ id: created.value.id });
    expect(again.ok && again.value, JSON.stringify(again)).toBe(1);
    expect(await held()).toEqual([null, null]);
  });

  it("refuses every open of a store whose file is empty while its log holds committed writes, keeping the log, and a set-aside carries them", async () => {
    const { harness, queued } = await storeWith("emptied-log", 2);
    const { device } = harness;
    inLogOnly(device.store, "VACUUM");
    writeFileSync(device.store, "");
    const log = digest(`${device.store}-wal`);
    for (const [named, refused] of [
      ["status", await device.status()],
      ["reader", await device.reopen({ reader: true }).queue()],
      ["check", await device.check()],
    ] as const) {
      expect(refused.ok, `${named} opened an emptied store`).toBe(false);
      if (refused.ok) continue;
      expect(refused.refusal.code, refused.refusal.raw).toBe("store_damaged");
      expect(refused.refusal.raw).toContain(device.store);
      expect(refused.refusal.raw).toContain("log holds committed writes");
      expect(
        digest(`${device.store}-wal`),
        `${named} changed the store's log`,
      ).toBe(log);
    }
    expect(readFileSync(device.store).length).toBe(0);

    const done = await device.setAside();
    expect(done.ok, JSON.stringify(done)).toBe(true);
    if (!done.ok) return;
    expect([done.value.carried, done.value.unread]).toEqual([2, 0]);
    expect(digest(`${done.value.set_aside}-wal`)).toBe(log);
    const carried = await device.queue();
    expect(carried.ok, JSON.stringify(carried)).toBe(true);
    if (!carried.ok) return;
    expect(carried.value.map(sent)).toEqual(queued.map(sent));
  });
});
