import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Item } from "@withmarfa/shared";
import { SINGLE_ACCOUNT, SINGLE_SPACE } from "../types.js";
import { openLocalStore, type LocalStore } from "./index.js";

let dir: string;
let path: string;
let store: LocalStore;

const identity = {
  origin: "http://localhost",
  spaceId: SINGLE_SPACE,
  accountId: SINGLE_ACCOUNT,
};

function serverItem(overrides: Partial<Item> = {}): Item {
  return {
    id: "01a00000-0000-7000-8000-000000000001",
    type: "core.note",
    state: "active",
    properties: { body: "from the server" },
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    timestamp: "2026-09-01T00:00:00.000Z",
    source: "test",
    version: 3,
    schema_version: 1,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "marfa-local-store-"));
  path = join(dir, "store.db");
  store = await openLocalStore({ path, identity });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("opening a store the host has not made a directory for", () => {
  // Every other test here reaches for `mkdtempSync` before it opens
  // anything, so the parent directory always exists and this path was
  // never once exercised. That is why 401 tests were green over it.
  //
  // A first launch on a real machine is the opposite: the application's
  // data directory is whatever the host decided, and nothing has made it
  // yet. The lock is taken before the database is opened, and only the
  // database creates the directory, so the claim's staging write fails on
  // a missing parent, is caught, and reports the lock as held by someone
  // else. Every write is then refused for the life of the process, with
  // no error raised and nothing written down — and the next launch works,
  // because by then the directory exists.
  it("is a writer on the first launch, not a reader that says nothing", async () => {
    let parent: string | undefined;
    let first: LocalStore | undefined;
    try {
      parent = mkdtempSync(join(tmpdir(), "marfa-local-first-"));
      const fresh = join(parent, "not-made-yet", "store.db");
      first = await openLocalStore({ path: fresh, identity });
      expect(first.writer).toBe(true);

      // The status is the claim; this is the consequence. A store that
      // reports itself a reader refuses the write, so asserting only on
      // the flag would pass against a store that had lost the ability to
      // do the one thing it is for.
      const note = await first.mutations.createItem({
        type: "core.note",
        properties: { body: "written on a first launch" },
      });
      expect(await first.outbox.count()).toBe(1);
      expect(await first.visible.getItem(note.id)).toMatchObject({
        id: note.id,
      });
    } finally {
      first?.close();
      if (parent !== undefined)
        rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("a lock that cannot be taken for a reason nobody is holding", () => {
  // The missing-directory defect had one visible artefact: a refusal
  // naming `pid -1`, a holder nobody could find. That came from `claim()`
  // mapping every errno to "somebody else has it", so a machine unable to
  // create a file looked identical to contention. Fixing the directory
  // removed one cause and left the mechanism, and the next errno through
  // it — a read-only volume, a full disk, a quota, a sandbox refusing to
  // create a file — reproduces the silence exactly.
  it("says so, rather than inventing a holder", async () => {
    const parent = mkdtempSync(join(tmpdir(), "marfa-local-locked-"));
    const guarded = join(parent, "guarded");
    mkdirSync(guarded);
    chmodSync(guarded, 0o500); // readable and traversable, not writable

    // Running as root defeats the mode, and so would a filesystem that
    // does not honour it. Establish that the write really is refused
    // before asserting on what the engine does about it, so this cannot
    // quietly become a test of nothing.
    let refused = false;
    try {
      writeFileSync(join(guarded, "probe"), "x");
    } catch {
      refused = true;
    }
    if (!refused) {
      chmodSync(guarded, 0o700);
      rmSync(parent, { recursive: true, force: true });
      return;
    }

    try {
      await expect(
        openLocalStore({ path: join(guarded, "store.db"), identity }),
      ).rejects.toThrow(/EACCES|permission/i);
    } finally {
      chmodSync(guarded, 0o700);
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("what the store keeps", () => {
  it("still holds the queue and the row after the process that made them is gone", async () => {
    const note = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "written offline" },
    });
    store.close();

    store = await openLocalStore({ path, identity });

    expect(await store.outbox.count()).toBe(1);
    expect(await store.visible.getItem(note.id)).toMatchObject({
      id: note.id,
      properties: { body: "written offline" },
    });
  });

  it("does not reuse a sequence number a settled mutation released", async () => {
    const first = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "one" },
    });
    const queued = await store.outbox.listForTarget(first.id);
    const firstSeq = queued[0]?.seq;
    if (firstSeq === undefined) throw new Error("expected a queued mutation");

    // Settling deletes the row, which frees its rowid. A queue that handed
    // the number out again would sort a new mutation ahead of one already
    // waiting, and the ordering the contract asks for is exactly that sort.
    await store.outbox.remove(firstSeq);

    const second = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "two" },
    });
    const next = (await store.outbox.listForTarget(second.id))[0];
    expect(next?.seq).toBeGreaterThan(firstSeq);
  });

  it("rolls a transaction back whole", async () => {
    const item = serverItem();
    await expect(
      store.transaction(async (tx) => {
        await tx.server.items.put(item);
        throw new Error("something went wrong halfway");
      }),
    ).rejects.toThrow("something went wrong halfway");

    expect(await store.server.items.get(item.id)).toBeUndefined();
  });
});

describe("the three layers", () => {
  it("leaves the metadata layer alone when an item is written", async () => {
    const item = serverItem();
    await store.server.items.put(item);
    await store.server.metadata.put({
      item_id: item.id,
      tags: ["kept"],
      extensions: { "app.notes": { pinned: true } },
    });

    // An item event carries neither tags nor extensions, so applying one
    // must not be able to reach them. The layers are separate tables for
    // exactly this.
    await store.server.items.put(
      serverItem({ version: 4, properties: { body: "edited elsewhere" } }),
    );

    expect(await store.server.metadata.get(item.id)).toEqual({
      item_id: item.id,
      tags: ["kept"],
      extensions: { "app.notes": { pinned: true } },
    });
    expect(await store.server.items.get(item.id)).toMatchObject({
      version: 4,
      properties: { body: "edited elsewhere" },
    });
  });

  it("does not persist a field the server works out per read", async () => {
    const item = serverItem({ orphaned: true });
    await store.server.items.put(item);

    // `orphaned` is computed from the space's connections as the item goes
    // out, and the stream never carries it at all. Stored, one read's answer
    // would outlive the fact it described with nothing able to correct it.
    const held = await store.server.items.get(item.id);
    expect(held).toBeDefined();
    expect(held && "orphaned" in held).toBe(false);
  });
});

describe("visible state", () => {
  it("is server state with the queue replayed over it", async () => {
    const item = serverItem();
    await store.server.items.put(item);

    await store.mutations.updateItem(item.id, { title: "mine, unsent" });

    // Another device's change to a different field arrives underneath.
    await store.server.items.put(
      serverItem({ version: 4, properties: { body: "theirs" } }),
    );

    const visible = await store.visible.getItem(item.id);
    expect(visible?.properties).toEqual({
      body: "theirs",
      title: "mine, unsent",
    });
  });

  it("lists a row whose create has never been sent", async () => {
    const note = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "only here" },
    });
    await store.mutations.createItem({
      type: "core.bookmark",
      properties: { url: "https://example.invalid" },
    });

    const notes = await store.visible.listItems({ type: "core.note" });
    expect(notes.map((entry) => entry.id)).toEqual([note.id]);
  });

  it("hides a row whose delete has not been sent", async () => {
    const item = serverItem();
    await store.server.items.put(item);
    await store.mutations.deleteItem(item.id);

    expect(await store.visible.getItem(item.id)).toBeUndefined();
    expect(await store.visible.listItems()).toHaveLength(0);
    // Server state is untouched: the server has not been told yet.
    expect(await store.server.items.get(item.id)).toBeDefined();
  });
});

describe("putting parked mutations back", () => {
  it("recovers only the reason being recovered from", async () => {
    const first = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "waiting on a credential" },
    });
    const second = await store.mutations.createItem({
      type: "core.note",
      properties: { body: "waiting on a person" },
    });
    const queued = await store.outbox.list();
    const spentCredential = queued[0];
    const forReview = queued[1];
    if (spentCredential === undefined || forReview === undefined) {
      throw new Error("expected two queued mutations");
    }

    const at = "2026-09-01T00:00:00.000Z";
    await store.outbox.block(spentCredential.seq, "auth", at);
    await store.outbox.block(forReview.seq, "needs_review", at);

    // A credential coming back says nothing about a write whose base
    // version is gone. Sweeping every blocked row would send that one
    // straight back into the refusal it is parked on, spend a request on
    // it, park it again, and tell the app in between that it was moving.
    expect(await store.outbox.retryAll("auth", at)).toBe(1);

    const after = new Map(
      (await store.outbox.list()).map((entry) => [entry.targetId, entry]),
    );
    expect(after.get(first.id)).toMatchObject({
      state: "pending",
      blockedReason: null,
    });
    expect(after.get(second.id)).toMatchObject({
      state: "blocked",
      blockedReason: "needs_review",
    });
  });
});

describe("sync state", () => {
  it("records the identity the store was opened against", async () => {
    expect(await store.syncState.read(identity)).toEqual({
      identity,
      cursor: null,
      hydratedAt: null,
      lastDrainedAt: null,
      // A store that has never connected owes no re-read. The distinction
      // matters because a null cursor alone cannot carry it.
      reimportOwedAt: null,
    });
  });

  it("keys the cursor by origin, space and account together", async () => {
    const other = { ...identity, accountId: "another-account" };
    await store.syncState.ensure(other);

    await store.syncState.setCursor(identity, "cursor-for-the-first");
    await store.syncState.setCursor(other, "cursor-for-the-second");

    expect((await store.syncState.read(identity))?.cursor).toBe(
      "cursor-for-the-first",
    );
    expect((await store.syncState.read(other))?.cursor).toBe(
      "cursor-for-the-second",
    );
  });
});
