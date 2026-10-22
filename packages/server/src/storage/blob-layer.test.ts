import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
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
    // one's row is kept but marked detached, because the copy record may still
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

  it("marks a copy in a detached store as such in the copy record", async () => {
    ctx = await createTestContext();
    const res = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "text/plain",
      },
      body: new TextEncoder().encode("a copy the copy record will keep naming"),
    });
    expect(res.status).toBe(201);
    const { hash } = (await res.json()) as { hash: string };
    const before = await ctx.storage.blobs.listCopies(hash);
    expect(before.map((row) => row.detached)).toEqual([false]);

    await createBlobLayer(ctx.storage, await diskAt());
    const after = await ctx.storage.blobs.listCopies(hash);
    expect(after.map((row) => [row.store_id, row.detached])).toEqual([
      [ctx.blobs.disk.id, true],
    ]);
  });

  describe("a disk folder found without its marker at start", () => {
    async function uploadOne(context: TestContext): Promise<string> {
      const res = await context.app.request("/blobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${context.workingKey}`,
          "Content-Type": "text/plain",
        },
        body: new TextEncoder().encode(`a saved file ${randomUUID()}`),
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { hash: string }).hash;
    }

    /** The configuration the context booted with, disk only. */
    async function sameFolder(context: TestContext): Promise<BlobLayerConfig> {
      return { ...(await diskAt()), blobPath: context.blobs.disk.locator };
    }

    it("refuses to start over a missing folder whose store holds copies, and creates nothing there", async () => {
      ctx = await createTestContext();
      const folder = ctx.blobs.disk.locator;
      await uploadOne(ctx);
      const before = await ctx.storage.blobs.listStores();
      const away = `${folder}.away`;
      await rename(folder, away);

      await expect(
        createBlobLayer(ctx.storage, await sameFolder(ctx)),
      ).rejects.toThrow(
        `The file folder ${folder} is missing its store marker`,
      );
      expect(existsSync(folder)).toBe(false);
      expect(await ctx.storage.blobs.listStores()).toEqual(before);

      // The witness: the folder back in place is the same store again.
      await rename(away, folder);
      const back = await createBlobLayer(ctx.storage, await sameFolder(ctx));
      expect(back.disk.id).toBe(ctx.blobs.disk.id);
    });

    it("refuses to start over a folder that lost only its marker while its store holds copies", async () => {
      ctx = await createTestContext();
      const folder = ctx.blobs.disk.locator;
      const hash = await uploadOne(ctx);
      const marker = join(folder, ".marfa-store");
      const kept = await readFile(marker, "utf8");
      await unlink(marker);
      const before = await ctx.storage.blobs.listStores();

      await expect(
        createBlobLayer(ctx.storage, await sameFolder(ctx)),
      ).rejects.toThrow(/Mount or restore it/);
      expect(existsSync(marker)).toBe(false);
      expect(await ctx.storage.blobs.listStores()).toEqual(before);
      expect(
        (await ctx.storage.blobs.listCopies(hash)).map((row) => [
          row.store_id,
          row.detached,
        ]),
      ).toEqual([[ctx.blobs.disk.id, false]]);

      await writeFile(marker, kept);
      const back = await createBlobLayer(ctx.storage, await sameFolder(ctx));
      expect(back.disk.id).toBe(ctx.blobs.disk.id);
    });

    it("starts a new store over the folder when its store holds no copies", async () => {
      ctx = await createTestContext();
      const folder = ctx.blobs.disk.locator;
      await rm(folder, { recursive: true });

      const fresh = await createBlobLayer(ctx.storage, await sameFolder(ctx));
      expect(fresh.disk.id).not.toBe(ctx.blobs.disk.id);
      expect(existsSync(join(folder, ".marfa-store"))).toBe(true);
    });

    it("creates the folder and a new store at a path where no store was recorded", async () => {
      ctx = await createTestContext();
      const folder = join(
        await mkdtemp(join(tmpdir(), "blob-layer-new-")),
        "a",
        "b",
      );
      dirs.push(join(folder, "..", ".."));
      await uploadOne(ctx);

      const fresh = await createBlobLayer(ctx.storage, {
        ...(await diskAt()),
        blobPath: folder,
      });
      expect(fresh.disk.id).not.toBe(ctx.blobs.disk.id);
      expect(existsSync(join(folder, ".marfa-store"))).toBe(true);
    });

    it("starts a new disk store over the missing folder when an object store is configured", async () => {
      ctx = await createTestContext();
      const folder = ctx.blobs.disk.locator;
      await uploadOne(ctx);
      await rm(folder, { recursive: true });
      vi.spyOn(S3BlobStore.prototype, "attach").mockImplementation(function (
        this: S3BlobStore,
      ) {
        (this as unknown as { storeId: string }).storeId = "fixture-bucket";
        return Promise.resolve();
      });

      const layer = await createBlobLayer(ctx.storage, {
        ...(await sameFolder(ctx)),
        s3Bucket: "fixture-bucket",
      });
      expect(layer.disk.id).not.toBe(ctx.blobs.disk.id);
      expect(existsSync(join(folder, ".marfa-store"))).toBe(true);
    });
  });

  it("finds a store by id and answers undefined for one it has not attached", async () => {
    ctx = await createTestContext();
    expect(ctx.blobs.byId(ctx.blobs.disk.id)).toBe(ctx.blobs.disk);
    expect(ctx.blobs.byId("not-a-store")).toBeUndefined();
    expect(ctx.blobs.s3).toBeNull();
    expect(ctx.blobs.stores).toEqual([ctx.blobs.disk]);
  });
});
