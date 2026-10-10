import type { Transaction, TransactionMode } from "@libsql/client";
import {
  generateId,
  getEdgeTypeSchema,
  getTypeSchema,
} from "@withmarfa/shared";
import { createHash } from "node:crypto";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import * as tar from "tar-stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextEnrichmentSweeper } from "../enrichment/sweeper.js";
import { __resetEventLogForTests, initEventLog } from "../pubsub.js";
import {
  planArchiveTypes,
  writeArchiveTypes,
} from "../routes/restore-archive-types.js";
import { itemWrites } from "../storage/item-writes.js";
import { TrashPurger } from "../storage/retention.js";
import { VersionThinner } from "../storage/version-thinner.js";
import {
  createTestContext,
  request,
  withSecondStore,
  type TestContext,
} from "../test-utils.js";
import {
  dropBlobCopy,
  finishPendingCopyDeletions,
  purgeBlob,
} from "./blob-delete.js";
import { BlobIntegrityChecker } from "./blob-integrity.js";
import { BlobReplicator } from "./blob-replicate.js";

const commitFault = vi.hoisted(() => ({
  next: undefined as "before" | "after" | undefined,
  fired: 0,
}));
vi.mock("../storage/sqlite/connection.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../storage/sqlite/connection.js")>();
  return {
    ...actual,
    createConnection: async (
      ...args: Parameters<typeof actual.createConnection>
    ) => {
      const connection = await actual.createConnection(...args);
      const raw: { transaction(mode?: TransactionMode): Promise<Transaction> } =
        connection.raw;
      const begin = raw.transaction.bind(raw);
      raw.transaction = async (mode?: TransactionMode) => {
        const tx = await begin(mode ?? "write");
        const commit = tx.commit.bind(tx);
        tx.commit = async () => {
          const fault = commitFault.next;
          if (!fault) return commit();
          commitFault.next = undefined;
          commitFault.fired += 1;
          if (fault === "after") await commit();
          throw new Error("external commit acknowledgement fault");
        };
        return tx;
      };
      return connection;
    },
  };
});

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
});
afterEach(async () => {
  commitFault.next = undefined;
  vi.restoreAllMocks();
  __resetEventLogForTests();
  await ctx.cleanup();
});
function sql(query: string, params: unknown[] = []) {
  return (
    ctx.storage as unknown as {
      __sqliteRun(q: string, p: unknown[]): Promise<unknown>;
    }
  ).__sqliteRun(query, params);
}
async function refuse(action: string) {
  await sql(
    `CREATE TRIGGER refuse_external_audit BEFORE INSERT ON audit_log WHEN NEW.action = '${action}' BEGIN SELECT RAISE(ABORT, 'external audit refused'); END`,
  );
}
async function allow() {
  await sql("DROP TRIGGER refuse_external_audit");
}
function audits(action: string) {
  return ctx.storage.audit.list({ action });
}
function digest(bytes: Buffer) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
async function upload(bytes: Buffer) {
  return ctx.app.request("/blobs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.workingKey}`,
      "Content-Type": "text/plain",
    },
    body: bytes,
  });
}
async function stored(content: string) {
  const bytes = Buffer.from(content);
  expect((await upload(bytes)).status).toBe(201);
  return { bytes, hash: digest(bytes) };
}
async function archive(
  blob: { bytes: Buffer; hash: string },
  id: string,
  typeId?: string,
  withEdge = false,
) {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const collecting = (async () => {
    for await (const chunk of pack) {
      if (!Buffer.isBuffer(chunk)) throw new Error("Expected archive bytes");
      chunks.push(chunk);
    }
  })();
  function entry(name: string, bytes: Buffer) {
    pack.entry({ name, size: bytes.length }, bytes);
  }
  entry(
    "manifest.json",
    Buffer.from(
      JSON.stringify({
        version: 0,
        format: "marfa-archive-v0",
        created_at: new Date().toISOString(),
        item_count: 1,
        blob_count: 1,
        blobs: {
          [blob.hash]: {
            mime_type: "text/plain",
            size_bytes: blob.bytes.length,
          },
        },
      }),
    ),
  );
  entry(
    "items.ndjson",
    Buffer.from(
      JSON.stringify({
        item: {
          id,
          type: typeId ?? "core.note",
          properties: { body: "restore", blob_ref: blob.hash },
        },
      }) + "\n",
    ),
  );
  if (withEdge) {
    const targetId = generateId();
    entry(
      "edges.ndjson",
      Buffer.from(
        JSON.stringify({
          edge: {
            id: generateId(),
            source_id: id,
            target_id: targetId,
            edge_type: "references",
            properties: {},
          },
        }) + "\n",
      ),
    );
    // The target already exists, so this restore's event batch contains only
    // the newly restored source and its edge.
    await itemWrites(ctx.storage).create({
      id: targetId,
      type: "core.note",
      properties: { body: "target" },
    });
  }
  if (typeId)
    entry(
      "types.ndjson",
      Buffer.from(
        JSON.stringify({
          type: {
            id: typeId,
            label: "Restored",
            description: "Restored test type",
            version: 1,
            fields: {
              body: { type: "string", description: "Body" },
              blob_ref: { type: "string", description: "Blob" },
            },
          },
          provenance: { origin: "user" },
        }) + "\n",
      ),
    );
  entry(`blobs/${blob.hash}`, blob.bytes);
  pack.finalize();
  await collecting;
  return gzipSync(Buffer.concat(chunks));
}
async function restore(body: Buffer) {
  return ctx.app.request("/restore", {
    method: "POST",
    headers: {
      cookie: ctx.owner.cookie,
      origin: new URL(ctx.config.authBaseUrl).origin,
      "Content-Type": "application/gzip",
    },
    body,
  });
}

describe("external and background audit units with real SQLite and disk", () => {
  it("refuses an upload without a row, uploader claim or newly placed bytes, but keeps existing bytes", async () => {
    const held = await stored("previously stored");
    expect((await audits("blob.upload")).data).toHaveLength(1);
    await refuse("blob.upload");
    const fresh = Buffer.from("refused new bytes");
    expect((await upload(fresh)).status).toBe(500);
    expect(await ctx.storage.blobs.get(digest(fresh))).toBeNull();
    expect(await ctx.blobs.disk.has(digest(fresh))).toBeNull();
    expect((await upload(held.bytes)).status).toBe(500);
    expect(await ctx.blobs.disk.has(held.hash)).not.toBeNull();
    expect((await audits("blob.upload")).data).toHaveLength(1);
    await allow();
    expect((await upload(fresh)).status).toBe(201);
    expect((await audits("blob.upload")).data).toHaveLength(2);
  });

  it.each(["before", "after"] as const)(
    "handles a %s-commit fault without losing accepted bytes or duplicating audit",
    async (fault) => {
      const bytes = Buffer.from(`commit fault ${fault}`);
      const fired = commitFault.fired;
      commitFault.next = fault;
      const result = await upload(bytes);
      expect(commitFault.fired).toBe(fired + 1);
      if (fault === "after") {
        expect(result.status).toBe(201);
        expect(await ctx.blobs.disk.has(digest(bytes))).not.toBeNull();
        expect(await ctx.storage.blobs.get(digest(bytes))).not.toBeNull();
        expect((await audits("blob.upload")).data).toHaveLength(1);
      } else {
        expect(result.status).toBe(500);
        expect(await ctx.blobs.disk.has(digest(bytes))).toBeNull();
        expect(await ctx.storage.blobs.get(digest(bytes))).toBeNull();
        expect((await audits("blob.upload")).data).toHaveLength(0);
        expect((await upload(bytes)).status).toBe(201);
        expect((await audits("blob.upload")).data).toHaveLength(1);
      }
    },
  );

  it("retries a corrupt copy deletion before accepting replacement bytes", async () => {
    const blob = await stored("intact replacement");
    const { stores, second } = await withSecondStore(ctx);
    await second.put(blob.hash, {
      stream: Readable.from([blob.bytes]),
      size_bytes: blob.bytes.length,
    });
    await ctx.storage.blobs.recordLocation(blob.hash, second.id);
    const hex = blob.hash.slice("sha256:".length);
    await writeFile(
      join(ctx.blobs.disk.locator, hex.slice(0, 4), hex),
      "broken replacement",
    );
    const failingDelete = vi
      .spyOn(ctx.blobs.disk, "delete")
      .mockRejectedValueOnce(new Error("disk temporarily unavailable"))
      .mockRejectedValueOnce(new Error("disk still unavailable"));
    const checker = new BlobIntegrityChecker(ctx.storage, stores, {
      maxRows: 10,
      maxBytes: 1000,
    });
    expect((await checker.runOnce()).struck).toBe(1);
    expect(await ctx.storage.blobs.listPendingCopyDeletions(10)).toHaveLength(
      1,
    );
    expect((await upload(blob.bytes)).status).toBe(500);
    expect(await readdir(ctx.blobs.disk.spoolDir)).toEqual([]);
    expect(await ctx.storage.blobs.listPendingCopyDeletions(10)).toHaveLength(
      1,
    );
    failingDelete.mockRestore();
    expect((await upload(blob.bytes)).status).toBe(201);
    expect(await ctx.storage.blobs.listPendingCopyDeletions(10)).toEqual([]);
    expect((await checker.runOnce()).struck).toBe(0);
    expect((await audits("blob.copy_struck")).data).toHaveLength(1);
  });

  it("rolls back drop and cleanup intent on audit failure, then retries a committed disk deletion once", async () => {
    const blob = await stored("two copies");
    const { stores, second } = await withSecondStore(ctx);
    await second.put(blob.hash, {
      stream: Readable.from([blob.bytes]),
      size_bytes: blob.bytes.length,
    });
    await ctx.storage.blobs.recordLocation(blob.hash, second.id);
    await refuse("blob.copy_dropped");
    await expect(
      dropBlobCopy(ctx.storage, stores, blob.hash, ctx.blobs.disk.id, 1),
    ).rejects.toThrow();
    expect(await ctx.storage.blobs.listLocations(blob.hash)).toHaveLength(2);
    expect(await ctx.storage.blobs.listPendingCopyDeletions(10)).toEqual([]);
    expect(await ctx.blobs.disk.has(blob.hash)).not.toBeNull();
    await allow();
    const fail = vi
      .spyOn(ctx.blobs.disk, "delete")
      .mockRejectedValueOnce(new Error("disk unavailable"));
    // The drop has committed, so it stands though the bytes stay for now.
    await dropBlobCopy(ctx.storage, stores, blob.hash, ctx.blobs.disk.id, 1);
    expect(await ctx.storage.blobs.listLocations(blob.hash)).toHaveLength(1);
    expect(await ctx.storage.blobs.listPendingCopyDeletions(10)).toHaveLength(
      1,
    );
    expect((await audits("blob.copy_dropped")).data).toHaveLength(1);
    fail.mockRestore();
    await finishPendingCopyDeletions(ctx.storage, stores, 10);
    expect(await ctx.blobs.disk.has(blob.hash)).toBeNull();
    expect(await ctx.storage.blobs.listPendingCopyDeletions(10)).toEqual([]);
    expect((await audits("blob.copy_dropped")).data).toHaveLength(1);
  });

  it("keeps a missing copy's location on refused strike and audits its accepted removal", async () => {
    const blob = await stored("missing copy");
    await ctx.blobs.disk.delete(blob.hash);
    const checker = new BlobIntegrityChecker(ctx.storage, ctx.blobs, {
      maxRows: 10,
      maxBytes: 1000,
    });
    await refuse("blob.copy_struck");
    await expect(checker.runOnce()).rejects.toThrow();
    expect(await ctx.storage.blobs.listLocations(blob.hash)).toHaveLength(1);
    await allow();
    expect((await checker.runOnce()).struck).toBe(1);
    expect(await ctx.storage.blobs.listLocations(blob.hash)).toEqual([]);
    expect((await audits("blob.copy_struck")).data).toHaveLength(1);
  });

  it("couples orphan purge intent to audit before removing disk bytes", async () => {
    const blob = await stored("orphan");
    await ctx.storage.blobs.retainOrphans(
      [blob.hash],
      "2020-01-01T00:00:00.000Z",
    );
    const due = {
      before: "2021-01-01T00:00:00.000Z",
      runStartedAt: "2021-01-01T00:00:00.000Z",
    };
    await refuse("blob.purge");
    await expect(
      purgeBlob(ctx.storage, ctx.blobs, blob.hash, due),
    ).rejects.toThrow();
    expect(await ctx.storage.blobs.get(blob.hash)).not.toBeNull();
    expect(await ctx.storage.blobs.purgePending(blob.hash)).toBe(false);
    expect(await ctx.blobs.disk.has(blob.hash)).not.toBeNull();
    await allow();
    expect(await purgeBlob(ctx.storage, ctx.blobs, blob.hash, due)).toBe(true);
    expect(await ctx.blobs.disk.has(blob.hash)).toBeNull();
    expect((await audits("blob.purge")).data).toHaveLength(1);
  });

  it("refuses replication location and removes only its own prepared bytes", async () => {
    const blob = await stored("replication");
    const { stores, second } = await withSecondStore(ctx);
    const replicator = new BlobReplicator(ctx.storage, stores, {
      maxBlobs: 10,
      maxBytes: 1000,
    });
    await refuse("blob.copy_replicated");
    await expect(replicator.runOnce()).rejects.toThrow();
    expect(await ctx.storage.blobs.listLocations(blob.hash)).toHaveLength(1);
    expect(await second.has(blob.hash)).toBeNull();
    expect(await ctx.blobs.disk.has(blob.hash)).not.toBeNull();
    await allow();
    expect((await replicator.runOnce()).copied).toBe(1);
    expect(await second.has(blob.hash)).not.toBeNull();
    expect((await audits("blob.copy_replicated")).data).toHaveLength(1);
  });

  it.each(["ndjson", "archive"])(
    "refuses %s export before streaming if its audit fails",
    async (format) => {
      const path = `/export?format=${format}`;
      await refuse("export.run");
      expect(
        (await request(ctx.app, "GET", path, { key: ctx.workingKey })).status,
      ).toBe(500);
      await allow();
      const response = await request(ctx.app, "GET", path, {
        key: ctx.workingKey,
      });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect((await audits("export.run")).data).toHaveLength(1);
    },
  );

  it("rolls back archive preparation with restored items and events", async () => {
    const bytes = Buffer.from("archive preparation");
    const blob = { bytes, hash: digest(bytes) };
    const id = generateId();
    const typeId = "user.audit_archive";
    const body = await archive(blob, id, typeId, true);
    await refuse("restore_archive");
    expect((await restore(body)).status).toBe(500);
    expect(await ctx.storage.items.get(id)).toBeNull();
    expect((await ctx.storage.edges.list()).data).toEqual([]);
    expect(await ctx.storage.eventLog.getAfter(0n, 100)).toEqual([]);
    expect(await ctx.storage.blobs.get(blob.hash)).toBeNull();
    expect(await ctx.blobs.disk.has(blob.hash)).toBeNull();
    expect(getTypeSchema(typeId)).toBeUndefined();
    expect((await audits("restore_archive.type")).data).toEqual([]);
    expect((await audits("restore_archive.blobs")).data).toEqual([]);
    await allow();
    expect((await restore(body)).status).toBe(200);
    expect(await ctx.storage.items.get(id)).not.toBeNull();
    expect(await ctx.storage.eventLog.getAfter(0n, 100)).toHaveLength(2);
    expect((await ctx.storage.edges.list()).data).toHaveLength(1);
    expect((await audits("restore_archive")).data).toHaveLength(1);
    expect((await audits("restore_archive.type")).data).toHaveLength(1);
    expect((await audits("restore_archive.blobs")).data).toHaveLength(1);
    expect(await ctx.storage.blobs.get(blob.hash)).not.toBeNull();
    expect(getTypeSchema(typeId)).toBeDefined();
  });

  it.each(["type", "blobs"])(
    "rolls back refused archive %s preparation",
    async (unit) => {
      const bytes = Buffer.from(`archive ${unit}`);
      const blob = { bytes, hash: digest(bytes) };
      const typeId = "user.audit_refused";
      const body = await archive(blob, generateId(), typeId);
      await refuse(`restore_archive.${unit}`);
      expect((await restore(body)).status).toBe(500);
      expect(await ctx.storage.blobs.get(blob.hash)).toBeNull();
      expect(await ctx.blobs.disk.has(blob.hash)).toBeNull();
      if (unit === "type") expect(getTypeSchema(typeId)).toBeUndefined();
      await allow();
      expect((await restore(body)).status).toBe(200);
      expect((await audits(`restore_archive.${unit}`)).data).toHaveLength(1);
    },
  );

  it("rolls back archive edge type preparation and its registry on refused audit", async () => {
    const edge = {
      edge_type: {
        id: "custom.audit_edge",
        description: "Audit fixture",
        cardinality: "many-to-many",
      },
    };
    const register = async () =>
      writeArchiveTypes(
        ctx.storage,
        await planArchiveTypes(ctx.storage, [edge]),
        { client_ip: null },
      );
    await refuse("restore_archive.edge_type");
    await expect(register()).rejects.toThrow();
    expect(getEdgeTypeSchema("custom.audit_edge")).toBeUndefined();
    expect(await ctx.storage.edgeTypes.list()).not.toContainEqual(
      expect.objectContaining({ id: "custom.audit_edge" }),
    );
    await allow();
    expect((await register()).edgeTypesRegistered).toBe(1);
    expect(getEdgeTypeSchema("custom.audit_edge")).toBeDefined();
    expect((await audits("restore_archive.edge_type")).data).toHaveLength(1);
  });

  it("rolls back enrichment item, version and event together and permits a later retry", async () => {
    const blob = await stored("Text that can be extracted");
    const response = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.file",
        properties: { blob_ref: blob.hash, mime_type: "text/plain" },
      },
    });
    expect(response.status).toBe(201);
    const {
      item: { id },
    } = (await response.json()) as { item: { id: string } };
    const before = await ctx.storage.items.get(id);
    const versions = await ctx.storage.versions.all(id);
    const events = await ctx.storage.eventLog.getAfter(0n, 100);
    const sweeper = new TextEnrichmentSweeper({
      storage: ctx.storage,
      blobs: ctx.blobs,
      ocr: null,
      batchSize: 10,
      itemTimeoutMs: 10000,
      maxBlobBytes: 10000,
      maxTextChars: 1000,
      maxAttempts: 3,
      maxInflatedBytes: 64 * 1024 * 1024,
      maxMemoryBytes: 256 * 1024 * 1024,
    });
    await refuse("item.enrich");
    expect((await sweeper.runOnce()).failed).toBe(1);
    expect(await ctx.storage.items.get(id)).toEqual(before);
    expect(await ctx.storage.versions.all(id)).toEqual(versions);
    expect(await ctx.storage.eventLog.getAfter(0n, 100)).toEqual(events);
    await allow();
    expect((await sweeper.runOnce()).extracted).toBe(1);
    expect(
      (await ctx.storage.items.get(id))?.properties.extracted_text,
    ).toContain("Text that can be extracted");
    expect((await audits("item.enrich")).data).toHaveLength(1);
  });

  it("rolls back a trash batch on refused audit", async () => {
    const item = await itemWrites(ctx.storage).create({
      type: "core.note",
      properties: { body: "old trash" },
    });
    await itemWrites(ctx.storage).transition(item.id, "trashed");
    await sql("UPDATE items SET trashed_at = ? WHERE id = ?", [
      "2020-01-01T00:00:00.000Z",
      item.id,
    ]);
    const purger = new TrashPurger(ctx.storage, 1);
    await refuse("items.trash_purged");
    await expect(purger.runOnce()).rejects.toThrow();
    expect(
      (await ctx.storage.items.list({ all_states: true })).data,
    ).toHaveLength(1);
    await allow();
    expect(await purger.runOnce()).toBe(1);
    expect((await audits("items.trash_purged")).data).toHaveLength(1);
  });

  it("rolls back version thinning on refused audit", async () => {
    const item = await itemWrites(ctx.storage).create({
      type: "core.note",
      properties: { body: "v1" },
    });
    await itemWrites(ctx.storage).update(item.id, {
      may_read_type: () => true,
      properties: { body: "v2" },
      version: item.version,
    });
    await itemWrites(ctx.storage).update(item.id, {
      may_read_type: () => true,
      properties: { body: "v3" },
      version: item.version + 1,
    });
    await itemWrites(ctx.storage).update(item.id, {
      may_read_type: () => true,
      properties: { body: "v4" },
      version: item.version + 2,
    });
    const before = await ctx.storage.versions.all(item.id);
    expect(before.length).toBeGreaterThan(1);
    const thinner = new VersionThinner(ctx.storage, {
      recentDays: 0,
      dailySnapshotDays: 0,
      weeklySnapshotDays: 0,
      maxVersions: 1,
    });
    await refuse("item.versions_thinned");
    await expect(thinner.runOnce()).rejects.toThrow();
    expect(await ctx.storage.versions.all(item.id)).toEqual(before);
    await allow();
    expect((await thinner.runOnce()).pruned).toBe(before.length - 1);
    expect((await audits("item.versions_thinned")).data).toHaveLength(1);
  });
});
