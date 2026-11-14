import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  SCRIPTED_INSTANCE,
  answers,
  refusal,
  wireItem,
} from "../../device/marfa-answers.js";
import type { QueuedWrite } from "../../device/protocol.js";
import { BUILT_FOR } from "../../device/scripted-server.js";
import {
  damageTable,
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
});
