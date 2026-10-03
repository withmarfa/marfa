import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import * as tar from "tar-stream";
import { afterAll, describe, expect, it } from "vitest";
import type { Item, Version } from "@withmarfa/shared";
import { itemWrites } from "../storage/item-writes.js";
import {
  closeTestContexts,
  createTestContext,
  mintWorkingKey,
  request,
  type TestContext,
} from "../test-utils.js";

const contexts: TestContext[] = [];
const createdAt = "2020-02-29T12:34:56.789Z";
const updatedAt = "2023-05-06T01:02:03.456Z";
const idAt = (n: number) =>
  `01912345-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

async function context() {
  const ctx = await createTestContext();
  contexts.push(ctx);
  return ctx;
}
afterAll(() => closeTestContexts(contexts));

async function sql(
  ctx: TestContext,
  statement: string,
  params: unknown[] = [],
) {
  const storage = ctx.storage as typeof ctx.storage & {
    __sqliteRun: (statement: string, params: unknown[]) => Promise<unknown>;
  };
  return storage.__sqliteRun(statement, params);
}

async function unpack(bytes: Buffer) {
  const entries = new Map<string, Buffer>();
  const extract = tar.extract();
  const gunzip = createGunzip();
  await new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        entries.set(header.name, Buffer.concat(chunks));
        next();
      });
      stream.on("error", reject);
    });
    extract.on("finish", resolve);
    extract.on("error", reject);
    gunzip.on("error", reject);
    Readable.from(bytes).pipe(gunzip).pipe(extract);
  });
  return entries;
}

async function pack(entries: Map<string, Buffer>) {
  const archive = tar.pack();
  const gzip = createGzip();
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
    gzip.on("end", resolve);
    gzip.on("error", reject);
  });
  archive.pipe(gzip);
  for (const [name, data] of entries) archive.entry({ name }, data);
  archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

async function exported(ctx: TestContext, query = "", key = ctx.workingKey) {
  const response = await request(
    ctx.app,
    "GET",
    `/export?format=archive${query}`,
    { key },
  );
  expect(response.status).toBe(200);
  return Buffer.from(await response.arrayBuffer());
}

function restore(ctx: TestContext, archive: Buffer) {
  return ctx.app.request("/admin/restore-archive", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.operatorKey}`,
      "Content-Type": "application/gzip",
    },
    body: archive,
  });
}

async function note(ctx: TestContext, body = "current") {
  return itemWrites(ctx.storage).create({
    type: "core.note",
    properties: { body },
  });
}

async function seedHistory(ctx: TestContext, item: Item, count: number) {
  await sql(
    ctx,
    `WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v + 1 FROM n WHERE v < ?)
    INSERT INTO versions (id, item_id, version, properties, type, tier, occurred_at, source_id, created_at)
    SELECT printf('01912346-0000-7000-8000-%012x', v), ?, v, json_object('body', 'past ' || v),
      'core.note', 'feed', ?, 'historical-' || v, ? FROM n`,
    [count, item.id, createdAt, updatedAt],
  );
  await sql(ctx, "UPDATE items SET version = ? WHERE id = ?", [
    count + 1,
    item.id,
  ]);
}

describe("complete archive round trips", () => {
  it.each([
    { items: 5001, edges: 0 },
    { items: 143, edges: 20001 },
  ])(
    "restores an actual export with $items items and $edges edges",
    async ({ items, edges }) => {
      const source = await context();
      const target = await context();
      await sql(
        source,
        `WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v + 1 FROM n WHERE v < ?)
      INSERT INTO items (id, type, properties, created_at, updated_at, occurred_at)
      SELECT printf('01912345-0000-7000-8000-%012x', v), 'core.note', jsonb('{"body":"bulk"}'), ?, ?, ? FROM n`,
        [items, createdAt, updatedAt, createdAt],
      );
      if (edges) {
        // Distinct ordered pairs: no duplicate-edge shortcut can hide a cap.
        await sql(
          source,
          `WITH RECURSIVE n(v) AS (VALUES(0) UNION ALL SELECT v + 1 FROM n WHERE v < ?)
        INSERT INTO edges (id, source_id, target_id, edge_type, created_at, updated_at)
        SELECT printf('01912347-0000-7000-8000-%012x', v + 1),
          printf('01912345-0000-7000-8000-%012x', v / 142 + 1),
          printf('01912345-0000-7000-8000-%012x', (v % 142 + v / 142 + 1) % 143 + 1),
          'references', ?, ? FROM n`,
          [edges - 1, createdAt, updatedAt],
        );
      }
      const archive = await exported(source);
      const entries = await unpack(archive);
      expect(
        JSON.parse(entries.get("manifest.json")!.toString()),
      ).toMatchObject({ item_count: items, edge_count: edges });
      const response = await restore(target, archive);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({
        imported: items,
        edges_imported: edges,
        edges_skipped: 0,
      });
      expect(await target.storage.items.get(idAt(items))).not.toBeNull();
      if (edges)
        expect(
          await target.storage.edges.get(
            `01912347-0000-7000-8000-${edges.toString(16).padStart(12, "0")}`,
          ),
        ).not.toBeNull();
    },
  );

  it("preserves item and edge dates after metadata writes, with matching stored event frames", async () => {
    const source = await context();
    const target = await context();
    const a = await note(source);
    const b = await note(source, "target");
    await source.storage.metadata.setExtension(a.id, "roundtrip", {
      retained: true,
    });
    const edge = await source.storage.edges.createRaw({
      source_id: a.id,
      target_id: b.id,
      edge_type: "references",
      version: 7,
    });
    await sql(
      source,
      "UPDATE items SET created_at = ?, updated_at = ?, version = 9 WHERE id = ?",
      [createdAt, updatedAt, a.id],
    );
    await sql(
      source,
      "UPDATE edges SET created_at = ?, updated_at = ? WHERE id = ?",
      [createdAt, updatedAt, edge.id],
    );
    const response = await restore(target, await exported(source));
    expect(response.status, await response.clone().text()).toBe(200);
    const restored = await target.storage.items.get(a.id);
    expect(restored).toEqual(await source.storage.items.get(a.id));
    expect(await target.storage.edges.get(edge.id)).toEqual(
      await source.storage.edges.get(edge.id),
    );
    const events = await target.storage.eventLog.getAfter(0n, 100);
    const event = events.find((entry) => entry.item_id === a.id);
    expect(JSON.parse(event!.payload).item).toEqual(restored);
  });

  it("preserves every snapshot across history pages and leaves duplicate live history untouched", async () => {
    const source = await context();
    const target = await context();
    const item = await note(source);
    await seedHistory(source, item, 205);
    const history = await source.storage.versions.all(item.id);
    expect(history).toHaveLength(205);
    const archive = await exported(source);
    const response = await restore(target, archive);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await target.storage.versions.all(item.id)).toEqual(history);
    await itemWrites(target.storage).update(item.id, {
      properties: { body: "live edit" },
    });
    const liveItem = await target.storage.items.get(item.id);
    const liveHistory = await target.storage.versions.all(item.id);
    const again = await restore(target, archive);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ imported: 0, duplicates: 1 });
    expect(await target.storage.items.get(item.id)).toEqual(liveItem);
    expect(await target.storage.versions.all(item.id)).toEqual(liveHistory);
  });

  it("exports snapshots by their historical type permissions", async () => {
    const source = await context();
    const target = await context();
    const item = await note(source);
    await seedHistory(source, item, 3);
    await sql(
      source,
      "UPDATE versions SET type = 'core.bookmark', properties = ? WHERE item_id = ? AND version = 2",
      [JSON.stringify({ url: "https://example.com/private-history" }), item.id],
    );
    const key = await mintWorkingKey(source, {
      type_permissions: { "core.note": "read" },
    });
    const all = await source.storage.versions.all(item.id);
    expect(all.some((version) => version.type === "core.bookmark")).toBe(true);
    const response = await restore(target, await exported(source, "", key));
    expect(response.status).toBe(200);
    expect(await target.storage.versions.all(item.id)).toEqual(
      all.filter((version) => version.type === "core.note"),
    );
  });

  it("carries readable bytes referenced only by selected history without widening blob access", async () => {
    const source = await context();
    const target = await context();
    const item = await note(source);
    const readableBytes = Buffer.from("historical readable bytes");
    const hiddenBytes = Buffer.from("historical inaccessible bytes");
    const hashes: string[] = [];
    for (const bytes of [readableBytes, hiddenBytes]) {
      const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      hashes.push(hash);
      const uploaded = await source.app.request("/blobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${source.workingKey}`,
          "Content-Type": "text/plain",
        },
        body: bytes,
      });
      expect(uploaded.status).toBe(201);
    }
    const lent = await request(source.app, "POST", "/items", {
      key: source.workingKey,
      body: {
        type: "core.file",
        properties: { blob_ref: hashes[0], mime_type: "text/plain" },
      },
    });
    expect(lent.status).toBe(201);
    await seedHistory(source, item, 1);
    await sql(source, "UPDATE versions SET properties = ? WHERE item_id = ?", [
      JSON.stringify({
        body: "past",
        readable: hashes[0],
        inaccessible: hashes[1],
      }),
      item.id,
    ]);
    const canRead = await request(source.app, "GET", `/blobs/${hashes[0]!}`, {
      key: source.workingKey,
    });
    const cannotRead = await request(
      source.app,
      "GET",
      `/blobs/${hashes[1]!}`,
      {
        key: source.workingKey,
      },
    );
    expect(canRead.status).toBe(200);
    expect(cannotRead.status).toBe(404);
    const archive = await exported(source, "&type=core.note");
    const entries = await unpack(archive);
    expect(entries.get(`blobs/${hashes[0]!}`)).toEqual(readableBytes);
    expect(entries.has(`blobs/${hashes[1]!}`)).toBe(false);
    const response = await restore(target, archive);
    expect(response.status).toBe(200);
    expect(await target.storage.versions.all(item.id)).toEqual(
      await source.storage.versions.all(item.id),
    );
    expect(await target.blobs.disk.get(hashes[0]!)).not.toBeNull();
    expect(await target.blobs.disk.get(hashes[1]!)).toBeNull();
  });

  it.each(["created_at", "updated_at"])(
    "refuses malformed item %s before any row writes",
    async (field) => {
      const source = await context();
      const target = await context();
      await note(source, "first valid row");
      await note(source, "second invalid row");
      const entries = await unpack(await exported(source));
      const rows = entries
        .get("items.ndjson")!
        .toString()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { item: Record<string, unknown> });
      rows[1]!.item[field] = "not-a-date";
      entries.set(
        "items.ndjson",
        Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n"),
      );
      const response = await restore(target, await pack(entries));
      expect(response.status, await response.clone().text()).toBe(400);
      expect((await target.storage.items.list({})).data).toHaveLength(0);
      expect(await target.storage.eventLog.getAfter(0n, 100)).toHaveLength(0);
    },
  );

  it("leaves an existing item and its live history unchanged on repeated restores", async () => {
    const source = await context();
    const item = await note(source);
    await seedHistory(source, item, 2);
    const archive = await exported(source);
    await itemWrites(source.storage).update(item.id, {
      properties: { body: "live state" },
    });
    const live = await source.storage.items.get(item.id);
    const history = await source.storage.versions.all(item.id);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await restore(source, archive);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        imported: 0,
        duplicates: 1,
      });
      expect(await source.storage.items.get(item.id)).toEqual(live);
      expect(await source.storage.versions.all(item.id)).toEqual(history);
    }
  });

  it.each([
    {
      name: "wrong item",
      change: (v: Version) => ({ ...v, item_id: idAt(999) }),
    },
    {
      name: "invalid creation date",
      change: (v: Version) => ({
        ...v,
        created_at: "2020-02-30T00:00:00.000Z",
      }),
    },
    {
      name: "invalid occurrence date",
      change: (v: Version) => ({ ...v, occurred_at: "not-a-date" }),
    },
    { name: "current version", change: (v: Version) => ({ ...v, version: 3 }) },
    {
      name: "fractional version",
      change: (v: Version) => ({ ...v, version: 1.5 }),
    },
    {
      name: "invalid tier",
      change: (v: Version) => ({ ...v, tier: "missing" }),
    },
    {
      name: "nonobject properties",
      change: (v: Version) => ({ ...v, properties: [] }),
    },
  ])(
    "refuses history with $name before writing valid rows ahead of it",
    async ({ change }) => {
      const source = await context();
      const target = await context();
      await note(source, "valid earlier row");
      const item = await note(source, "malformed history");
      await seedHistory(source, item, 2);
      const entries = await unpack(await exported(source));
      const rows = entries
        .get("items.ndjson")!
        .toString()
        .trim()
        .split("\n")
        .map(
          (line) => JSON.parse(line) as { item: Item; versions?: unknown[] },
        );
      const history = await source.storage.versions.all(item.id);
      rows.find((row) => row.item.id === item.id)!.versions = [
        change(history[0]!),
        history[1]!,
      ];
      entries.set(
        "items.ndjson",
        Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n"),
      );
      const response = await restore(target, await pack(entries));
      expect(response.status, await response.clone().text()).toBe(400);
      expect((await target.storage.items.list({})).data).toHaveLength(0);
      expect(await target.storage.versions.all(item.id)).toHaveLength(0);
      expect(await target.storage.eventLog.getAfter(0n, 100)).toHaveLength(0);
    },
  );

  it("rolls back items, metadata, history and events when a later edge insert fails", async () => {
    const source = await context();
    const target = await context();
    const item = await note(source);
    const other = await note(source, "edge target");
    await seedHistory(source, item, 2);
    await source.storage.metadata.setExtension(item.id, "roundtrip", {
      retained: true,
    });
    await source.storage.edges.createRaw({
      source_id: item.id,
      target_id: other.id,
      edge_type: "references",
    });
    await sql(
      target,
      "CREATE TRIGGER refuse_restored_edge BEFORE INSERT ON edges BEGIN SELECT RAISE(ABORT, 'test edge write failure'); END",
    );
    const response = await restore(target, await exported(source));
    expect(response.status).toBe(500);
    expect((await target.storage.items.list({})).data).toHaveLength(0);
    expect((await target.storage.edges.list({})).data).toHaveLength(0);
    expect(await target.storage.versions.all(item.id)).toHaveLength(0);
    expect((await target.storage.metadata.get(item.id)).extensions).toEqual({});
    expect(await target.storage.eventLog.getAfter(0n, 100)).toHaveLength(0);
  });
});
