import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { S3BlobStore } from "./blob-s3.js";
import { createBlobLayer } from "./blob-layer.js";
import type { BlobLayerConfig } from "./blob-layer.js";

let ctx: TestContext | undefined;
const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.cleanup();
  ctx = undefined;
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A disk-only configuration at `blobPath`. */
async function diskAt(): Promise<BlobLayerConfig> {
  const dir = await mkdtemp(join(tmpdir(), "blob-layer-test-"));
  dirs.push(dir);
  return {
    blobPath: dir,
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    s3ForcePathStyle: true,
    s3Prefix: "blobs",
  };
}

describe("createBlobLayer", () => {
  it("attaches the configured store with a row, and detaches the rows of stores no longer named", async () => {
    ctx = await createTestContext();
    const first = ctx.blobs.disk;
    const rows = await ctx.storage.blobs.listStores();
    expect(rows.map((row) => row.id)).toEqual([first.id]);
    expect(rows[0]?.detached_at).toBeNull();

    // Boot against a different folder: a different store, and the first
    // one's row is kept but marked detached, because the log may still
    // name copies there that nothing can now reach.
    const second = await createBlobLayer(ctx.storage, await diskAt());
    expect(second.disk.id).not.toBe(first.id);
    const afterMove = await ctx.storage.blobs.listStores();
    expect(afterMove.map((row) => [row.id, row.detached_at !== null])).toEqual([
      [first.id, true],
      [second.disk.id, false],
    ]);

    // Boot against the first folder again: its row is live again and the
    // other's is the one detached.
    const back = await createBlobLayer(ctx.storage, {
      ...(await diskAt()),
      blobPath: first.locator,
    });
    expect(back.disk.id).toBe(first.id);
    const afterReturn = await ctx.storage.blobs.listStores();
    expect(
      afterReturn.map((row) => [row.id, row.detached_at !== null]),
    ).toEqual([
      [first.id, false],
      [second.disk.id, true],
    ]);
  });

  it("audits configuration changes atomically and skips an unchanged boot", async () => {
    ctx = await createTestContext();
    const storage = ctx.storage;
    const before = await storage.blobs.listStores();
    expect(
      (await storage.audit.list({ action: "blob.stores_configured" })).data,
    ).toHaveLength(1);
    const raw = storage as unknown as {
      __sqliteRun(query: string, params: unknown[]): Promise<unknown>;
    };
    await raw.__sqliteRun(
      "CREATE TRIGGER refuse_store_configuration BEFORE INSERT ON audit_log WHEN NEW.action = 'blob.stores_configured' BEGIN SELECT RAISE(ABORT, 'store configuration audit refused'); END",
      [],
    );
    const currentConfig = {
      ...(await diskAt()),
      blobPath: ctx.blobs.disk.locator,
    };
    // An unchanged boot makes no domain write and therefore needs no audit.
    await expect(
      createBlobLayer(storage, currentConfig),
    ).resolves.toBeDefined();
    expect(await storage.blobs.listStores()).toEqual(before);
    const changedConfig = await diskAt();
    await expect(createBlobLayer(storage, changedConfig)).rejects.toThrow();
    expect(await storage.blobs.listStores()).toEqual(before);
    expect(
      (await storage.audit.list({ action: "blob.stores_configured" })).data,
    ).toHaveLength(1);
    await raw.__sqliteRun("DROP TRIGGER refuse_store_configuration", []);
    const changed = await createBlobLayer(storage, changedConfig);
    const entries = (
      await storage.audit.list({ action: "blob.stores_configured" })
    ).data;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      key_id: null,
      details: {
        attached: [changed.disk.id],
        updated: [],
        detached: [ctx.blobs.disk.id],
      },
    });
    expect(
      (await storage.blobs.listStores())
        .filter((row) => row.detached_at === null)
        .map((row) => row.id),
    ).toEqual([changed.disk.id]);
  });

  it("leaves registry and audits unchanged if external attachment fails", async () => {
    ctx = await createTestContext();
    const before = await ctx.storage.blobs.listStores();
    const audits = await ctx.storage.audit.list({
      action: "blob.stores_configured",
    });
    vi.spyOn(S3BlobStore.prototype, "attach").mockRejectedValueOnce(
      new Error("object store unavailable"),
    );
    await expect(
      createBlobLayer(ctx.storage, {
        ...(await diskAt()),
        s3Bucket: "fixture-bucket",
      }),
    ).rejects.toThrow("object store unavailable");
    expect(await ctx.storage.blobs.listStores()).toEqual(before);
    expect(
      await ctx.storage.audit.list({ action: "blob.stores_configured" }),
    ).toEqual(audits);
  });

  it("marks a copy in a detached store as such in the location log", async () => {
    ctx = await createTestContext();
    const res = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "text/plain",
      },
      body: new TextEncoder().encode("a copy the log will keep naming"),
    });
    expect(res.status).toBe(201);
    const { hash } = (await res.json()) as { hash: string };
    const before = await ctx.storage.blobs.listLocations(hash);
    expect(before.map((row) => row.detached)).toEqual([false]);

    await createBlobLayer(ctx.storage, await diskAt());
    const after = await ctx.storage.blobs.listLocations(hash);
    expect(after.map((row) => [row.store_id, row.detached])).toEqual([
      [ctx.blobs.disk.id, true],
    ]);
  });

  it("finds a store by id and answers undefined for one it has not attached", async () => {
    ctx = await createTestContext();
    expect(ctx.blobs.byId(ctx.blobs.disk.id)).toBe(ctx.blobs.disk);
    expect(ctx.blobs.byId("not-a-store")).toBeUndefined();
    expect(ctx.blobs.s3).toBeNull();
    expect(ctx.blobs.stores).toEqual([ctx.blobs.disk]);
  });
});
