import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createGzip } from "node:zlib";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import * as tar from "tar-stream";
import {
  createTestContext,
  request,
  collectEdgeEvents,
  collectItemEvents,
  settle,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { PERMISSIONS, generateId, getTypeSchema } from "@withmarfa/shared";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";
import { purgeBlob } from "../housekeeping/blob-delete.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  // `createTestContext` does not wire the log — the server's bootstrap
  // does. Without this `publish` appends nothing, and the assertions that
  // read the log to prove a restore is replayable would find it empty
  // whatever the route did.
  initEventLog(ctx.storage.eventLog);
});

afterAll(async () => {
  __resetEventLogForTests();
  await ctx.cleanup();
});

/** Highest id in the log right now, so a case reads only its own rows. */
async function logCursor(): Promise<bigint> {
  const rows = await ctx.storage.eventLog.getAfter(0n, 100_000);
  return rows.reduce((max, r) => (r.id > max ? r.id : max), 0n);
}

async function logSince(cursor: bigint) {
  return ctx.storage.eventLog.getAfter(cursor, 100_000);
}

async function buildArchive(
  manifest: Record<string, unknown>,
  ndjsonLines: string[],
  blobs: { hash: string; data: Buffer }[],
  /** Lines for `edges.ndjson`. Omitted entirely when empty, so an archive
   *  without edges keeps the shape every existing case builds. */
  edgeLines: string[] = [],
  /** Lines for `types.ndjson`, omitted when empty for the same reason. */
  typeLines: string[] = [],
): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];

  const gzip = createGzip();
  gzip.on("data", (chunk: Buffer) => chunks.push(chunk));

  pack.pipe(gzip);

  const manifestBuf = Buffer.from(JSON.stringify(manifest));
  pack.entry({ name: "manifest.json", size: manifestBuf.length }, manifestBuf);

  const ndjsonBuf = Buffer.from(ndjsonLines.join("\n") + "\n");
  pack.entry({ name: "items.ndjson", size: ndjsonBuf.length }, ndjsonBuf);

  if (edgeLines.length > 0) {
    const edgesBuf = Buffer.from(edgeLines.join("\n") + "\n");
    pack.entry({ name: "edges.ndjson", size: edgesBuf.length }, edgesBuf);
  }

  if (typeLines.length > 0) {
    const typesBuf = Buffer.from(typeLines.join("\n") + "\n");
    pack.entry({ name: "types.ndjson", size: typesBuf.length }, typesBuf);
  }

  for (const blob of blobs) {
    pack.entry(
      { name: `blobs/${blob.hash}`, size: blob.data.length },
      blob.data,
    );
  }

  pack.finalize();

  await new Promise<void>((resolve) => gzip.on("end", resolve));
  return Buffer.concat(chunks);
}

function makeBlobData(content: string): {
  hash: string;
  data: Buffer;
} {
  const data = Buffer.from(content);
  const hex = createHash("sha256").update(data).digest("hex");
  return { hash: `sha256:${hex}`, data };
}

/** A version 2 manifest naming the blobs given as `text/plain`. */
function manifestFor(...blobs: { hash: string; data: Buffer }[]) {
  return {
    version: 0,
    format: "marfa-archive-v0",
    created_at: new Date().toISOString(),
    item_count: 1,
    blob_count: blobs.length,
    blobs: Object.fromEntries(
      blobs.map((blob) => [
        blob.hash,
        { mime_type: "text/plain", size_bytes: blob.data.length },
      ]),
    ),
  };
}

/** One `items.ndjson` line: a note naming the blob, as an export writes a
 *  row whose reference lent its reach, with what else is given on the row. */
function noteLine(
  blob: { hash: string },
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    item: {
      type: "core.note",
      properties: { body: "Spooled", blob_ref: blob.hash },
      ...extra,
    },
    lending_blobs: [blob.hash],
  });
}

/** The archive posted with the operator key. */
async function postArchive(archive: Buffer): Promise<Response> {
  return ctx.app.request("/admin/restore-archive", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.operatorKey}`,
      "Content-Type": "application/gzip",
    },
    body: archive,
  });
}

async function errorOf(
  res: Response,
): Promise<{ code: string; message: string }> {
  return ((await res.json()) as { error: { code: string; message: string } })
    .error;
}

describe("POST /admin/restore-archive", () => {
  it("imports items and blobs from an archive", async () => {
    const blob = makeBlobData("archive-import-blob-test");
    const source = `archive-restore-${Math.random().toString(36).slice(2)}`;

    const archive = await buildArchive(
      {
        version: 0,
        format: "marfa-archive-v0",
        created_at: new Date().toISOString(),
        item_count: 1,
        blob_count: 1,
        blobs: {
          [blob.hash]: {
            mime_type: "text/plain",
            size_bytes: blob.data.length,
          },
        },
      },
      [
        JSON.stringify({
          item: {
            type: "core.note",
            properties: { body: "From archive", blob_ref: blob.hash },
            source,
            source_id: "ai-1",
          },
          lending_blobs: [blob.hash],
        }),
      ],
      [blob],
    );

    const res = await ctx.app.request(`/admin/restore-archive`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.operatorKey}`,
        "Content-Type": "application/gzip",
      },
      body: archive,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      imported: number;
      duplicates: number;
      blobs_imported: number;
    };
    expect(data.imported).toBe(1);
    expect(data.blobs_imported).toBe(1);

    const blobRes = await request(ctx.app, "GET", `/blobs/${blob.hash}`, {
      key: ctx.workingKey,
    });
    expect(blobRes.status).toBe(200);
    // The type the manifest named, not the default an unnamed entry gets.
    expect(blobRes.headers.get("Content-Type")).toBe("text/plain");
    const blobContent = Buffer.from(await blobRes.arrayBuffer());
    expect(blobContent.toString()).toBe("archive-import-blob-test");
  });

  it("leaves no spool behind, after a restore and after a refusal that came once the blobs were read", async () => {
    const spoolDir = ctx.blobs.disk.spoolDir;
    // The witness that spools were minted at all: every path the store
    // hands out for this request, seen under its spool directory and gone
    // once the request has answered.
    const minted = vi.spyOn(ctx.blobs.disk, "spoolPath");
    const spoolsMinted = () => {
      const paths = minted.mock.results.map((r) => r.value as string);
      minted.mockClear();
      for (const path of paths) expect(dirname(path)).toBe(spoolDir);
      return paths;
    };

    // Refused after its entries were read: an invalid archived date,
    // with a blob entry ahead of them. The blob's spool goes with the
    // refusal and the bytes never reach the store.
    const refused = makeBlobData("spooled then refused");
    const refusal = await postArchive(
      await buildArchive(
        manifestFor(refused),
        [noteLine(refused, { created_at: "not-a-date" })],
        [refused],
      ),
    );
    expect(refusal.status).toBe(400);
    expect((await errorOf(refusal)).message).toContain(
      "created_at must be a valid instant",
    );
    // The body's spool and the blob entry's.
    const refusedSpools = spoolsMinted();
    expect(refusedSpools).toHaveLength(2);
    for (const path of refusedSpools) expect(existsSync(path)).toBe(false);
    expect(readdirSync(spoolDir)).toEqual([]);
    expect(await ctx.blobs.disk.has(refused.hash)).toBeNull();

    // A valid row restores, and its spools are consumed:
    // the blob's moved into place, the body's removed.
    const kept = makeBlobData("spooled then kept");
    const fine = await buildArchive(
      manifestFor(kept),
      [noteLine(kept)],
      [kept],
    );
    const restored = await postArchive(fine);
    expect(restored.status).toBe(200);
    expect(
      ((await restored.json()) as { blobs_imported: number }).blobs_imported,
    ).toBe(1);
    const keptSpools = spoolsMinted();
    expect(keptSpools).toHaveLength(2);
    for (const path of keptSpools) expect(existsSync(path)).toBe(false);
    expect(readdirSync(spoolDir)).toEqual([]);
    expect(await ctx.blobs.disk.has(kept.hash)).toEqual({
      size_bytes: kept.data.length,
    });

    // Restored again, the disk already holds the bytes: the entry still
    // counts as carried, its spool is removed rather than moved, and the
    // bytes stay.
    const again = await postArchive(fine);
    expect(again.status).toBe(200);
    expect(
      ((await again.json()) as { blobs_imported: number }).blobs_imported,
    ).toBe(1);
    const againSpools = spoolsMinted();
    expect(againSpools).toHaveLength(2);
    for (const path of againSpools) expect(existsSync(path)).toBe(false);
    expect(readdirSync(spoolDir)).toEqual([]);
    expect(await ctx.blobs.disk.has(kept.hash)).toEqual({
      size_bytes: kept.data.length,
    });
    minted.mockRestore();
  });

  it("takes its spools with it on the lifecycle's and the registry's refusals, and when a write fails", async () => {
    const spoolDir = ctx.blobs.disk.spoolDir;

    // A state the lifecycle cannot produce, refused with a blob entry read.
    const lifecycle = makeBlobData("spooled, then a state refused");
    const gate = await postArchive(
      await buildArchive(
        manifestFor(lifecycle),
        [noteLine(lifecycle, { state: "revoked" })],
        [lifecycle],
      ),
    );
    expect(gate.status).toBe(400);
    expect((await errorOf(gate)).message).toContain("cannot produce");
    expect(readdirSync(spoolDir)).toEqual([]);
    expect(await ctx.blobs.disk.has(lifecycle.hash)).toBeNull();

    // A type the registry refuses, with a blob entry read.
    const registry = makeBlobData("spooled, then a type refused");
    const malformed = await postArchive(
      await buildArchive(
        manifestFor(registry),
        [noteLine(registry)],
        [registry],
        [],
        [
          JSON.stringify({
            type: {
              id: "user.garbage_spool",
              name: "Garbage",
              description: "Field type is not a field type.",
              version: 1,
              fields: { title: { type: "not-a-real-type", description: "T." } },
            },
          }),
        ],
      ),
    );
    expect(malformed.status).toBe(400);
    expect(readdirSync(spoolDir)).toEqual([]);
    expect(await ctx.blobs.disk.has(registry.hash)).toBeNull();

    // The disk store's write fails on the first of two blobs: the request
    // fails, and neither blob's spool nor bytes are left.
    const first = makeBlobData("spooled, then the store failed, one");
    const second = makeBlobData("spooled, then the store failed, two");
    const put = vi
      .spyOn(ctx.blobs.disk, "put")
      .mockRejectedValueOnce(new Error("disk fault"));
    const faulted = await postArchive(
      await buildArchive(
        manifestFor(first, second),
        [noteLine(first), noteLine(second)],
        [first, second],
      ),
    );
    put.mockRestore();
    expect(faulted.status).toBe(500);
    expect(readdirSync(spoolDir)).toEqual([]);
    expect(await ctx.blobs.disk.has(first.hash)).toBeNull();
    expect(await ctx.blobs.disk.has(second.hash)).toBeNull();

    // The filesystem fails while an entry is being read: a fault, answered
    // as one and not as a bad archive, and the body's spool goes.
    const faulty = makeBlobData("spooled into a directory that is not there");
    const original = ctx.blobs.disk.spoolPath.bind(ctx.blobs.disk);
    const mint = vi
      .spyOn(ctx.blobs.disk, "spoolPath")
      .mockImplementationOnce(original)
      .mockImplementationOnce(() => join(spoolDir, "missing", "entry"));
    const fault = await postArchive(
      await buildArchive(manifestFor(faulty), [noteLine(faulty)], [faulty]),
    );
    mint.mockRestore();
    expect(fault.status).toBe(500);
    expect((await errorOf(fault)).code).toBe("internal_error");
    expect(readdirSync(spoolDir)).toEqual([]);
    expect(await ctx.blobs.disk.has(faulty.hash)).toBeNull();
  });

  it("leaves out an entry whose bytes do not hash to its name", async () => {
    const named = makeBlobData("the bytes the name promises");
    const carried = makeBlobData("the bytes the entry carries");
    const mismatch = await postArchive(
      await buildArchive(
        manifestFor(named),
        [noteLine(named)],
        [{ hash: named.hash, data: carried.data }],
      ),
    );
    expect(mismatch.status).toBe(200);
    expect(
      ((await mismatch.json()) as { blobs_imported: number }).blobs_imported,
    ).toBe(0);
    expect(await ctx.blobs.disk.has(named.hash)).toBeNull();
    expect(await ctx.blobs.disk.has(carried.hash)).toBeNull();
    expect(readdirSync(ctx.blobs.disk.spoolDir)).toEqual([]);
    const absent = await request(ctx.app, "GET", `/blobs/${named.hash}`, {
      key: ctx.operatorKey,
    });
    expect(absent.status).toBe(404);

    // The same bytes under their own name are taken.
    const honest = await postArchive(
      await buildArchive(manifestFor(carried), [noteLine(carried)], [carried]),
    );
    expect(honest.status).toBe(200);
    expect(
      ((await honest.json()) as { blobs_imported: number }).blobs_imported,
    ).toBe(1);
    expect(await ctx.blobs.disk.has(carried.hash)).toEqual({
      size_bytes: carried.data.length,
    });
  });

  it("rejects archives with unsupported version", async () => {
    const archive = await buildArchive(
      { version: 99, format: "marfa-archive-v99" },
      [],
      [],
    );

    const res = await ctx.app.request("/admin/restore-archive", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.operatorKey}`,
        "Content-Type": "application/gzip",
      },
      body: archive,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toContain("version 99");
    expect(body.error.message).toContain(
      "read only by the build that wrote it",
    );
  });

  it("refuses a manifest missing or mistyping a field it reads, naming the field, and writes nothing", async () => {
    const blob = makeBlobData("manifest-shape-blob");
    const line = (sourceId: string) =>
      noteLine(blob, { source: "manifest-shape", source_id: sourceId });
    const withoutBlobs: Record<string, unknown> = manifestFor(blob);
    delete withoutBlobs.blobs;
    const cases: { manifest: unknown; path: string }[] = [
      { manifest: withoutBlobs, path: "blobs" },
      { manifest: { ...manifestFor(blob), blobs: null }, path: "blobs" },
      {
        manifest: {
          ...manifestFor(blob),
          blobs: { [blob.hash]: { mime_type: 7, size_bytes: 1 } },
        },
        path: `blobs.${blob.hash}.mime_type`,
      },
      {
        manifest: {
          ...manifestFor(blob),
          blobs: { [blob.hash]: { mime_type: "text/plain" } },
        },
        path: `blobs.${blob.hash}.size_bytes`,
      },
      { manifest: { ...manifestFor(blob), version: "0" }, path: "version" },
      { manifest: { blobs: {} }, path: "version" },
      { manifest: [], path: "" },
    ];

    for (const [index, { manifest, path }] of cases.entries()) {
      const sourceId = `manifest-shape-${String(index)}`;
      const res = await postArchive(
        await buildArchive(
          manifest as Record<string, unknown>,
          [line(sourceId)],
          [blob],
        ),
      );
      expect(res.status, JSON.stringify(manifest)).toBe(400);
      const body = (await res.json()) as {
        error: {
          code: string;
          message: string;
          details?: { errors?: { path: string }[] };
        };
      };
      expect(body.error.code).toBe("validation_error");
      expect(body.error.message).toContain("manifest.json");
      expect(body.error.details?.errors?.map((e) => e.path)).toContain(path);
      expect(
        await ctx.storage.items.findBySourceId("manifest-shape", sourceId),
      ).toBeNull();
    }

    // The witness: the same archive under a well-formed manifest restores.
    const restored = await postArchive(
      await buildArchive(
        manifestFor(blob),
        [line("manifest-shape-ok")],
        [blob],
      ),
    );
    expect(restored.status).toBe(200);
    expect(
      await ctx.storage.items.findBySourceId(
        "manifest-shape",
        "manifest-shape-ok",
      ),
    ).not.toBeNull();
  });

  it("rejects empty bodies", async () => {
    const res = await ctx.app.request("/admin/restore-archive", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.operatorKey}`,
        "Content-Type": "application/gzip",
      },
      body: new Uint8Array(0),
    });
    expect(res.status).toBe(400);
    // The door's own refusal, not the decompressor's.
    expect((await errorOf(res)).message).toBe("Empty archive");
  });

  it("refuses a body the gzip reader cannot parse and stays up", async () => {
    const postBody = (body: Uint8Array) =>
      ctx.app.request("/admin/restore-archive", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.operatorKey}`,
          "Content-Type": "application/gzip",
        },
        body,
      });

    const notGzip = await postBody(new TextEncoder().encode("not a gzip body"));
    expect(notGzip.status).toBe(400);
    expect(
      ((await notGzip.json()) as { error: { code: string } }).error.code,
    ).toBe("validation_error");

    const archive = await buildArchive(
      {
        version: 0,
        format: "marfa-archive-v0",
        created_at: new Date().toISOString(),
        item_count: 0,
        blob_count: 0,
        blobs: {},
      },
      [],
      [],
    );
    const truncated = await postBody(archive.subarray(0, archive.length - 8));
    expect(truncated.status).toBe(400);
    expect(
      ((await truncated.json()) as { error: { code: string } }).error.code,
    ).toBe("validation_error");

    // The point of the case: the refusals leave the process serving.
    const after = await request(ctx.app, "GET", "/items?limit=1", {
      key: ctx.workingKey,
    });
    expect(after.status).toBe(200);
  });

  it("requires the operator key", async () => {
    // A working credential rather than the operator key, because this door
    // is exactly what an operator key opens.
    const rawKey = `marfa_k1_member_${Math.random().toString(36).slice(2)}`;
    const keyHash = hashApiKey(rawKey, "test-salt");
    await ctx.storage.keys.create(
      {
        label: "restore-member",
        source: `restore-member-${rawKey.slice(-6)}`,
        permissions: [...PERMISSIONS],
        type_permissions: { "*": "write" },
        is_operator: false,
      },
      keyHash,
    );

    const archive = await buildArchive(
      {
        version: 0,
        format: "marfa-archive-v0",
        created_at: new Date().toISOString(),
        item_count: 0,
        blob_count: 0,
        blobs: {},
      },
      [],
      [],
    );

    const res = await ctx.app.request("/admin/restore-archive", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rawKey}`,
        "Content-Type": "application/gzip",
      },
      body: archive,
    });
    expect(res.status).toBe(403);
  });

  it("round-trips: archive export then restore preserves blobs", async () => {
    const blobContent = new TextEncoder().encode("roundtrip-archive-blob");
    const uploadRes = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "text/plain",
      },
      body: blobContent,
    });
    const { hash: blobHash } = (await uploadRes.json()) as { hash: string };

    const source = `rt-archive-${Math.random().toString(36).slice(2)}`;
    await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: "Roundtrip", blob_ref: blobHash },
        source,
        source_id: "rta-1",
      },
    });

    const exportRes = await request(ctx.app, "GET", "/export?format=archive", {
      key: ctx.workingKey,
    });
    expect(exportRes.status).toBe(200);
    const archiveData = Buffer.from(await exportRes.arrayBuffer());

    const restoreRes = await ctx.app.request(`/admin/restore-archive`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.operatorKey}`,
        "Content-Type": "application/gzip",
      },
      body: archiveData,
    });
    expect(restoreRes.status).toBe(200);
    const data = (await restoreRes.json()) as {
      imported: number;
      duplicates: number;
      blobs_imported: number;
    };
    // Items with same source_id are deduplicated
    expect(data.duplicates).toBeGreaterThan(0);
    // At least the blob uploaded above, which the export carries.
    expect(data.blobs_imported).toBeGreaterThanOrEqual(1);
    expect(readdirSync(ctx.blobs.disk.spoolDir)).toEqual([]);
  });
});

describe("POST /admin/restore-archive against the orphan sweep", () => {
  it("keeps bytes it found already stored when a purge is due for them", async () => {
    // The restore finds the bytes on disk, keeps them rather than its own
    // copy, and registers its rows a moment later. A purge landing between
    // the two would delete the bytes the restore then registers.
    const blob = makeBlobData(
      `restored over a due purge ${String(Date.now())}`,
    );
    const uploaded = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "text/plain",
      },
      body: blob.data,
    });
    expect(uploaded.status).toBe(201);
    await ctx.storage.runInTransaction(() =>
      ctx.storage.blobs.retainOrphans([blob.hash], "2026-01-01T00:00:00.000Z"),
    );
    const due = {
      before: "2026-01-02T00:00:00.000Z",
      runStartedAt: "2026-01-02T00:00:00.000Z",
    };

    const disk = ctx.blobs.disk;
    const has = disk.has.bind(disk);
    let checked = false;
    disk.has = async (hash) => {
      if (hash === blob.hash) checked = true;
      return has(hash);
    };
    const storage = ctx.storage;
    const runInTransaction = storage.runInTransaction.bind(storage);
    let purging: Promise<boolean> | undefined;
    storage.runInTransaction = async <T>(fn: () => T | Promise<T>) => {
      if (checked && !purging) {
        purging = purgeBlob(storage, ctx.blobs, blob.hash, due);
        // Long enough for the purge to finish when nothing holds it back.
        await Promise.race([
          purging,
          new Promise((resolve) => setTimeout(resolve, 200)),
        ]);
      }
      return runInTransaction(fn);
    };
    let res: Response;
    try {
      res = await postArchive(
        await buildArchive(manifestFor(blob), [noteLine(blob)], [blob]),
      );
    } finally {
      disk.has = has;
      storage.runInTransaction = runInTransaction;
    }
    expect(res.status, await res.clone().text()).toBe(200);
    expect(purging).toBeDefined();
    expect(await purging).toBe(false);
    expect(await ctx.storage.blobs.get(blob.hash)).not.toBeNull();
    expect(await disk.has(blob.hash)).not.toBeNull();
    const served = await ctx.app.request(`/blobs/${blob.hash}`, {
      headers: { Authorization: `Bearer ${ctx.operatorKey}` },
    });
    expect(served.status).toBe(200);
  });
});

describe("POST /admin/restore-archive refused after its blobs are stored", () => {
  it("never takes back bytes an upload was told are stored meanwhile", async () => {
    // Blob preparation commits before item restore; a refused item restore
    // keeps those audited bytes. An upload of the same bytes also keeps them.
    const blob = makeBlobData(
      `uploaded during a refused restore ${String(Date.now())}`,
    );
    const storage = ctx.storage;
    const runInTransaction = storage.runInTransaction.bind(storage);
    let uploading: Promise<Response> | undefined;
    storage.runInTransaction = async <T>(fn: () => T | Promise<T>) => {
      if (!uploading && (await storage.blobs.get(blob.hash)) !== null) {
        uploading = Promise.resolve(
          ctx.app.request("/blobs", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${ctx.workingKey}`,
              "Content-Type": "text/plain",
            },
            body: blob.data,
          }),
        );
        // Long enough for the upload to land when nothing holds it back.
        await Promise.race([
          uploading,
          new Promise((resolve) => setTimeout(resolve, 200)),
        ]);
        throw new Error("rows refused");
      }
      return runInTransaction(fn);
    };
    let res: Response;
    try {
      res = await postArchive(
        await buildArchive(manifestFor(blob), [noteLine(blob)], [blob]),
      );
    } finally {
      storage.runInTransaction = runInTransaction;
    }
    expect(res.status).toBe(500);
    expect(uploading).toBeDefined();
    const uploaded = await uploading;
    expect(uploaded?.status).toBe(201);
    expect(await storage.blobs.get(blob.hash)).not.toBeNull();
    expect(await ctx.blobs.disk.has(blob.hash)).not.toBeNull();
    const served = await ctx.app.request(`/blobs/${blob.hash}`, {
      headers: { Authorization: `Bearer ${ctx.operatorKey}` },
    });
    expect(served.status).toBe(200);
  });
});

describe("POST /admin/restore-archive refused over bytes a purge left", () => {
  it("leaves a row naming the bytes it found on disk, for the sweep to judge", async () => {
    // A purge cut short: the row is gone, the bytes are still on disk and
    // the purge record waits. The restore registers the bytes it found,
    // which clears the record, and is then refused.
    const blob = makeBlobData(
      `left by a purge cut short ${String(Date.now())}`,
    );
    const uploaded = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "text/plain",
      },
      body: blob.data,
    });
    expect(uploaded.status).toBe(201);
    await ctx.storage.runInTransaction(() =>
      ctx.storage.blobs.retainOrphans([blob.hash], "2026-01-01T00:00:00.000Z"),
    );
    const disk = ctx.blobs.disk;
    const remove = disk.delete.bind(disk);
    disk.delete = () => Promise.reject(new Error("store unavailable"));
    try {
      await expect(
        purgeBlob(ctx.storage, ctx.blobs, blob.hash, {
          before: "2026-01-02T00:00:00.000Z",
          runStartedAt: "2026-01-02T00:00:00.000Z",
        }),
      ).rejects.toThrow("store unavailable");
    } finally {
      disk.delete = remove;
    }
    expect(await ctx.storage.blobs.get(blob.hash)).toBeNull();
    expect(await disk.has(blob.hash)).not.toBeNull();
    expect(await ctx.storage.blobs.purgePending(blob.hash)).toBe(true);

    const storage = ctx.storage;
    const runInTransaction = storage.runInTransaction.bind(storage);
    storage.runInTransaction = async <T>(fn: () => T | Promise<T>) => {
      if ((await storage.blobs.get(blob.hash)) !== null) {
        throw new Error("rows refused");
      }
      return runInTransaction(fn);
    };
    let res: Response;
    try {
      res = await postArchive(
        await buildArchive(manifestFor(blob), [noteLine(blob)], [blob]),
      );
    } finally {
      storage.runInTransaction = runInTransaction;
    }
    expect(res.status).toBe(500);
    // The bytes stay named: a row the sweep can report and purge, never
    // bytes with neither a row nor a purge record.
    expect(await disk.has(blob.hash)).not.toBeNull();
    const named = await storage.blobs.get(blob.hash);
    const pending = await storage.blobs.purgePending(blob.hash);
    expect(named !== null || pending).toBe(true);
    expect(named).not.toBeNull();
  });
});

describe("POST /admin/restore-archive — the edges it writes", () => {
  /**
   * A restore is a write like any other from a subscriber's side. A client
   * connected while an archive is restored would otherwise receive the
   * items and none of the graph between them, and nothing later repairs
   * it: the edges already exist server-side, so no re-sync rewrites them.
   */
  it("announces each restored edge", async () => {
    const source = `archive-edges-${Math.random().toString(36).slice(2, 8)}`;
    const sourceId = "019537a0-7b80-7000-8000-0000000000e1";
    const targetId = "019537a0-7b80-7000-8000-0000000000e2";
    const edgeId = "019537a0-7b80-7000-8000-0000000000e3";

    const archive = await buildArchive(
      {
        version: 0,
        format: "marfa-archive-v0",
        created_at: new Date().toISOString(),
        item_count: 2,
        blob_count: 0,
        blobs: {},
      },
      [
        JSON.stringify({
          item: {
            id: sourceId,
            type: "core.note",
            properties: { body: "archived source" },
            source,
            source_id: "ae-1",
          },
        }),
        JSON.stringify({
          item: {
            id: targetId,
            type: "core.note",
            properties: { body: "archived target" },
            source,
            source_id: "ae-2",
          },
        }),
      ],
      [],
      [
        JSON.stringify({
          edge: {
            id: edgeId,
            source_id: sourceId,
            target_id: targetId,
            edge_type: "references",
            properties: {},
          },
        }),
      ],
    );

    const controller = new AbortController();
    const { events, done } = collectEdgeEvents(controller.signal);
    await settle();

    const res = await ctx.app.request(`/admin/restore-archive`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.operatorKey}`,
        "Content-Type": "application/gzip",
      },
      body: new Uint8Array(archive),
    });
    expect(res.status).toBe(200);
    await settle();
    controller.abort();
    await done;

    expect(
      events.filter((e) => e.type === "edge_created" && e.edge.id === edgeId),
    ).toHaveLength(1);
  });

  it("announces nothing when a later edge rolls the restore back", async () => {
    // The restore runs in one transaction. Announcing from inside it sent
    // `edge.created` for edges a later failure then undid — and the
    // `event_log` append rolls back with them, so a replay cannot repair
    // what a live subscriber already received.
    const source = `archive-rollback-${Math.random().toString(36).slice(2, 8)}`;
    const sourceId = "019537a0-7b80-7000-8000-0000000000f1";
    const targetId = "019537a0-7b80-7000-8000-0000000000f2";
    const goodEdgeId = "019537a0-7b80-7000-8000-0000000000f3";

    const archive = await buildArchive(
      {
        version: 0,
        format: "marfa-archive-v0",
        created_at: new Date().toISOString(),
        item_count: 2,
        blob_count: 0,
        blobs: {},
      },
      [
        JSON.stringify({
          item: {
            id: sourceId,
            type: "core.note",
            properties: { body: "rollback source" },
            source,
            source_id: "ar-1",
          },
        }),
        JSON.stringify({
          item: {
            id: targetId,
            type: "core.note",
            properties: { body: "rollback target" },
            source,
            source_id: "ar-2",
          },
        }),
      ],
      [],
      [
        // Lands first.
        JSON.stringify({
          edge: {
            id: goodEdgeId,
            source_id: sourceId,
            target_id: targetId,
            edge_type: "references",
            properties: {},
          },
        }),
        // A second, valid edge. The failure is injected below rather
        // than expressed in the archive, because this import skips every
        // edge-shaped problem it can name — malformed, endpoint missing,
        // already present, constraint violation — and carries on. Only a
        // failure it cannot classify aborts the transaction, and that is
        // an infrastructure error, which is what the stub simulates.
        JSON.stringify({
          edge: {
            id: "019537a0-7b80-7000-8000-0000000000f4",
            source_id: targetId,
            target_id: sourceId,
            edge_type: "references",
            properties: {},
          },
        }),
      ],
    );

    const controller = new AbortController();
    const { events, done } = collectEdgeEvents(controller.signal);
    await settle();

    // The first edge lands, the second fails the way an infrastructure
    // error would. Everything before it is already written.
    const store = ctx.storage.edges;
    const realCreate = store.createRaw.bind(store);
    let creates = 0;
    store.createRaw = async (input) => {
      creates += 1;
      if (creates === 2) throw new Error("simulated storage failure");
      return realCreate(input);
    };
    let res: Response;
    try {
      res = await ctx.app.request(`/admin/restore-archive`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.operatorKey}`,
          "Content-Type": "application/gzip",
        },
        body: new Uint8Array(archive),
      });
    } finally {
      store.createRaw = realCreate;
    }
    // The stub was reached, so the test is about the rollback rather than
    // about an import that never got that far.
    expect(creates).toBe(2);
    await settle();
    controller.abort();
    await done;

    // Either the import refused the batch or it skipped the bad edge; the
    // assertion below holds only in the first case, so the test states
    // which it is rather than passing on either.
    expect(res.status).not.toBe(200);
    expect(
      events.filter(
        (e) => e.type === "edge_created" && e.edge.id === goodEdgeId,
      ),
    ).toHaveLength(0);
    // And the edge really is absent, so this is a rollback rather than a
    // late event.
    expect(await ctx.storage.edges.get(goodEdgeId)).toBeNull();
  });
});

/**
 * The items a restore writes reach the stream and the event log.
 *
 * The edges already did, and that was the worse half of the gap: a durable
 * client received relationships whose endpoints it had never heard of and
 * had no way to resolve. Nothing later repairs it — the restored rows exist
 * server-side, so no re-sync rewrites them, and the log is the only
 * catch-up there is.
 *
 * Asserted on the log as well as on the emitter. The emitter is what a
 * subscriber attached at that moment sees; the log is what a client that
 * was away reads, and a door that emitted without appending would pass an
 * emitter-only test.
 */
describe("POST /admin/restore-archive — the items it writes", () => {
  it("announces each restored item, ahead of the edges between them", async () => {
    const source = `archive-items-${Math.random().toString(36).slice(2, 8)}`;
    const sourceId = "019537a0-7b80-7000-8000-000000000101";
    const targetId = "019537a0-7b80-7000-8000-000000000102";
    const edgeId = "019537a0-7b80-7000-8000-000000000103";

    const archive = await buildArchive(
      {
        version: 0,
        format: "marfa-archive-v0",
        created_at: new Date().toISOString(),
        item_count: 2,
        blob_count: 0,
        blobs: {},
      },
      [
        JSON.stringify({
          item: {
            id: sourceId,
            type: "core.note",
            properties: { body: "announced source" },
            source,
            source_id: "ai-1",
          },
          metadata: { tags: ["restored"], extensions: {} },
        }),
        JSON.stringify({
          item: {
            id: targetId,
            type: "core.note",
            properties: { body: "announced target" },
            source,
            source_id: "ai-2",
          },
        }),
      ],
      [],
      [
        JSON.stringify({
          edge: {
            id: edgeId,
            source_id: sourceId,
            target_id: targetId,
            edge_type: "references",
            properties: {},
          },
        }),
      ],
    );

    const cursor = await logCursor();
    const controller = new AbortController();
    const { events, done } = collectItemEvents(controller.signal);
    await settle();

    const res = await ctx.app.request(`/admin/restore-archive`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.operatorKey}`,
        "Content-Type": "application/gzip",
      },
      body: new Uint8Array(archive),
    });
    expect(res.status).toBe(200);
    // Waits for the frames rather than for a duration. `settle` is a fixed
    // sleep, and a positive assertion resting on one reports a busy machine
    // as a missing event; this fails as a timeout naming the condition it
    // could not reach, on the runner's own budget rather than a number
    // chosen here. The negative case below still sleeps, because absence
    // has nothing to wait for.
    await vi.waitFor(async () => {
      expect(
        events.filter((e) => e.item.id === sourceId || e.item.id === targetId),
      ).toHaveLength(2);
      expect(
        (await logSince(cursor)).some((r) => r.event_type === "edge_created"),
      ).toBe(true);
    });
    controller.abort();
    await done;

    const announced = events.filter(
      (e) => e.item.id === sourceId || e.item.id === targetId,
    );
    expect(announced.map((e) => e.item.id).sort()).toEqual(
      [sourceId, targetId].sort(),
    );
    expect(announced.every((e) => e.type === "created")).toBe(true);
    // The metadata rides along, so a subscriber does not have to read the
    // item back to learn its tags.
    expect(
      announced.find((e) => e.item.id === sourceId)?.metadata?.tags,
    ).toEqual(["restored"]);

    // And a client that was away finds them by replaying the log.
    const rows = await logSince(cursor);
    const itemRows = rows.filter(
      (r) => r.item_id === sourceId || r.item_id === targetId,
    );
    expect(itemRows.map((r) => r.event_type)).toEqual(["created", "created"]);

    // Items before edges. An edge naming an endpoint the client has not
    // yet been told about is the state this whole announcement exists to
    // prevent, so the order is part of the contract rather than incidental.
    const edgeRow = rows.find((r) => r.event_type === "edge_created");
    expect(edgeRow).toBeDefined();
    expect(itemRows.every((r) => r.id < edgeRow!.id)).toBe(true);
  });

  it("announces nothing when a later edge rolls the restore back", async () => {
    const source = `archive-items-rb-${Math.random().toString(36).slice(2, 8)}`;
    const sourceId = "019537a0-7b80-7000-8000-000000000111";
    const targetId = "019537a0-7b80-7000-8000-000000000112";

    const archive = await buildArchive(
      {
        version: 0,
        format: "marfa-archive-v0",
        created_at: new Date().toISOString(),
        item_count: 2,
        blob_count: 0,
        blobs: {},
      },
      [
        JSON.stringify({
          item: {
            id: sourceId,
            type: "core.note",
            properties: { body: "rolled-back source" },
            source,
            source_id: "airb-1",
          },
        }),
        JSON.stringify({
          item: {
            id: targetId,
            type: "core.note",
            properties: { body: "rolled-back target" },
            source,
            source_id: "airb-2",
          },
        }),
      ],
      [],
      [
        JSON.stringify({
          edge: {
            id: "019537a0-7b80-7000-8000-000000000113",
            source_id: sourceId,
            target_id: targetId,
            edge_type: "references",
            properties: {},
          },
        }),
        JSON.stringify({
          edge: {
            id: "019537a0-7b80-7000-8000-000000000114",
            source_id: targetId,
            target_id: sourceId,
            edge_type: "references",
            properties: {},
          },
        }),
      ],
    );

    const cursor = await logCursor();
    const controller = new AbortController();
    const { events, done } = collectItemEvents(controller.signal);
    await settle();

    const store = ctx.storage.edges;
    const realCreate = store.createRaw.bind(store);
    let creates = 0;
    store.createRaw = async (input) => {
      creates += 1;
      if (creates === 2) throw new Error("simulated storage failure");
      return realCreate(input);
    };
    let res: Response;
    try {
      res = await ctx.app.request(`/admin/restore-archive`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.operatorKey}`,
          "Content-Type": "application/gzip",
        },
        body: new Uint8Array(archive),
      });
    } finally {
      store.createRaw = realCreate;
    }
    expect(creates).toBe(2);
    await settle();
    controller.abort();
    await done;

    expect(res.status).not.toBe(200);
    // Collected inside the transaction and announced after it commits, so
    // a rollback takes the rows and their frames together. Announcing from
    // inside would have described items the undo then removed.
    expect(
      events.filter((e) => e.item.id === sourceId || e.item.id === targetId),
    ).toHaveLength(0);
    const rows = await logSince(cursor);
    expect(
      rows.filter((r) => r.item_id === sourceId || r.item_id === targetId),
    ).toHaveLength(0);
    expect(await ctx.storage.items.get(sourceId)).toBeNull();
  });

  /**
   * Every namespace of an item in one write, held by what the write
   * leaves behind rather than by how many times a function was called.
   *
   * The extensions of an item are a single JSON column, so writing them one
   * namespace at a time rewrote that column once per namespace and bumped
   * the item's modification time beside each announcing one. On a restore
   * that multiplied by every item in the archive, on the one path whose
   * whole purpose is moving a lot of rows at once.
   *
   * The bump is the observable half, and the frame is where it shows: the
   * item is captured from `create`, before the extensions are written, so
   * a restore that bumps the row afterwards and announces the captured
   * frame publishes an `updated_at` the row does not have. A client
   * watermarking on the value re-fetches on its next catch-up, and one
   * comparing it against a later read sees a change nothing told it about.
   * Asserted on the log as well as the emitter, because the log is what a
   * client that was away reads.
   */
  it("drops an empty extension namespace rather than restoring it", async () => {
    // A namespace is a path segment everywhere else, so no ordinary write can
    // create an empty one — but a restore copies the keys it is handed. That
    // matters because the empty string is how a credential holding no implicit
    // namespace is represented (`auth/extension-label.ts`), so an item
    // carrying one would be readable by exactly the credentials that hold
    // nothing.
    const source = `archive-empty-ns-${Math.random().toString(36).slice(2, 8)}`;
    const itemId = "019537a0-7b80-7000-8000-0000000001f0";

    const archive = await buildArchive(
      {
        version: 0,
        format: "marfa-archive-v0",
        created_at: new Date().toISOString(),
        item_count: 1,
        blob_count: 0,
        blobs: {},
      },
      [
        JSON.stringify({
          item: {
            id: itemId,
            type: "core.note",
            properties: { body: "forged namespace" },
            source,
            source_id: "empty-ns-1",
          },
          metadata: {
            tags: [],
            extensions: { "": { forged: true }, "app.kept": { ok: true } },
          },
        }),
      ],
      [],
    );

    const res = await ctx.app.request(`/admin/restore-archive`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.operatorKey}`,
        "Content-Type": "application/gzip",
      },
      body: new Uint8Array(archive),
    });
    expect(res.status).toBe(200);

    const stored = await ctx.storage.metadata.getExtensions(itemId);
    expect(Object.keys(stored)).toEqual(["app.kept"]);
  });

  it("announces the modification time its own extensions write left", async () => {
    const source = `archive-ext-${Math.random().toString(36).slice(2, 8)}`;
    const itemId = "019537a0-7b80-7000-8000-000000000121";
    const extensions = {
      "app.one": { a: 1 },
      "app.two": { b: 2 },
      "app.three": { c: 3 },
    };

    const archive = await buildArchive(
      {
        version: 0,
        format: "marfa-archive-v0",
        created_at: new Date().toISOString(),
        item_count: 1,
        blob_count: 0,
        blobs: {},
      },
      [
        JSON.stringify({
          item: {
            id: itemId,
            type: "core.note",
            properties: { body: "three namespaces" },
            source,
            source_id: "ax-1",
          },
          metadata: { tags: [], extensions },
        }),
      ],
      [],
    );

    const cursor = await logCursor();
    const controller = new AbortController();
    const { events, done } = collectItemEvents(controller.signal);
    await settle();

    const res = await ctx.app.request(`/admin/restore-archive`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.operatorKey}`,
        "Content-Type": "application/gzip",
      },
      body: new Uint8Array(archive),
    });
    expect(res.status).toBe(200);
    // A condition rather than a sleep, for the reason given above.
    await vi.waitFor(async () => {
      expect(events.some((e) => e.item.id === itemId)).toBe(true);
      expect((await logSince(cursor)).some((r) => r.item_id === itemId)).toBe(
        true,
      );
    });
    controller.abort();
    await done;

    const stored = await ctx.storage.items.get(itemId);
    expect(stored).not.toBeNull();

    const announced = events.find((e) => e.item.id === itemId);
    expect(announced).toBeDefined();
    expect(announced!.item.updated_at).toBe(stored!.updated_at);

    const rows = await logSince(cursor);
    const row = rows.find((r) => r.item_id === itemId);
    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload) as {
      item: { updated_at: string };
    };
    expect(payload.item.updated_at).toBe(stored!.updated_at);

    // And the same thing is stored either way, which is the half that must
    // not change.
    expect(await ctx.storage.metadata.getExtensions(itemId)).toEqual(
      extensions,
    );
  });
});

describe("POST /admin/restore-archive scalar preflight", () => {
  function fixture() {
    const firstId = generateId();
    const lastId = generateId();
    const edgeId = generateId();
    const typeId = `user.archive_scalar_${Math.random().toString(36).slice(2)}`;
    const blob = makeBlobData(typeId);
    const rows = [firstId, lastId].map((id) => {
      const item: Record<string, unknown> = {
        id,
        type: "core.note",
        properties: { body: "Scalar preflight", blob_ref: blob.hash },
        version: 7,
        tier: "feed",
      };
      return {
        item,
        metadata: {
          tags: ["scalar-preflight"],
          extensions: { "archive.scalar": { marker: typeId } },
        },
        lending_blobs: [blob.hash],
      };
    });
    const edge: Record<string, unknown> = {
      id: edgeId,
      source_id: firstId,
      target_id: lastId,
      edge_type: "references",
      version: 9,
    };
    const archive = () =>
      buildArchive(
        { ...manifestFor(blob), item_count: 2, edge_count: 1, type_count: 1 },
        rows.map((row) => JSON.stringify(row)),
        [blob],
        [JSON.stringify({ edge })],
        [
          JSON.stringify({
            type: {
              id: typeId,
              label: "Archive scalar",
              version: 1,
              fields: {},
            },
          }),
        ],
      );
    return { firstId, lastId, edgeId, typeId, blob, rows, edge, archive };
  }

  const invalidVersions = [
    -1,
    0,
    1.5,
    "4",
    null,
    true,
    Number.MAX_SAFE_INTEGER + 1,
  ];
  const malformed = [
    ...invalidVersions.map((value) => ({ field: "item.version", value })),
    ...invalidVersions.map((value) => ({ field: "edge.version", value })),
    ...["invalid", null, 5].map((value) => ({ field: "item.tier", value })),
  ];

  it.each(malformed)(
    "refuses $field=$value before registrations, blobs, rows, metadata, or events",
    async ({ field, value }) => {
      const f = fixture();
      if (field === "item.tier") f.rows[1]!.item.tier = value;
      else if (field === "item.version") f.rows[1]!.item.version = value;
      else f.edge.version = value;
      const cursor = await logCursor();
      const controller = new AbortController();
      const items = collectItemEvents(controller.signal);
      const edges = collectEdgeEvents(controller.signal);
      let refused: Response;
      try {
        refused = await postArchive(await f.archive());
        await settle();
      } finally {
        controller.abort();
        await Promise.all([items.done, edges.done]);
      }
      expect(refused.status).toBe(400);
      const error = (await refused.json()) as {
        error: {
          code: string;
          message: string;
          details: Record<string, unknown>;
        };
      };
      const id = field.startsWith("edge") ? f.edgeId : f.lastId;
      expect(error.error.code).toBe("validation_error");
      expect(error.error.message).toContain(id);
      expect(error.error.message).toContain(field.split(".")[1]);
      expect(error.error.details).toMatchObject({
        field: field.split(".")[1],
        [field.startsWith("edge") ? "edge_id" : "item_id"]: id,
      });
      for (const rowId of [f.firstId, f.lastId]) {
        expect(await ctx.storage.items.get(rowId)).toBeNull();
        const rows = await (
          ctx.storage as unknown as {
            __sqliteAll(sql: string): Promise<unknown[]>;
          }
        ).__sqliteAll(
          `SELECT item_id FROM metadata WHERE item_id = '${rowId}'`,
        );
        expect(rows).toEqual([]);
      }
      expect(await ctx.storage.edges.get(f.edgeId)).toBeNull();
      expect(
        (await ctx.storage.types.listRegistered()).map((t) => t.id),
      ).not.toContain(f.typeId);
      expect(getTypeSchema(f.typeId)).toBeUndefined();
      expect(await ctx.storage.blobs.get(f.blob.hash)).toBeNull();
      expect(await ctx.blobs.disk.has(f.blob.hash)).toBeNull();
      expect(readdirSync(ctx.blobs.disk.spoolDir)).toEqual([]);
      expect(await logSince(cursor)).toEqual([]);
      expect(items.events).toEqual([]);
      expect(edges.events).toEqual([]);

      f.rows[1]!.item.version = 7;
      f.rows[1]!.item.tier = "feed";
      f.edge.version = 9;
      const accepted = await postArchive(await f.archive());
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({
        imported: 2,
        edges_imported: 1,
        types_registered: 1,
        blobs_imported: 1,
      });
      expect((await ctx.storage.items.get(f.lastId))?.version).toBe(7);
      expect((await ctx.storage.items.get(f.lastId))?.tier).toBe("feed");
      expect((await ctx.storage.edges.get(f.edgeId))?.version).toBe(9);
      expect((await ctx.storage.metadata.get(f.firstId)).tags).toEqual([
        "scalar-preflight",
      ]);
      expect(getTypeSchema(f.typeId)).toBeDefined();
      expect((await ctx.storage.metadata.get(f.firstId)).extensions).toEqual({
        "archive.scalar": { marker: f.typeId },
      });
      expect(await ctx.storage.blobs.get(f.blob.hash)).not.toBeNull();
      expect(await ctx.blobs.disk.has(f.blob.hash)).not.toBeNull();
      expect(await logSince(cursor)).toHaveLength(3);
    },
  );

  it.each(["item.version", "edge.version", "item.tier"])(
    "refuses invalid %s even when the row already exists",
    async (field) => {
      const f = fixture();
      expect((await postArchive(await f.archive())).status).toBe(200);
      const cursor = await logCursor();
      if (field === "item.tier") f.rows[1]!.item.tier = "invalid";
      else if (field === "item.version") f.rows[1]!.item.version = 0;
      else f.edge.version = 0;
      const refused = await postArchive(await f.archive());
      expect(refused.status).toBe(400);
      expect((await errorOf(refused)).code).toBe("validation_error");
      expect((await ctx.storage.items.get(f.lastId))?.version).toBe(7);
      expect((await ctx.storage.items.get(f.lastId))?.tier).toBe("feed");
      expect((await ctx.storage.edges.get(f.edgeId))?.version).toBe(9);
      expect(await logSince(cursor)).toEqual([]);
    },
  );

  it("refuses an invalid edge version even when its endpoint is missing", async () => {
    const f = fixture();
    f.edge.target_id = generateId();
    f.edge.version = 0;
    const refused = await postArchive(await f.archive());
    expect(refused.status).toBe(400);
    expect((await errorOf(refused)).code).toBe("validation_error");
    expect(await ctx.storage.items.get(f.firstId)).toBeNull();
    expect(getTypeSchema(f.typeId)).toBeUndefined();
    expect(await ctx.blobs.disk.has(f.blob.hash)).toBeNull();
    f.edge.version = 9;
    const accepted = await postArchive(await f.archive());
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      imported: 2,
      edges_imported: 0,
      edges_skipped: 1,
      edges_skipped_reasons: { endpoint_missing: 1 },
    });
  });

  it.each([
    { name: "omitted fields", version: undefined, tier: undefined },
    { name: "initial versions", version: 1, tier: "library" },
    { name: "nondefault versions and tier", version: 7, tier: "feed" },
    {
      name: "largest safe integer",
      version: Number.MAX_SAFE_INTEGER,
      tier: "library",
    },
  ])("restores $name", async ({ version, tier }) => {
    const f = fixture();
    for (const row of f.rows) {
      row.item.version = version;
      row.item.tier = tier;
    }
    f.edge.version = version;
    const restored = await postArchive(await f.archive());
    expect(restored.status).toBe(200);
    for (const id of [f.firstId, f.lastId]) {
      const item = await ctx.storage.items.get(id);
      expect(item?.version).toBe(version ?? 1);
      expect(item?.tier).toBe(tier ?? "library");
    }
    expect((await ctx.storage.edges.get(f.edgeId))?.version).toBe(version ?? 1);
  });
});
