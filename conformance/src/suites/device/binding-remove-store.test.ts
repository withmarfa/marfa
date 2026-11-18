import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BindingDevice } from "../../device/binding-adapter.js";
import { CliDevice } from "../../device/cli-adapter.js";
import {
  damageTable,
  requireBinary,
  requireModule,
  startBindingHarness,
  type BindingHarness,
} from "./harness.js";
import { tempFolder } from "../../utils/temp-folder.js";

/**
 * Removing a store with the confirmation of the writes the person was shown
 * and agreed to lose, through the binding, the only device that offers it.
 * The fixture's process plays another app on the same store where one holds
 * the writer role.
 */

let harness: BindingHarness | undefined;
let other: BindingDevice | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  await other?.close();
  other = undefined;
});

/** The names a store is made of, beside the store file itself. */
const SUFFIXES = ["", "-wal", "-shm", "-journal", ".blobs", ".writer-lock"];

/** Each name of the store that is there, with its bytes as a digest. */
function held(store: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const suffix of SUFFIXES) {
    const name = store + suffix;
    if (!existsSync(name) && !isLink(name)) continue;
    if (lstatSync(name).isDirectory()) {
      for (const entry of readdirSync(name).sort()) {
        const inside = join(name, entry);
        found[`${suffix}/${entry}`] = isLink(inside)
          ? `link to ${readlinkSync(inside)}`
          : digest(inside);
      }
      found[suffix] = "folder";
    } else if (suffix === "-shm" || suffix === ".writer-lock") {
      found[suffix] = "there";
    } else {
      found[suffix] = digest(name);
    }
  }
  return found;
}

/**
 * What `held` finds but the shared-memory index, which SQLite may make to
 * read a write-ahead log (`device/remove-store-kept`).
 */
function kept(store: string): Record<string, string> {
  const { "-shm": _index, ...rest } = held(store);
  return rest;
}

function isLink(name: string): boolean {
  try {
    return lstatSync(name).isSymbolicLink();
  } catch {
    return false;
  }
}

function digest(name: string): string {
  return createHash("sha256").update(readFileSync(name)).digest("hex");
}

function edit(store: string, sql: string): void {
  const db = new DatabaseSync(store);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

/**
 * A store holding one note, its create not taken by the server, and one
 * file of fetched bytes. The binding has let go of it. `written` is the id
 * of the create, and `shown` the confirmation `readUnsent` gave with it.
 */
async function storeWithOneUnsent(
  label: string,
): Promise<BindingHarness & { written: string[]; shown: string }> {
  const started = await startBindingHarness(label, { server: false });
  harness = started;
  const created = await started.device.createItem({
    type: "core.note",
    properties: { title: "shown", body: "shown" },
  });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  // The witness: the store holds the write unsent.
  const queue = await started.device.queue();
  expect(queue.ok && queue.value.length).toBe(1);
  const written = queue.ok ? queue.value.map((write) => write.id) : [];
  await started.device.forget();
  const blobs = `${started.device.store}.blobs`;
  mkdirSync(blobs, { recursive: true });
  writeFileSync(join(blobs, "fetched"), "bytes");
  const listed = await unsent(started.device);
  expect(listed.writes.map((write) => write.id)).toEqual(written);
  return { ...started, written, shown: listed.confirmation };
}

/** What `readUnsent` shows for the device's store, or at `path`. */
async function unsent(device: BindingDevice, path?: string) {
  const read = await device.readUnsent(path);
  expect(read.ok, JSON.stringify(read)).toBe(true);
  if (!read.ok) throw new Error("unreachable");
  return read.value;
}

/** The confirmation of no writes, as a path with no store gives it. */
async function nothing(device: BindingDevice): Promise<string> {
  const empty = await unsent(
    device,
    join(dirname(device.store), "no-store.sqlite"),
  );
  expect(empty.writes).toEqual([]);
  return empty.confirmation;
}

function refusalOf(
  outcome: Awaited<ReturnType<BindingHarness["device"]["removeStore"]>>,
): { code: string; unsent?: number | null; setAsideStopped?: boolean } {
  expect(outcome.ok, "the removal was not refused").toBe(false);
  if (outcome.ok) throw new Error("unreachable");
  return {
    code: outcome.refusal.code,
    ...(JSON.parse(outcome.refusal.raw) as {
      unsent?: number | null;
      setAsideStopped?: boolean;
    }),
  };
}

describe("removing a store", () => {
  it("removes a store holding exactly the unsent writes it showed, with its log, fetched bytes and lock", async () => {
    const { device, shown } = await storeWithOneUnsent("remove-store");
    const dir = dirname(device.store);
    // Not the store's own names, so they stay.
    const neighbors = [
      "core.db",
      `${basename(device.store)}.refused-1`,
      "notes.txt",
    ];
    for (const neighbor of neighbors)
      writeFileSync(join(dir, neighbor), "kept");
    expect(Object.keys(held(device.store))).toContain(".blobs");

    const removed = await device.removeStore(shown);
    expect(removed.ok, JSON.stringify(removed)).toBe(true);

    expect(held(device.store)).toEqual({});
    expect(readdirSync(dir).sort()).toEqual([...neighbors].sort());
    for (const neighbor of neighbors) {
      expect(readFileSync(join(dir, neighbor), "utf8")).toBe("kept");
    }
    // The path is free for a new store, which holds nothing.
    const opened = await device.tryOpen();
    expect(opened.handle).toBe("writer");
  });

  it("refuses to remove a store while another process holds its writer role", async () => {
    const { device, shown } = await storeWithOneUnsent("remove-held");
    const before = kept(device.store);

    // Another app's writer, as the core takes the role.
    const holder = new DatabaseSync(`${device.store}.writer-lock`);
    try {
      holder.exec("BEGIN EXCLUSIVE");
      expect(refusalOf(await device.removeStore(shown)).code).toBe(
        "reading_handle",
      );
      expect(kept(device.store)).toEqual(before);
    } finally {
      holder.close();
    }

    // The witness: once the other writer lets go, the same call removes it.
    const removed = await device.removeStore(shown);
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(held(device.store)).toEqual({});
  });

  it("refuses to remove a store with a confirmation it did not give, saying how many unsent writes it holds", async () => {
    const { device } = await storeWithOneUnsent("remove-unsent");
    const before = kept(device.store);

    for (const agreed of ["", "not-a-confirmation", await nothing(device)]) {
      const refused = refusalOf(await device.removeStore(agreed));
      expect(refused.code).toBe("unsent_differs");
      expect(
        refused.unsent,
        "the refusal did not say how many writes the store holds",
      ).toBe(1);
      expect(
        kept(device.store),
        "the refused removal changed the store",
      ).toEqual(before);
    }
  });

  it("refuses to remove a store whose unsent write's body changed under the same id after it was shown", async () => {
    const { device, written, shown } =
      await storeWithOneUnsent("remove-changed");
    edit(
      device.store,
      `UPDATE queue SET payload = replace(payload, '"shown"', '"changed"')`,
    );
    // The witness: the store holds the same write by id, with another body.
    const now = await unsent(device);
    expect(now.writes.map((write) => write.id)).toEqual(written);
    expect(now.writes[0]?.body).toContain('"changed"');
    expect(now.writes[0]?.body).not.toContain('"shown"');
    const before = kept(device.store);

    const refused = refusalOf(await device.removeStore(shown));
    expect(refused.code).toBe("unsent_differs");
    expect(refused.unsent).toBe(1);
    expect(kept(device.store), "the refused removal changed the store").toEqual(
      before,
    );

    const removed = await device.removeStore(now.confirmation);
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(held(device.store)).toEqual({});
  });

  it("refuses to remove a store whose unsent write's verdict changed after it was shown", async () => {
    const { device, written, shown } =
      await storeWithOneUnsent("remove-verdict");
    edit(device.store, "UPDATE queue SET verdict = 'dead', sent = 1");
    const now = await unsent(device);
    expect(now.writes.map((write) => [write.id, write.verdict])).toEqual([
      [written[0], "dead"],
    ]);
    const before = kept(device.store);

    const refused = refusalOf(await device.removeStore(shown));
    expect(refused.code).toBe("unsent_differs");
    expect(refused.unsent).toBe(1);
    expect(kept(device.store), "the refused removal changed the store").toEqual(
      before,
    );
  });

  it("refuses to remove a store a write reached after its unsent writes were read", async () => {
    const { device, written, shown } = await storeWithOneUnsent("remove-late");

    // Another app on the same store queues a write after they were read.
    other = await BindingDevice.start({
      module: requireModule(),
      store: device.store,
    });
    const late = await other.createItem({
      type: "core.note",
      properties: { title: "late", body: "late" },
    });
    expect(late.ok, JSON.stringify(late)).toBe(true);
    const lateId = late.ok ? late.value.id : "";
    await other.forget();
    const before = kept(device.store);

    const refused = refusalOf(await device.removeStore(shown));
    expect(refused.code).toBe("unsent_differs");
    expect(refused.unsent).toBe(2);
    expect(kept(device.store), "the refused removal changed the store").toEqual(
      before,
    );
    const still = await unsent(device);
    expect(still.writes.map((write) => write.id).sort()).toEqual(
      [...written, lateId].sort(),
    );
  });

  it("refuses to remove a store whose unsent writes it cannot read", async () => {
    const { device, shown } = await storeWithOneUnsent("remove-uncounted");
    const none = await nothing(device);
    // A queue whose shape hides its writes: what the store holds is unknown.
    edit(
      device.store,
      "ALTER TABLE queue RENAME COLUMN verdict TO answer_kind",
    );
    const before = kept(device.store);

    for (const agreed of [none, shown]) {
      const refused = refusalOf(await device.removeStore(agreed));
      expect(refused.code).toBe("unsent_differs");
      expect(
        refused.unsent,
        "the refusal counted writes it cannot read",
      ).toBeNull();
      expect(kept(device.store)).toEqual(before);
    }
  });

  it("removes a store whose unsent writes it cannot read when every write is agreed lost", async () => {
    const { device, shown } = await storeWithOneUnsent("remove-all");
    edit(
      device.store,
      "ALTER TABLE queue RENAME COLUMN verdict TO answer_kind",
    );
    // The witness: the confirmation of the writes it held does not remove it.
    expect(refusalOf(await device.removeStore(shown)).unsent).toBeNull();
    expect(Object.keys(held(device.store))).toContain("");

    const removed = await device.removeStoreLosingAll();
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(held(device.store)).toEqual({});
  });

  it("removes a store whose unsent writes it can read and finds none when every write is agreed lost", async () => {
    const started = await startBindingHarness("remove-all-empty", {
      server: false,
    });
    harness = started;
    const { device } = started;
    await device.forget();
    expect((await unsent(device)).writes).toEqual([]);

    const removed = await device.removeStoreLosingAll();
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(held(device.store)).toEqual({});
  });

  it("refuses to remove, agreeing to lose every write, a store whose unsent writes can be read when the removal begins, and keeps them", async () => {
    const { device, shown } = await storeWithOneUnsent("remove-all-readable");
    // The queue does not read when an app looks.
    edit(
      device.store,
      "ALTER TABLE queue RENAME COLUMN verdict TO answer_kind",
    );
    const looked = await device.readUnsent();
    expect(looked.ok, "the queue read when it was meant not to").toBe(false);
    // It reads again before the removal.
    edit(
      device.store,
      "ALTER TABLE queue RENAME COLUMN answer_kind TO verdict",
    );
    const before = kept(device.store);

    const refused = refusalOf(await device.removeStoreLosingAll());
    expect(refused.code).toBe("unsent_differs");
    expect(refused.unsent).toBe(1);
    expect(kept(device.store), "a refused removal changed the store").toEqual(
      before,
    );

    const listed = await unsent(device);
    expect(listed.confirmation).toBe(shown);
    const removed = await device.removeStore(listed.confirmation);
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(held(device.store)).toEqual({});
  });

  it("refuses a store SQLite cannot read store_damaged without saying a set-aside stopped", async () => {
    const { device } = await storeWithOneUnsent("damaged-flag");
    const store = readFileSync(device.store);
    writeFileSync(
      device.store,
      Buffer.concat([Buffer.alloc(100, 0xa5), store.subarray(100)]),
    );

    const opened = await device.tryOpen();
    expect(opened.opened, JSON.stringify(opened)).toBe(false);
    expect(opened.error?.code).toBe("store_damaged");
    expect(opened.error?.setAsideStopped).toBe(false);
  });

  it("removes a store the writer refuses wrong_schema with the confirmation of the unsent writes it lists", async () => {
    const { device, written } = await storeWithOneUnsent("remove-schema");
    edit(device.store, "PRAGMA user_version = 0");
    const opened = await device.tryOpen();
    expect(
      opened.error?.code,
      "the store at another version was not refused, so it cannot stand for another build's",
    ).toBe("wrong_schema");
    const listed = await unsent(device);
    expect(listed.writes.map((write) => write.id)).toEqual(written);

    expect(
      refusalOf(await device.removeStore(await nothing(device))).unsent,
    ).toBe(1);
    const removed = await device.removeStore(listed.confirmation);
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(held(device.store)).toEqual({});
  });

  it("removes what a removal left at a path with no store only with the confirmation of no writes", async () => {
    const started = await startBindingHarness("remove-absent", {
      server: false,
    });
    harness = started;
    const { device } = started;
    await device.forget();
    // A store holding nothing unsent goes with the confirmation of nothing.
    const empty = await unsent(device);
    expect(empty.writes).toEqual([]);
    expect((await device.removeStore(empty.confirmation)).ok).toBe(true);
    expect(held(device.store)).toEqual({});
    // What a removal stopped part way leaves: the fetched bytes and the lock.
    const blobs = `${device.store}.blobs`;
    mkdirSync(blobs);
    writeFileSync(join(blobs, "fetched"), "bytes");
    writeFileSync(`${device.store}.writer-lock`, "");
    const before = kept(device.store);
    expect(Object.keys(before)).toEqual([
      ".blobs/fetched",
      ".blobs",
      ".writer-lock",
    ]);

    const refused = refusalOf(await device.removeStore("not-a-confirmation"));
    expect(refused.code).toBe("unsent_differs");
    expect(refused.unsent).toBe(0);
    expect(kept(device.store)).toEqual(before);

    const listed = await unsent(device);
    expect(listed.writes).toEqual([]);
    expect(kept(device.store), "reading the writes changed the path").toEqual(
      before,
    );
    const removed = await device.removeStore(listed.confirmation);
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(held(device.store)).toEqual({});
    // Removed again: there is nothing left, and nothing to refuse.
    expect((await device.removeStore(listed.confirmation)).ok).toBe(true);
    expect(held(device.store)).toEqual({});
  });

  it("removes a symbolic link at a store's name and keeps what it leads to", async () => {
    const { device, shown } = await storeWithOneUnsent("remove-link");
    const elsewhere = tempFolder("marfa-device-elsewhere-");
    const outside = join(elsewhere, "outside.txt");
    writeFileSync(outside, "kept");
    const bytes = join(elsewhere, "bytes");
    mkdirSync(bytes);
    writeFileSync(join(bytes, "fetched"), "kept");
    // Links inside the folder of fetched bytes, to a file and to a folder.
    symlinkSync(outside, join(`${device.store}.blobs`, "link"));
    symlinkSync(bytes, join(`${device.store}.blobs`, "folder"));

    const removed = await device.removeStore(shown);
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(held(device.store)).toEqual({});
    expect(readFileSync(outside, "utf8")).toBe("kept");
    expect(readFileSync(join(bytes, "fetched"), "utf8")).toBe("kept");

    // The store's own names as links, to a file and to a folder elsewhere.
    symlinkSync(outside, `${device.store}-wal`);
    symlinkSync(bytes, `${device.store}.blobs`);
    expect(isLink(`${device.store}.blobs`)).toBe(true);
    const again = await device.removeStore(await nothing(device));
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(held(device.store)).toEqual({});
    expect(readFileSync(outside, "utf8")).toBe("kept");
    expect(readFileSync(join(bytes, "fetched"), "utf8")).toBe("kept");
  });

  it("refuses to remove a folder's store", async () => {
    const { device, shown } = await storeWithOneUnsent("remove-folder");
    edit(
      device.store,
      "INSERT INTO meta (key, value) VALUES ('folder_id', 'a-folder')",
    );
    const before = kept(device.store);

    expect(refusalOf(await device.removeStore(shown)).code).toBe("invalid");
    expect(kept(device.store)).toEqual(before);
  });

  it("refuses to remove a folder's store whose first page does not read", async () => {
    const root = tempFolder("marfa-folder-");
    mkdirSync(join(root, ".marfa"));
    const store = join(root, ".marfa", "core.sqlite");
    other = await BindingDevice.start({ module: requireModule(), store });
    await other.forget();
    const header = Buffer.alloc(100, 0xa5);
    writeFileSync(
      store,
      Buffer.concat([header, readFileSync(store).subarray(100)]),
    );
    const before = kept(store);

    expect(refusalOf(await other.removeStoreLosingAll()).code).toBe("invalid");
    expect(refusalOf(await other.removeStore(await nothing(other))).code).toBe(
      "invalid",
    );
    expect(kept(store)).toEqual(before);
  });

  it("refuses to remove or replace a store whose set-aside stopped part way, until a set-aside finishes it", async () => {
    const { device, shown } = await storeWithOneUnsent("remove-stopped");
    damageTable(device.store, "items");
    const command = new CliDevice({
      binary: requireBinary(),
      store: device.store,
    });
    const crashed = command.hold(["set-aside"], "device", {
      MARFA_TEST_FAULT: "set-aside-crash=store",
    });
    await crashed.exited();
    expect(crashed.exitCode(), "the set-aside did not stop").not.toBe(0);
    expect(existsSync(device.store), "the store was not moved").toBe(false);
    const made = `${device.store}.carrying`;
    const carried = digest(made);
    // The witness: the fetched bytes the new store keeps are there.
    const before = kept(device.store);
    expect(Object.keys(before)).toContain(".blobs/fetched");

    for (const refused of [
      await device.removeStore(shown),
      await device.removeStoreLosingAll(),
      await device.replaceRefused(),
    ]) {
      expect(refused.ok, "a store whose set-aside stopped was taken").toBe(
        false,
      );
      if (refused.ok) continue;
      expect(refused.refusal.code, refused.refusal.raw).toBe("store_damaged");
      expect(refused.refusal.raw).toContain("stopped part way");
      expect(
        (JSON.parse(refused.refusal.raw) as { setAsideStopped?: boolean })
          .setAsideStopped,
      ).toBe(true);
    }
    expect(kept(device.store)).toEqual(before);
    expect(digest(made)).toBe(carried);

    const done = await command.setAside();
    expect(done.ok && done.value.carried, JSON.stringify(done)).toBe(1);
    // The carried write reads, so only its confirmation removes the store.
    expect(refusalOf(await device.removeStoreLosingAll()).code).toBe(
      "unsent_differs",
    );
    const removed = await device.removeStore(
      (await unsent(device)).confirmation,
    );
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(held(device.store)).toEqual({});
  });
});
