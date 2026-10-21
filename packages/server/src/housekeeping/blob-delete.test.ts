/**
 * The copy rules are written over the location log, and a detached
 * store's copy is not a copy: nothing can reach it to check it.
 */
import { Readable } from "node:stream";
import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, request, withSecondStore } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { storeChecks } from "../storage/blob-layer.js";
import {
  CopiesBelowMinimum,
  LocationNotFound,
  dropBlobCopy,
  finishPendingCopyDeletions,
  purgeBlob,
} from "./blob-delete.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

async function upload(c: TestContext, content: string): Promise<string> {
  const res = await c.app.request("/blobs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.workingKey}`,
      "Content-Type": "application/octet-stream",
    },
    body: new TextEncoder().encode(content),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { hash: string }).hash;
}

describe("dropBlobCopy", () => {
  it("counts only attached stores' copies toward the minimum", async () => {
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const content = "held twice, one store detached";
    const hash = await upload(ctx, content);
    await second.put(hash, {
      stream: Readable.from([Buffer.from(content)]),
      size_bytes: content.length,
    });
    await ctx.storage.blobs.recordLocation(hash, second.id);
    // With both attached, the disk copy can go.
    await dropBlobCopy(ctx.storage, stores, hash, ctx.blobs.disk.id, 1);
    expect(await ctx.blobs.disk.has(hash)).toBeNull();
    // Put it back, then detach the second store: its copy stops counting,
    // so the disk copy is the last live one and stays.
    await ctx.blobs.disk.put(hash, {
      stream: Readable.from([Buffer.from(content)]),
      size_bytes: content.length,
    });
    await ctx.storage.blobs.recordLocation(hash, ctx.blobs.disk.id);
    await ctx.storage.blobs.detachStoresExcept([ctx.blobs.disk.id]);
    await expect(
      dropBlobCopy(ctx.storage, stores, hash, ctx.blobs.disk.id, 1),
    ).rejects.toBeInstanceOf(CopiesBelowMinimum);
    expect(await ctx.blobs.disk.has(hash)).not.toBeNull();
    // And the detached store's copy is not one the door can drop.
    await expect(
      dropBlobCopy(ctx.storage, stores, hash, second.id, 1),
    ).rejects.toBeInstanceOf(LocationNotFound);
    expect(await second.has(hash)).not.toBeNull();
  });

  it("succeeds once committed when the store cannot delete the bytes, and leaves the deletion to retry", async () => {
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const content = "held twice, one delete refused";
    const hash = await upload(ctx, content);
    await second.put(hash, {
      stream: Readable.from([Buffer.from(content)]),
      size_bytes: content.length,
    });
    await ctx.storage.blobs.recordLocation(hash, second.id);
    const original = ctx.blobs.disk.delete.bind(ctx.blobs.disk);
    ctx.blobs.disk.delete = () => Promise.reject(new Error("refused"));
    try {
      await dropBlobCopy(ctx.storage, stores, hash, ctx.blobs.disk.id, 1);
    } finally {
      ctx.blobs.disk.delete = original;
    }
    const left = await ctx.storage.blobs.listLocations(hash);
    expect(left.map((location) => location.store_id)).toEqual([second.id]);
    const pending = await ctx.storage.blobs.listPendingCopyDeletions(100);
    expect(pending).toContainEqual(
      expect.objectContaining({ hash, store_id: ctx.blobs.disk.id }),
    );
  });
});

/** Holds a store's `delete` open until released, so a deletion in flight
 *  can be raced against an upload of the same bytes. */
function gateDelete(store: { delete: (hash: string) => Promise<void> }) {
  const original = store.delete.bind(store);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  store.delete = async (hash: string) => {
    entered();
    await held;
    await original(hash);
  };
  return {
    started,
    release,
    restore: () => {
      store.delete = original;
    },
  };
}

const REPORTED_AT = "2026-01-01T00:00:00.000Z";
const DUE = {
  before: "2026-01-02T00:00:00.000Z",
  runStartedAt: "2026-01-02T00:00:00.000Z",
};

/** Report `hash` as an orphan long enough ago that `DUE` admits its purge. */
async function reportOrphan(c: TestContext, hash: string): Promise<void> {
  await c.storage.runInTransaction(() =>
    c.storage.blobs.retainOrphans([hash], REPORTED_AT),
  );
}

describe("the per-hash lock", () => {
  it("holds an upload of the same bytes behind a drop in flight, so the log and the bytes agree", async () => {
    // The drop removes the disk's row, then deletes its bytes. An upload
    // arriving between the two would see the bytes present, skip its own
    // put, and record the disk again for bytes about to go; behind the
    // lock it runs after the drop, puts the bytes back and records them.
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const content = "raced by a drop";
    const hash = await upload(ctx, content);
    await second.put(hash, {
      stream: Readable.from([Buffer.from(content)]),
      size_bytes: content.length,
    });
    await ctx.storage.blobs.recordLocation(hash, second.id);
    const gate = gateDelete(ctx.blobs.disk);
    try {
      const dropping = dropBlobCopy(
        ctx.storage,
        stores,
        hash,
        ctx.blobs.disk.id,
        1,
      );
      await gate.started;
      let uploaded = false;
      const uploading = upload(ctx, content).then((h) => {
        uploaded = true;
        return h;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(uploaded).toBe(false);
      gate.release();
      await dropping;
      expect(await uploading).toBe(hash);
    } finally {
      gate.restore();
    }
    const locations = await ctx.storage.blobs.listLocations(hash);
    expect(locations.map((l) => l.store_id).sort()).toEqual(
      [ctx.blobs.disk.id, second.id].sort(),
    );
    expect(await ctx.blobs.disk.has(hash)).not.toBeNull();
  });

  it("holds an upload of the same bytes behind a purge in flight, so the row outlives the purge", async () => {
    // The purge removes the registry row, then deletes the bytes. An
    // upload arriving between the two would find the bytes still there,
    // register them, answer 201, and then lose them to the purge; behind
    // the lock it runs after the purge and stores the bytes afresh.
    ctx = await createTestContext();
    const { stores } = await withSecondStore(ctx);
    const content = "raced by a purge";
    const hash = await upload(ctx, content);
    await reportOrphan(ctx, hash);
    const gate = gateDelete(ctx.blobs.disk);
    try {
      const purging = purgeBlob(ctx.storage, stores, hash, DUE);
      await gate.started;
      let uploaded = false;
      const uploading = upload(ctx, content).then((h) => {
        uploaded = true;
        return h;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(uploaded).toBe(false);
      gate.release();
      await purging;
      expect(await uploading).toBe(hash);
    } finally {
      gate.restore();
    }
    expect(await ctx.storage.blobs.get(hash)).not.toBeNull();
    expect(
      (await ctx.storage.blobs.listLocations(hash)).map((l) => l.store_id),
    ).toEqual([ctx.blobs.disk.id]);
    expect(await ctx.blobs.disk.has(hash)).not.toBeNull();
  });
});

describe("purgeBlob", () => {
  it("removes the bytes from every attached store, the rows and the registry", async () => {
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const content = "everywhere, then nowhere";
    const hash = await upload(ctx, content);
    // Bytes in the second store the log does not know about: they go too.
    await second.put(hash, {
      stream: Readable.from([Buffer.from(content)]),
      size_bytes: content.length,
    });
    expect(await ctx.blobs.disk.has(hash)).not.toBeNull();
    expect(await second.has(hash)).not.toBeNull();
    expect(await ctx.storage.blobs.get(hash)).not.toBeNull();
    expect(await ctx.storage.blobs.listLocations(hash)).toHaveLength(1);
    await reportOrphan(ctx, hash);
    expect(await purgeBlob(ctx.storage, stores, hash, DUE)).toBe(true);
    expect(await ctx.blobs.disk.has(hash)).toBeNull();
    expect(await second.has(hash)).toBeNull();
    expect(await ctx.storage.blobs.get(hash)).toBeNull();
    expect(await ctx.storage.blobs.listLocations(hash)).toEqual([]);
    expect(await ctx.storage.blobs.listPendingPurges()).toEqual([]);
  });

  it("purges nothing the report does not name as due", async () => {
    ctx = await createTestContext();
    const unreported = await upload(ctx, "never reported");
    expect(await purgeBlob(ctx.storage, ctx.blobs, unreported, DUE)).toBe(
      false,
    );
    expect(await ctx.blobs.disk.has(unreported)).not.toBeNull();
    // Reported, but not before the bounds.
    const fresh = await upload(ctx, "reported too recently");
    await ctx.storage.runInTransaction(() =>
      ctx!.storage.blobs.retainOrphans([fresh], DUE.before),
    );
    expect(await purgeBlob(ctx.storage, ctx.blobs, fresh, DUE)).toBe(false);
    expect(await ctx.blobs.disk.has(fresh)).not.toBeNull();
    expect(await ctx.storage.blobs.get(fresh)).not.toBeNull();
  });

  it("counts a version snapshot naming the blob, and not a longer hex run", async () => {
    ctx = await createTestContext();
    const hash = await upload(ctx, "named by history and by a longer run");
    const hex = hash.slice("sha256:".length);
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: `v1 ${hex}0` } },
    });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { item: { id: string } }).item.id;
    // A 65-character run holds the hex and is not a reference to it.
    await reportOrphan(ctx, hash);
    expect(await purgeBlob(ctx.storage, ctx.blobs, hash, DUE)).toBe(true);
    // Stored again, then named only by a snapshot: the item is edited past
    // the version that named it.
    expect(await upload(ctx, "named by history and by a longer run")).toBe(
      hash,
    );
    let version = 1;
    for (const body of [`v2 ${hash}`, "v3"]) {
      const res = await request(ctx.app, "PATCH", `/items/${id}`, {
        key: ctx.workingKey,
        body: { properties: { body }, version },
      });
      expect(res.status, await res.clone().text()).toBe(200);
      version = ((await res.json()) as { item: { version: number } }).item
        .version;
    }
    await reportOrphan(ctx, hash);
    expect(await purgeBlob(ctx.storage, ctx.blobs, hash, DUE)).toBe(false);
    expect(await ctx.blobs.disk.has(hash)).not.toBeNull();
    // Kept, and out of the report.
    expect(await ctx.storage.blobs.listOrphans()).toEqual([]);
  });
});

describe("a store's delete that does not answer", () => {
  it("leaves the deletion queued and the blob held until the delete ends, skips the blob meanwhile, and refuses an upload of its bytes", async () => {
    ctx = await createTestContext();
    const c = ctx;
    const { stores, second } = await withSecondStore(c);
    const content = "a delete that does not answer";
    const hash = await upload(c, content);
    await second.put(hash, {
      stream: Readable.from([Buffer.from(content)]),
      size_bytes: content.length,
    });
    await c.storage.blobs.recordLocation(hash, second.id);
    const gate = gateDelete(second);
    let deletes = 0;
    const gated = second.delete.bind(second);
    second.delete = (wanted) => {
      deletes++;
      return gated(wanted);
    };
    const timeout = storeChecks.timeoutMs;
    storeChecks.timeoutMs = 50;
    try {
      // The drop stands although its delete has not answered.
      await dropBlobCopy(c.storage, stores, hash, second.id, 1);
      expect(deletes).toBe(1);
      expect(
        (await c.storage.blobs.listLocations(hash)).map((l) => l.store_id),
      ).toEqual([c.blobs.disk.id]);
      const pending = () => c.storage.blobs.listPendingCopyDeletions(10);
      expect(await pending()).toEqual([{ hash, store_id: second.id }]);

      // A later pass skips the blob rather than waiting or deleting again.
      expect(await finishPendingCopyDeletions(c.storage, stores, 10)).toEqual(
        new Set(),
      );
      expect(deletes).toBe(1);
      expect(await pending()).toEqual([{ hash, store_id: second.id }]);

      // An upload of the same bytes is refused rather than kept waiting.
      const refused = await c.app.request("/blobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.workingKey}`,
          "Content-Type": "application/octet-stream",
        },
        body: new TextEncoder().encode(content),
      });
      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({
        error: { code: "blob_store_unavailable" },
      });

      // Once the delete ends, the lock goes with it.
      gate.release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await upload(c, content)).toBe(hash);
      await finishPendingCopyDeletions(c.storage, stores, 10);
      expect(deletes).toBe(2);
      expect(await pending()).toEqual([]);
    } finally {
      storeChecks.timeoutMs = timeout;
      gate.restore();
    }
  });

  it("stops asking a store whose delete went unanswered for the rest of the pass, and names it", async () => {
    ctx = await createTestContext();
    const c = ctx;
    const { stores, second } = await withSecondStore(c);
    const hashes: string[] = [];
    for (const content of ["first unanswered", "second unanswered"]) {
      const hash = await upload(c, content);
      await second.put(hash, {
        stream: Readable.from([Buffer.from(content)]),
        size_bytes: content.length,
      });
      await c.storage.runInTransaction(async () => {
        await c.storage.blobs.queueCopyDeletion(hash, second.id);
      });
      hashes.push(hash);
    }
    const gate = gateDelete(second);
    let deletes = 0;
    const gated = second.delete.bind(second);
    second.delete = (wanted) => {
      deletes++;
      return gated(wanted);
    };
    const timeout = storeChecks.timeoutMs;
    storeChecks.timeoutMs = 50;
    try {
      expect(await finishPendingCopyDeletions(c.storage, stores, 10)).toEqual(
        new Set([second.id]),
      );
      expect(deletes).toBe(1);
    } finally {
      storeChecks.timeoutMs = timeout;
      gate.release();
      gate.restore();
    }
  });
});

describe("an upload while the disk's queued deletion of its bytes does not answer", () => {
  it("answers 503 blob_store_unavailable, and stores the bytes once the delete ends", async () => {
    ctx = await createTestContext();
    const c = ctx;
    const content = "a queued disk deletion that does not answer";
    // Bytes on the disk that no row names, with their deletion queued, as a
    // refused restore or a strike leaves them.
    const hash = await upload(c, content);
    await c.storage.runInTransaction(async () => {
      await c.storage.blobs.queueCopyDeletion(hash, c.blobs.disk.id);
    });
    const gate = gateDelete(c.blobs.disk);
    const timeout = storeChecks.timeoutMs;
    storeChecks.timeoutMs = 50;
    try {
      const post = () =>
        c.app.request("/blobs", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${c.workingKey}`,
            "Content-Type": "application/octet-stream",
          },
          body: new TextEncoder().encode(content),
        });
      const refused = await post();
      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({
        error: { code: "blob_store_unavailable" },
      });

      // The witness: once the delete ends, the same upload is stored.
      gate.release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const stored = await post();
      expect(stored.status).toBe(201);
      expect(await c.blobs.disk.has(hash)).not.toBeNull();
    } finally {
      storeChecks.timeoutMs = timeout;
      gate.release();
      gate.restore();
    }
  });
});
