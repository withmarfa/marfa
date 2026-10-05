import { createHash, randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers";
import { createGunzip } from "node:zlib";
import * as tar from "tar-stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
});
afterEach(async () => {
  vi.restoreAllMocks();
  __resetEventLogForTests();
  await ctx.cleanup();
});

const idAt = (n: number) =>
  `01912345-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2024-01-02T03:04:05.678Z";

async function sql(
  target: TestContext,
  statement: string,
  params: unknown[] = [],
) {
  const storage = target.storage as typeof target.storage & {
    __sqliteRun: (statement: string, params: unknown[]) => Promise<unknown>;
  };
  return storage.__sqliteRun(statement, params);
}

/** `count` notes with ids `idAt(1)` to `idAt(count)`, newest last. */
async function seedNotes(target: TestContext, count: number) {
  await sql(
    target,
    `WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v + 1 FROM n WHERE v < ?)
     INSERT INTO items (id, type, properties, created_at, updated_at, occurred_at)
     SELECT printf('01912345-0000-7000-8000-%012x', v), 'core.note',
       jsonb(json_object('body', 'note ' || v)),
       strftime('%Y-%m-%dT%H:%M:%fZ', '2024-01-01', '+' || v || ' seconds'),
       strftime('%Y-%m-%dT%H:%M:%fZ', '2024-01-01', '+' || v || ' seconds'),
       strftime('%Y-%m-%dT%H:%M:%fZ', '2024-01-01', '+' || v || ' seconds') FROM n`,
    [count],
  );
}

/** Edges from item `v` to item `v + step`, for every `v` that has one. */
async function seedEdges(target: TestContext, count: number, step: number) {
  await sql(
    target,
    `WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v + 1 FROM n WHERE v < ?)
     INSERT INTO edges (id, source_id, target_id, edge_type, created_at, updated_at)
     SELECT printf('01912347-0000-7000-8000-%012x', v),
       printf('01912345-0000-7000-8000-%012x', v),
       printf('01912345-0000-7000-8000-%012x', v + ?),
       'references', ?, ? FROM n`,
    [count - step, step, at, at],
  );
}

function exportArchive(
  target: TestContext,
  query = "",
  signal?: AbortSignal,
): Promise<Response> {
  return Promise.resolve(
    target.app.request(`/export?format=archive${query}`, {
      headers: { Authorization: `Bearer ${target.workingKey}` },
      signal,
    }),
  );
}

async function unpack(bytes: Buffer) {
  const entries: { name: string; data: Buffer }[] = [];
  const extract = tar.extract();
  const gunzip = createGunzip();
  await new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk) => {
        if (!Buffer.isBuffer(chunk)) throw new Error("Expected archive bytes");
        chunks.push(chunk);
      });
      stream.on("end", () => {
        entries.push({ name: header.name, data: Buffer.concat(chunks) });
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

function restore(target: TestContext, archive: Buffer) {
  initEventLog(target.storage.eventLog);
  return target.app.request("/restore", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${target.operatorKey}`,
      "Content-Type": "application/gzip",
    },
    body: archive,
  });
}

const spool = () => readdirSync(ctx.blobs.disk.spoolDir);

/** Waits for the spool to empty, for as long as it keeps changing: a loaded
 *  machine is slow, not stuck, and only a spool that stops changing without
 *  emptying is a failure. */
async function untilSpoolEmpty() {
  let seen = spool().join();
  let still = 0;
  while (seen !== "") {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const now = spool().join();
    still = now === seen ? still + 10 : 0;
    if (still >= 10_000) throw new Error(`the spool stopped at ${now}`);
    seen = now;
  }
}

async function upload(target: TestContext, bytes: Buffer) {
  const res = await target.app.request("/blobs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${target.workingKey}`,
      "Content-Type": "application/octet-stream",
    },
    body: bytes,
  });
  expect(res.status).toBe(201);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** A file row naming `hash`, which is what lends the blob its reach. */
async function attach(target: TestContext, hash: string) {
  const res = await request(target.app, "POST", "/items", {
    key: target.workingKey,
    body: {
      type: "core.file",
      properties: { blob_ref: hash, mime_type: "text/plain" },
    },
  });
  expect(res.status, await res.clone().text()).toBe(201);
}

describe("GET /export?format=archive gives other requests a turn", () => {
  it("between pages of items and between pages of edges", async () => {
    await seedNotes(ctx, 450);
    await seedEdges(ctx, 450, 1);
    for (const store of ["items", "edges"] as const) {
      let pages = 0;
      let observed: Promise<number> | undefined;
      const reads = ctx.storage[store] as unknown as {
        list(filters: unknown): Promise<unknown>;
      };
      const list = reads.list.bind(reads);
      vi.spyOn(reads, "list").mockImplementation(async (filters) => {
        pages++;
        const result = await list(filters);
        observed ??= new Promise((resolve) =>
          setImmediate(() => {
            resolve(pages);
          }),
        );
        return result;
      });
      const res = await exportArchive(ctx);
      expect(res.status).toBe(200);
      await res.arrayBuffer();
      // A turn of the event loop came after the first page and before the
      // last. The item pass takes more pages than the edge pass, and both
      // took more than one.
      expect(pages).toBeGreaterThan(2);
      expect(await observed).toBe(1);
      vi.restoreAllMocks();
    }
  });
});

describe("GET /export?format=archive keeps what it reads in the spool", () => {
  it("writes the manifest first, then the line files, then the blobs, each as long as it said", async () => {
    await seedNotes(ctx, 120);
    await seedEdges(ctx, 120, 7);
    const hash = await upload(ctx, randomBytes(1000));
    await attach(ctx, hash);
    const res = await exportArchive(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    // The tar's own headers carry the sizes the spool counted, so a mismatch
    // would have broken the unpacking.
    const entries = await unpack(Buffer.from(await res.arrayBuffer()));
    expect(entries.map((entry) => entry.name)).toEqual([
      "manifest.json",
      "items.ndjson",
      "edges.ndjson",
      "types.ndjson",
      `blobs/${hash}`,
    ]);
    const manifest = JSON.parse(entries[0]!.data.toString()) as {
      item_count: number;
      edge_count: number;
      blob_count: number;
      blobs: Record<string, { size_bytes: number }>;
    };
    const lines = (name: string) =>
      entries
        .find((entry) => entry.name === name)!
        .data.toString()
        .split("\n")
        .filter(Boolean);
    expect(manifest.item_count).toBe(121);
    expect(lines("items.ndjson")).toHaveLength(121);
    expect(manifest.edge_count).toBe(113);
    expect(lines("edges.ndjson")).toHaveLength(113);
    expect(manifest.blob_count).toBe(1);
    expect(manifest.blobs[hash]?.size_bytes).toBe(1000);
    expect(entries[4]!.data).toHaveLength(1000);
    await untilSpoolEmpty();
  });

  it("holds the spool while it writes and removes it when the body ends", async () => {
    await seedNotes(ctx, 30);
    const res = await exportArchive(ctx);
    // The witness: what the spool holds is there to be removed.
    expect(spool().length).toBeGreaterThan(0);
    await res.arrayBuffer();
    await untilSpoolEmpty();
  });

  it("carries more blobs than a page, each once, in the manifest and the tar", async () => {
    const hashes: string[] = [];
    for (let i = 0; i < 201; i++) {
      hashes.push(await upload(ctx, Buffer.from(`blob number ${String(i)}`)));
    }
    // One row for each, and a second naming the first again, which must not
    // list it twice.
    const bulk = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [...hashes, hashes[0]!].map((hash) => ({
          type: "core.file",
          properties: { blob_ref: hash, mime_type: "text/plain" },
        })),
      },
    });
    expect(bulk.status, await bulk.clone().text()).toBe(200);
    const res = await exportArchive(ctx);
    const entries = await unpack(Buffer.from(await res.arrayBuffer()));
    const manifest = JSON.parse(entries[0]!.data.toString()) as {
      blob_count: number;
      blobs: Record<string, unknown>;
    };
    expect(manifest.blob_count).toBe(201);
    expect(Object.keys(manifest.blobs).sort()).toEqual([...hashes].sort());
    expect(
      entries
        .filter((entry) => entry.name.startsWith("blobs/"))
        .map((entry) => entry.name.slice(6))
        .sort(),
    ).toEqual([...hashes].sort());
  }, 120_000);

  it("restores an archive of nothing", async () => {
    const res = await exportArchive(ctx, "&type=core.bookmark");
    const archive = Buffer.from(await res.arrayBuffer());
    const entries = await unpack(archive);
    expect(entries.find((e) => e.name === "items.ndjson")!.data).toHaveLength(
      0,
    );
    const target = await createTestContext();
    try {
      const restored = await restore(target, archive);
      expect(restored.status, await restored.clone().text()).toBe(200);
      expect(await restored.json()).toMatchObject({ imported: 0 });
    } finally {
      await target.cleanup();
    }
  });
});

describe("GET /export?format=archive ends", () => {
  it("with the spool removed when the client leaves while the tar is being written", async () => {
    await seedNotes(ctx, 5);
    // Random bytes do not compress, so the writer is held by the reader
    // mid-blob however large the buffers are.
    const hash = await upload(ctx, randomBytes(8 * 1024 * 1024));
    await attach(ctx, hash);
    const res = await exportArchive(ctx);
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect(spool().length).toBeGreaterThan(0);
    await reader.cancel();
    await untilSpoolEmpty();
  });

  it("with the spool removed when the client leaves while the selection is read", async () => {
    await seedNotes(ctx, 450);
    const abort = new AbortController();
    const list = ctx.storage.items.list.bind(ctx.storage.items);
    let pages = 0;
    vi.spyOn(ctx.storage.items, "list").mockImplementation(async (filters) => {
      pages++;
      if (pages === 3) abort.abort();
      return list(filters);
    });
    const res = await exportArchive(ctx, "", abort.signal);
    // Nobody is left to read the answer, and nothing more was read for it.
    expect(res.status).toBe(499);
    expect(pages).toBe(3);
    expect(spool()).toEqual([]);
  });

  it("with an error and the spool removed when reading the selection fails", async () => {
    await seedNotes(ctx, 60);
    vi.spyOn(ctx.storage.edges, "list").mockRejectedValue(
      new Error("edge read failed"),
    );
    const res = await exportArchive(ctx);
    expect(res.status).toBe(500);
    expect(spool()).toEqual([]);
  });

  it("cut short, never complete-looking, when a blob cannot be read once the body has begun", async () => {
    await seedNotes(ctx, 5);
    const bytes = randomBytes(4 * 1024 * 1024);
    const hash = await upload(ctx, bytes);
    await attach(ctx, hash);

    // The witness: the same export, undisturbed, is a whole archive.
    const whole = await exportArchive(ctx);
    const entries = await unpack(Buffer.from(await whole.arrayBuffer()));
    expect(entries.at(-1)).toMatchObject({ name: `blobs/${hash}` });
    expect(entries.at(-1)!.data).toHaveLength(bytes.length);

    const get = ctx.blobs.disk.get.bind(ctx.blobs.disk);
    vi.spyOn(ctx.blobs.disk, "get").mockImplementation(async (wanted) => {
      const read = await get(wanted);
      if (!read) return read;
      let sent = 0;
      const broken = new Readable({
        read() {
          if (sent >= 1024 * 1024) {
            this.destroy(new Error("disk read failed"));
            return;
          }
          sent += 64 * 1024;
          this.push(randomBytes(64 * 1024));
        },
      });
      read.stream.destroy();
      return { ...read, stream: broken };
    });
    const res = await exportArchive(ctx);
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
    await untilSpoolEmpty();
  });
});

describe("GET /export?format=archive read across commits", () => {
  it("restores an archive of an instance written to between its pages", async () => {
    await seedNotes(ctx, 300);
    await seedEdges(ctx, 300, 100);
    const list = ctx.storage.items.list.bind(ctx.storage.items);
    let pages = 0;
    vi.spyOn(ctx.storage.items, "list").mockImplementation(async (filters) => {
      const page = await list(filters);
      pages++;
      if (pages === 2) {
        // Pages walk newest first. These land after two pages were read:
        // the first rewrites a row already carried, the second trashes one
        // not yet read (with its edges), the third adds a row and an edge to
        // a row not yet read.
        const patched = await request(ctx.app, "PATCH", `/items/${idAt(300)}`, {
          key: ctx.workingKey,
          body: { version: 1, properties: { body: "rewritten" } },
        });
        expect(patched.status, await patched.clone().text()).toBe(200);
        const trashed = await request(ctx.app, "DELETE", `/items/${idAt(20)}`, {
          key: ctx.workingKey,
        });
        expect(trashed.status).toBe(200);
        const added = await request(ctx.app, "POST", "/items", {
          key: ctx.workingKey,
          body: { type: "core.note", properties: { body: "added" } },
        });
        expect(added.status).toBe(201);
        const addedId = ((await added.json()) as { item: { id: string } }).item
          .id;
        const linked = await request(ctx.app, "POST", "/edges", {
          key: ctx.workingKey,
          body: {
            source_id: addedId,
            target_id: idAt(250),
            edge_type: "references",
          },
        });
        expect(linked.status, await linked.clone().text()).toBe(201);
      }
      return page;
    });
    const res = await exportArchive(ctx);
    expect(res.status, await res.clone().text()).toBe(200);
    const archive = Buffer.from(await res.arrayBuffer());
    expect(pages).toBeGreaterThan(2);

    const entries = await unpack(archive);
    const carried = entries
      .find((e) => e.name === "items.ndjson")!
      .data.toString()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            item: { id: string; properties: { body: string } };
          },
      );
    const itemIds = new Set(carried.map((row) => row.item.id));
    // Rewritten after its page was read, the row is carried as it stood.
    expect(
      carried.find((row) => row.item.id === idAt(300))?.item.properties.body,
    ).toBe("note 300");
    // Written to after the first two pages, the trashed row was read as it
    // stood, and the added row, being newer than every page, was not read.
    expect(itemIds.has(idAt(20))).toBe(false);
    expect(itemIds.size).toBe(299);

    const target = await createTestContext();
    try {
      const restored = await restore(target, archive);
      expect(restored.status, await restored.clone().text()).toBe(200);
      const counts = (await restored.json()) as {
        imported: number;
        edges_imported: number;
        edges_skipped: number;
      };
      expect(counts.imported).toBe(299);
      // Every edge the archive carries joined two rows it carries.
      expect(counts.edges_skipped).toBe(0);
      expect(counts.edges_imported).toBeGreaterThan(150);
    } finally {
      await target.cleanup();
    }
  });

  it("carries an edge created while the items were read, and not one created once its edges were read", async () => {
    await seedNotes(ctx, 300);
    // 299 edges, which are two pages of edges.
    await seedEdges(ctx, 300, 1);
    const link = async (source: number, target: number) => {
      const res = await request(ctx.app, "POST", "/edges", {
        key: ctx.workingKey,
        body: {
          source_id: idAt(source),
          target_id: idAt(target),
          edge_type: "references",
        },
      });
      expect(res.status, await res.clone().text()).toBe(201);
      return ((await res.json()) as { edge: { id: string } }).edge.id;
    };
    const created: Record<string, string> = {};
    const listItems = ctx.storage.items.list.bind(ctx.storage.items);
    let itemPages = 0;
    vi.spyOn(ctx.storage.items, "list").mockImplementation(async (filters) => {
      const page = await listItems(filters);
      itemPages++;
      // Both ends are on the first page, which the export has carried.
      if (itemPages === 2) created.duringItems = await link(300, 299);
      return page;
    });
    const listEdges = ctx.storage.edges.list.bind(ctx.storage.edges);
    let edgePages = 0;
    vi.spyOn(ctx.storage.edges, "list").mockImplementation(async (filters) => {
      const page = await listEdges(filters);
      edgePages++;
      if (edgePages === 1) created.afterFirstEdgePage = await link(300, 298);
      return page;
    });

    const res = await exportArchive(ctx);
    expect(res.status, await res.clone().text()).toBe(200);
    const entries = await unpack(Buffer.from(await res.arrayBuffer()));
    expect(edgePages).toBeGreaterThan(1);
    const edgeIds = new Set(
      entries
        .find((e) => e.name === "edges.ndjson")!
        .data.toString()
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { edge: { id: string } }).edge.id),
    );
    // Both edges joined carried items and both exist, so the second one's
    // absence is the export's doing.
    expect(edgeIds.has(created.duringItems!)).toBe(true);
    expect(edgeIds.has(created.afterFirstEdgePage!)).toBe(false);
    expect(edgeIds.size).toBe(300);
  });
});
