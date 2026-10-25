import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { startBindingHarness, type BindingHarness } from "./harness.js";

/**
 * Removing a store with the writes the person agreed to lose, through the
 * binding, the only device that offers it. The fixture's process plays
 * another app on the same store where one holds the writer role.
 */

let harness: BindingHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
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
 * file of fetched bytes. The binding has let go of it.
 */
async function storeWithOneUnsent(label: string): Promise<BindingHarness> {
  const started = await startBindingHarness(label, { server: false });
  harness = started;
  const created = await started.device.createItem({
    type: "core.note",
    properties: { title: "kept", body: "kept" },
  });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  // The witness: the store holds the write unsent.
  const queue = await started.device.queue();
  expect(queue.ok && queue.value.length).toBe(1);
  await started.device.forget();
  const blobs = `${started.device.store}.blobs`;
  mkdirSync(blobs, { recursive: true });
  writeFileSync(join(blobs, "fetched"), "bytes");
  return started;
}

function refusalOf(
  outcome: Awaited<ReturnType<BindingHarness["device"]["removeStore"]>>,
): { code: string; unsent?: number | null; agreed?: number } {
  expect(outcome.ok, "the removal was not refused").toBe(false);
  if (outcome.ok) throw new Error("unreachable");
  return {
    code: outcome.refusal.code,
    ...(JSON.parse(outcome.refusal.raw) as {
      unsent?: number | null;
      agreed?: number;
    }),
  };
}

describe("removing a store", () => {
  it("removes a store holding the agreed number of unsent writes, with its log, fetched bytes and lock", async () => {
    const { device } = await storeWithOneUnsent("remove-store");
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

    const removed = await device.removeStore(1);
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
    const { device } = await storeWithOneUnsent("remove-held");
    const before = kept(device.store);

    // Another app's writer, as the core takes the role.
    const holder = new DatabaseSync(`${device.store}.writer-lock`);
    try {
      holder.exec("BEGIN EXCLUSIVE");
      expect(refusalOf(await device.removeStore(1)).code).toBe(
        "reading_handle",
      );
      expect(kept(device.store)).toEqual(before);
    } finally {
      holder.close();
    }

    // The witness: once the other writer lets go, the same call removes it.
    const removed = await device.removeStore(1);
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(held(device.store)).toEqual({});
  });

  it("refuses to remove a store holding another number of unsent writes, with its own count", async () => {
    const { device } = await storeWithOneUnsent("remove-unsent");
    const before = kept(device.store);

    for (const agreed of [0, 2]) {
      const refused = refusalOf(await device.removeStore(agreed));
      expect(refused.code).toBe("unsent_differs");
      expect(refused.unsent, "the refusal did not give the store's count").toBe(
        1,
      );
      expect(refused.agreed).toBe(agreed);
      expect(
        kept(device.store),
        "the refused removal changed the store",
      ).toEqual(before);
    }
  });

  it("refuses to remove a store whose unsent writes it cannot count", async () => {
    const { device } = await storeWithOneUnsent("remove-uncounted");
    // A queue whose shape hides its count: what the store holds is unknown.
    edit(
      device.store,
      "ALTER TABLE queue RENAME COLUMN verdict TO answer_kind",
    );
    const before = kept(device.store);

    for (const agreed of [0, 1]) {
      const refused = refusalOf(await device.removeStore(agreed));
      expect(refused.code).toBe("unsent_differs");
      expect(
        refused.unsent,
        "the refusal gave a count it cannot read",
      ).toBeNull();
      expect(kept(device.store)).toEqual(before);
    }
  });

  it("removes a store the writer refuses wrong_schema under its own count", async () => {
    const { device } = await storeWithOneUnsent("remove-schema");
    edit(
      device.store,
      "ALTER TABLE queue RENAME COLUMN follows TO after_write",
    );
    const opened = await device.tryOpen();
    expect(
      opened.error?.code,
      "the reshaped store was not refused, so it cannot stand for another build's",
    ).toBe("wrong_schema");
    const shown = (opened.error as { unsent?: number } | undefined)?.unsent;
    expect(shown).toBe(1);

    expect(refusalOf(await device.removeStore(0)).unsent).toBe(1);
    const removed = await device.removeStore(1);
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(held(device.store)).toEqual({});
  });

  it("removes what a removal left at a path with no store only when nothing is agreed to be lost", async () => {
    const started = await startBindingHarness("remove-absent", {
      server: false,
    });
    harness = started;
    const { device } = started;
    await device.forget();
    // A store holding nothing unsent goes with nothing agreed to be lost.
    expect((await device.removeStore(0)).ok).toBe(true);
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

    const refused = refusalOf(await device.removeStore(1));
    expect(refused.code).toBe("unsent_differs");
    expect(refused.unsent).toBe(0);
    expect(kept(device.store)).toEqual(before);

    const removed = await device.removeStore(0);
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(held(device.store)).toEqual({});
    // Removed again: there is nothing left, and nothing to refuse.
    expect((await device.removeStore(0)).ok).toBe(true);
  });

  it("removes a symbolic link at a store's name and keeps what it leads to", async () => {
    const { device } = await storeWithOneUnsent("remove-link");
    const elsewhere = mkdtempSync(
      join(realpathSync(tmpdir()), "marfa-device-elsewhere-"),
    );
    const outside = join(elsewhere, "outside.txt");
    writeFileSync(outside, "kept");
    const bytes = join(elsewhere, "bytes");
    mkdirSync(bytes);
    writeFileSync(join(bytes, "fetched"), "kept");
    // Links inside the folder of fetched bytes, to a file and to a folder.
    symlinkSync(outside, join(`${device.store}.blobs`, "link"));
    symlinkSync(bytes, join(`${device.store}.blobs`, "folder"));

    const removed = await device.removeStore(1);
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(held(device.store)).toEqual({});
    expect(readFileSync(outside, "utf8")).toBe("kept");
    expect(readFileSync(join(bytes, "fetched"), "utf8")).toBe("kept");

    // The store's own names as links, to a file and to a folder elsewhere.
    symlinkSync(outside, `${device.store}-wal`);
    symlinkSync(bytes, `${device.store}.blobs`);
    expect(isLink(`${device.store}.blobs`)).toBe(true);
    const again = await device.removeStore(0);
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(held(device.store)).toEqual({});
    expect(readFileSync(outside, "utf8")).toBe("kept");
    expect(readFileSync(join(bytes, "fetched"), "utf8")).toBe("kept");
  });

  it("refuses to remove a folder's store", async () => {
    const { device } = await storeWithOneUnsent("remove-folder");
    edit(
      device.store,
      "INSERT INTO meta (key, value) VALUES ('folder_id', 'a-folder')",
    );
    const before = kept(device.store);

    expect(refusalOf(await device.removeStore(1)).code).toBe("invalid");
    expect(kept(device.store)).toEqual(before);
  });
});
