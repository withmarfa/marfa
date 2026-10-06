/**
 * A file's `size_bytes` is the server's, on every door that writes a file.
 *
 * Each case names bytes this file uploads itself, so the size each row
 * should carry is the length the test sent, and each claim of absence has a
 * witness beside it: the same bytes, named by a writer that sent them,
 * carry the size.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerTypeSchema, unregisterTypeSchema } from "@withmarfa/shared";
import { initEventLog } from "../pubsub.js";
import {
  createTestContext,
  mintWorkingKey,
  request,
  runBulkActionAsync,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
let seq = 0;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

interface Row {
  id: string;
  type: string;
  version: number;
  properties: Record<string, unknown>;
}

async function json<T>(res: Response, status: number): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

/** Bytes of this test's own, `extra` long beyond their label. */
function bytesOf(extra: number): Uint8Array {
  seq += 1;
  return new TextEncoder().encode(`file ${String(seq)} ${"x".repeat(extra)}`);
}

function hashOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Sent by `key`, answered by their hash and length. */
async function upload(
  key: string,
  extra = 10,
): Promise<{ hash: string; size: number }> {
  const bytes = bytesOf(extra);
  const res = await ctx.app.request("/blobs", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "image/png" },
    body: bytes,
  });
  const answer = await json<{ hash: string; size_bytes: number }>(res, 201);
  expect(answer.hash).toBe(hashOf(bytes));
  expect(answer.size_bytes).toBe(bytes.length);
  return { hash: answer.hash, size: bytes.length };
}

async function create(
  key: string,
  type: string,
  properties: Record<string, unknown>,
): Promise<Row> {
  const { item } = await json<{ item: Row }>(
    await request(ctx.app, "POST", "/items", {
      key,
      body: { type, properties: { mime_type: "image/png", ...properties } },
    }),
    201,
  );
  return item;
}

async function patch(
  key: string,
  row: Row,
  body: Record<string, unknown>,
  query = "",
): Promise<Row> {
  const { item } = await json<{ item: Row }>(
    await request(ctx.app, "PATCH", `/items/${row.id}${query}`, {
      key,
      body: { version: row.version, ...body },
    }),
    200,
  );
  return item;
}

async function read(id: string): Promise<Row> {
  const { item } = await json<{ item: Row }>(
    await request(ctx.app, "GET", `/items/${id}`, { key: ctx.workingKey }),
    200,
  );
  return item;
}

describe("a file item carries the size of the bytes it names", () => {
  it("is stamped on a create that carries no size, and read back", async () => {
    const blob = await upload(ctx.workingKey, 40);
    const row = await create(ctx.workingKey, "core.file", {
      blob_ref: blob.hash,
    });
    expect(row.properties.size_bytes).toBe(blob.size);
    expect((await read(row.id)).properties.size_bytes).toBe(blob.size);
  });

  it("replaces a size the write got wrong, on a create and an update", async () => {
    const blob = await upload(ctx.workingKey, 7);
    const row = await create(ctx.workingKey, "core.file", {
      blob_ref: blob.hash,
      size_bytes: 999_999,
    });
    expect(row.properties.size_bytes).toBe(blob.size);
    const patched = await patch(ctx.workingKey, row, {
      properties: { size_bytes: -1 },
    });
    expect(patched.properties.size_bytes).toBe(blob.size);
    const cleared = await patch(ctx.workingKey, patched, {
      properties: { size_bytes: null },
    });
    expect(cleared.properties.size_bytes).toBe(blob.size);
    expect((await read(row.id)).properties.size_bytes).toBe(blob.size);
  });

  it("follows the bytes when an update names others", async () => {
    const first = await upload(ctx.workingKey, 3);
    const second = await upload(ctx.workingKey, 300);
    const row = await create(ctx.workingKey, "core.file", {
      blob_ref: first.hash,
    });
    const merged = await patch(ctx.workingKey, row, {
      properties: { blob_ref: second.hash },
    });
    expect(merged.properties.size_bytes).toBe(second.size);
    const replaced = await patch(ctx.workingKey, merged, {
      properties_mode: "replace",
      properties: { blob_ref: first.hash, mime_type: "image/png" },
    });
    expect(replaced.properties.size_bytes).toBe(first.size);
  });

  it("is stamped on a row that predates it by the row's next write", async () => {
    const blob = await upload(ctx.workingKey, 12);
    const row = await create(ctx.workingKey, "core.file", {
      blob_ref: blob.hash,
    });
    const raw = ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    };
    await raw.__sqliteRun(
      "UPDATE items SET properties = jsonb_remove(properties, '$.size_bytes') WHERE id = ?",
      [row.id],
    );
    const old = await read(row.id);
    expect(old.properties.size_bytes).toBeUndefined();
    const renamed = await patch(ctx.workingKey, old, {
      properties: { title: "renamed" },
    });
    expect(renamed.properties.size_bytes).toBe(blob.size);
  });

  it("is answered where the type declares it, ahead of a subtype's own fields", async () => {
    const blob = await upload(ctx.workingKey, 8);
    const row = await create(ctx.workingKey, "core.file.image", {
      width: 3,
      blob_ref: blob.hash,
    });
    const keys = Object.keys(row.properties);
    expect(keys.indexOf("size_bytes")).toBeGreaterThan(-1);
    expect(keys.indexOf("size_bytes")).toBeLessThan(keys.indexOf("width"));
    expect(Object.keys((await read(row.id)).properties)).toEqual(keys);
  });

  it("takes a stale whole edit that leaves the size out, with no collision on it", async () => {
    const first = await upload(ctx.workingKey, 6);
    const second = await upload(ctx.workingKey, 60);
    const row = await create(ctx.workingKey, "core.file", {
      blob_ref: first.hash,
    });
    await patch(ctx.workingKey, row, {
      properties: { blob_ref: second.hash },
    });
    // Based on the first version, naming the bytes as they stood then and
    // a new title: the size it leaves out is not a change it made.
    const stale = await patch(ctx.workingKey, row, {
      properties_mode: "replace",
      properties: {
        blob_ref: first.hash,
        mime_type: "image/png",
        title: "renamed while stale",
      },
    });
    expect(stale.properties.title).toBe("renamed while stale");
    // Naming the bytes it read is no change, so the newer bytes stand.
    expect(stale.properties.blob_ref).toBe(second.hash);
    expect(stale.properties.size_bytes).toBe(second.size);
  });

  it("takes a stale move out of the file family with no collision on the size", async () => {
    const first = await upload(ctx.workingKey, 9);
    const second = await upload(ctx.workingKey, 90);
    const row = await create(ctx.workingKey, "core.file", {
      blob_ref: first.hash,
    });
    await patch(ctx.workingKey, row, {
      properties: { blob_ref: second.hash },
    });
    const moved = await patch(ctx.workingKey, row, {
      type: "core.note",
      retype: true,
      properties_mode: "replace",
      properties: {
        title: "now a note",
        body: "was a file",
        blob_ref: first.hash,
        mime_type: "image/png",
      },
    });
    expect(moved.type).toBe("core.note");
    expect(moved.properties.title).toBe("now a note");
  });

  it("refuses a size of the wrong shape on a stale write, as on a current one", async () => {
    const blob = await upload(ctx.workingKey, 5);
    const row = await create(ctx.workingKey, "core.file", {
      blob_ref: blob.hash,
    });
    const current = await patch(ctx.workingKey, row, {
      properties: { title: "moved on" },
    });
    for (const version of [current.version, row.version]) {
      const res = await request(ctx.app, "PATCH", `/items/${row.id}`, {
        key: ctx.workingKey,
        body: { version, properties: { size_bytes: "abc" } },
      });
      expect(res.status, `at version ${String(version)}`).toBe(400);
    }
  });

  it("is stamped by a bulk action's property patch", async () => {
    const blob = await upload(ctx.workingKey, 44);
    const tag = `size-action-${String(seq)}`;
    const { item: row } = await json<{ item: Row }>(
      await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: {
          type: "core.file",
          tags: [tag],
          properties: { blob_ref: blob.hash, mime_type: "image/png" },
        },
      }),
      201,
    );
    const { initialStatus } = await runBulkActionAsync(
      ctx,
      {
        action: "update_properties",
        patch: { size_bytes: 1, title: "patched in bulk" },
        filter: { tags: [tag] },
      },
      ctx.workingKey,
    );
    expect(initialStatus).toBe(202);
    const after = await read(row.id);
    expect(after.properties.title).toBe("patched in bulk");
    expect(after.properties.size_bytes).toBe(blob.size);
  });

  it("holds for every file type, and a type registered under one", async () => {
    registerTypeSchema({
      id: "acme.scan_size_test",
      version: 0,
      parent: "core.file.image",
      fields: {},
    });
    try {
      for (const type of [
        "core.file.image",
        "core.file.audio",
        "core.file.video",
        "acme.scan_size_test",
      ]) {
        const blob = await upload(ctx.workingKey, type.length);
        const row = await create(ctx.workingKey, type, {
          blob_ref: blob.hash,
        });
        expect(row.properties.size_bytes, type).toBe(blob.size);
      }
    } finally {
      unregisterTypeSchema("acme.scan_size_test");
    }
  });

  it("is stamped on a bulk upsert's create and its update", async () => {
    const first = await upload(ctx.workingKey, 21);
    const second = await upload(ctx.workingKey, 2);
    const sourceId = `bulk-size-${String(seq)}`;
    const bulk = async (hash: string) =>
      json<{ results: { id: string; outcome: string }[] }>(
        await request(ctx.app, "POST", "/items/bulk", {
          key: ctx.workingKey,
          body: {
            items: [
              {
                type: "core.file",
                source_id: sourceId,
                properties: {
                  blob_ref: hash,
                  mime_type: "image/png",
                  size_bytes: 1,
                },
              },
            ],
          },
        }),
        200,
      );
    const created = await bulk(first.hash);
    expect(created.results[0]?.outcome).toBe("created");
    const id = String(created.results[0]?.id);
    expect((await read(id)).properties.size_bytes).toBe(first.size);
    const updated = await bulk(second.hash);
    expect(updated.results[0]?.outcome).toBe("updated");
    expect((await read(id)).properties.size_bytes).toBe(second.size);
  });

  it("is stamped on a retype into a file type", async () => {
    const blob = await upload(ctx.workingKey, 33);
    const { item } = await json<{ item: Row }>(
      await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: {
          type: "core.note",
          properties: {
            title: "to be a file",
            body: "bytes",
            blob_ref: blob.hash,
            mime_type: "image/png",
          },
        },
      }),
      201,
    );
    expect(item.properties.size_bytes).toBeUndefined();
    const moved = await patch(ctx.workingKey, item, {
      type: "core.file",
      retype: true,
    });
    expect(moved.type).toBe("core.file");
    expect(moved.properties.size_bytes).toBe(blob.size);
  });

  it("is stamped on a stale write and on the keep-both copy it makes", async () => {
    registerTypeSchema({
      id: "acme.kept_size_test",
      version: 0,
      parent: "core.file",
      fields: {},
      merge_policy: {
        fields: { blob_ref: "keep_both_copies" },
        default: "last_writer_wins",
      },
    });
    try {
      const base = await upload(ctx.workingKey, 1);
      const theirs = await upload(ctx.workingKey, 50);
      const mine = await upload(ctx.workingKey, 500);
      const row = await create(ctx.workingKey, "acme.kept_size_test", {
        blob_ref: base.hash,
      });
      await patch(ctx.workingKey, row, {
        properties: { blob_ref: theirs.hash, size_bytes: theirs.size },
      });
      const res = await request(
        ctx.app,
        "PATCH",
        `/items/${row.id}?conflict=auto`,
        {
          key: ctx.workingKey,
          body: {
            version: row.version,
            properties: { blob_ref: mine.hash, size_bytes: 7 },
          },
        },
      );
      const answer = await json<{
        item: Row;
        conflict_resolution?: { conflicted_copy_id?: string };
      }>(res, 200);
      const now = await read(row.id);
      expect(now.properties.size_bytes).toBe(
        now.properties.blob_ref === theirs.hash ? theirs.size : mine.size,
      );
      const copyId = answer.conflict_resolution?.conflicted_copy_id;
      expect(copyId).toBeDefined();
      const copy = await read(String(copyId));
      expect(copy.properties.blob_ref).toBe(mine.hash);
      expect(copy.properties.size_bytes).toBe(mine.size);
    } finally {
      unregisterTypeSchema("acme.kept_size_test");
    }
  });
});

describe("an archive restore", () => {
  it("brings a file back with the size of the bytes it carries, and none where they did not lend", async () => {
    const other = await mintWorkingKey(ctx, {
      type_permissions: { "core.file": "write" },
    });
    const blob = await upload(ctx.workingKey, 91);
    // Named before any row lends the bytes, so `other` could not read them.
    const planted = await create(other, "core.file", {
      blob_ref: blob.hash,
    });
    expect(planted.properties.size_bytes).toBeUndefined();
    const lent = await create(ctx.workingKey, "core.file", {
      blob_ref: blob.hash,
    });
    // Each row as an archive from elsewhere might carry it, so the restore
    // has to set both rather than copy them.
    const raw = ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    };
    await raw.__sqliteRun(
      "UPDATE items SET properties = jsonb_set(properties, '$.size_bytes', ?) WHERE id IN (?, ?)",
      [3, lent.id, planted.id],
    );
    const exported = await request(
      ctx.app,
      "GET",
      "/export?format=archive&type=core.file",
      { key: ctx.workingKey },
    );
    expect(exported.status).toBe(200);
    const archive = Buffer.from(await exported.arrayBuffer());
    const target = await createTestContext();
    try {
      initEventLog(target.storage.eventLog);
      const restored = await target.app.request("/restore", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${target.operatorKey}`,
          "Content-Type": "application/gzip",
        },
        body: archive,
      });
      expect(restored.status, await restored.clone().text()).toBe(200);
      const sizeOn = async (id: string) =>
        (
          await json<{ item: Row }>(
            await request(target.app, "GET", `/items/${id}`, {
              key: target.workingKey,
            }),
            200,
          )
        ).item.properties.size_bytes;
      expect(await sizeOn(lent.id)).toBe(blob.size);
      expect(await sizeOn(planted.id)).toBeUndefined();
    } finally {
      initEventLog(ctx.storage.eventLog);
      await target.cleanup();
    }
  });
});

describe("a file item names no size its writer could not read", () => {
  it("carries none where the writer never sent the bytes, which a writer that did is told", async () => {
    const other = await mintWorkingKey(ctx, {
      type_permissions: { "core.file": "write" },
    });
    const blob = await upload(ctx.workingKey, 64);
    const planted = await create(other, "core.file", {
      blob_ref: blob.hash,
      size_bytes: 123,
    });
    expect(planted.properties.size_bytes).toBeUndefined();
    expect((await read(planted.id)).properties.size_bytes).toBeUndefined();
    // The witness: the same bytes, named by the key that sent them.
    const proved = await create(ctx.workingKey, "core.file", {
      blob_ref: blob.hash,
    });
    expect(proved.properties.size_bytes).toBe(blob.size);
  });

  it("carries none for bytes not yet held, and is stamped once written again with them", async () => {
    const bytes = bytesOf(80);
    const early = await create(ctx.workingKey, "core.file", {
      blob_ref: hashOf(bytes),
      size_bytes: bytes.length,
    });
    expect(early.properties.size_bytes).toBeUndefined();
    const res = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "image/png",
      },
      body: bytes,
    });
    expect(res.status).toBe(201);
    // Uploading afterwards changes nothing the reference already settled
    // (`blobs.md` 15): it still lends nothing.
    const later = await patch(ctx.workingKey, early, {
      properties: { title: "after the upload" },
    });
    expect(later.properties.size_bytes).toBeUndefined();
    // The repair: name other bytes, then these again, with the proof.
    const elsewhere = await upload(ctx.workingKey, 4);
    const away = await patch(ctx.workingKey, later, {
      properties: { blob_ref: elsewhere.hash },
    });
    const back = await patch(ctx.workingKey, away, {
      properties: { blob_ref: hashOf(bytes) },
    });
    expect(back.properties.size_bytes).toBe(bytes.length);
  });
});
