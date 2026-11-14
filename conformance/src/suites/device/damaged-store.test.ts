import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  SCRIPTED_INSTANCE,
  answers,
  wireItem,
} from "../../device/marfa-answers.js";
import type { QueuedWrite } from "../../device/protocol.js";
import { BUILT_FOR } from "../../device/scripted-server.js";
import {
  hydratedHarness,
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

/** Overwrites the page that holds `table`'s rows. */
function damage(store: string, table: string): void {
  const db = new DatabaseSync(store, { readOnly: true });
  let size: number;
  let root: number;
  try {
    size = (db.prepare("PRAGMA page_size").get() as { page_size: number })
      .page_size;
    root = (
      db
        .prepare(
          "SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(table) as { rootpage: number }
    ).rootpage;
  } finally {
    db.close();
  }
  const file = openSync(store, "r+");
  try {
    writeSync(file, Buffer.alloc(size, 0xa5), 0, size, (root - 1) * size);
  } finally {
    closeSync(file);
  }
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

describe("a store that cannot be read", () => {
  it("refuses a damaged store store_damaged, naming it and the writes its queue holds, and leaves it as it was", async () => {
    const { harness } = await storeWith("damaged-refused", 2);
    const { device } = harness;
    // The witness: the same store reads whole before it is damaged.
    const whole = await device.check();
    expect(whole.ok && whole.value.whole, JSON.stringify(whole)).toBe(true);

    damage(device.store, "items");
    const before = digest(device.store);
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
    expect(existsSync(`${device.store}.damaged-1`)).toBe(false);
  });

  it("says a damaged store's queue cannot be read whole where its rows do not read", async () => {
    const { harness } = await storeWith("damaged-queue", 1);
    damage(harness.device.store, "queue");
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
    damage(device.store, "items");
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
    damage(store, "items");
    // What a process that ended without closing the store leaves: the last
    // write in the log alone.
    const db = new DatabaseSync(store);
    db.exec("PRAGMA wal_autocheckpoint = 0");
    db.exec(
      `INSERT INTO queue (id, kind, item_id, idempotency_key, payload, queued_at)
       VALUES ('logged', 'add_tag', 'n1', 'key-logged', '{"tag":"a"}', '2026-01-01T00:00:00Z')`,
    );
    copyFileSync(store, `${store}.kept`);
    copyFileSync(`${store}-wal`, `${store}.kept-wal`);
    db.close();
    renameSync(`${store}.kept`, store);
    renameSync(`${store}.kept-wal`, `${store}-wal`);
    rmSync(`${store}-shm`, { force: true });
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
    damage(harness.device.store, "queue");
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
    damage(device.store, "items");
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
    damage(device.store, "items");
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
    damage(harness.device.store, "meta");
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
    damage(harness.device.store, "items");
    const refused = await harness.device.setAside();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("invalid");
    expect(existsSync(`${harness.device.store}.damaged-1`)).toBe(false);
  });

  it("refuses a store whose set-aside stopped part way, and finishes it when asked again", async () => {
    const { harness, queued } = await storeWith("set-aside-stopped", 1);
    const { device } = harness;
    damage(device.store, "items");
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
});
