import { registryView } from "@withmarfa/shared";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers";
import { createGunzip } from "node:zlib";
import * as tar from "tar-stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetEventLogForTests, initEventLog } from "../pubsub.js";
import type { TestContext } from "../test-utils.js";
import { createTestContext, request } from "../test-utils.js";
import * as clock from "../clock.js";
import { TextSpool } from "./export-spool.js";
import { DiskReserve } from "../storage/disk-space.js";

const withReader = describe.each(["key", "owner"] as const);

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
  reader: "key" | "owner",
  query = "",
  signal?: AbortSignal,
): Promise<Response> {
  return Promise.resolve(
    target.app.request(`/export?format=archive${query}`, {
      headers:
        reader === "owner"
          ? { cookie: target.owner.cookie }
          : { Authorization: `Bearer ${target.workingKey}` },
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
      cookie: target.owner.cookie,
      origin: new URL(target.config.authBaseUrl).origin,
      "Content-Type": "application/gzip",
    },
    body: archive,
  });
}

function afterFirstItemPage(write: () => Promise<void>) {
  const outside = AsyncLocalStorage.snapshot();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded with its original receiver below.
  const append = TextSpool.prototype.append;
  let changed = false;
  vi.spyOn(TextSpool.prototype, "append").mockImplementation(async function (
    this: TextSpool,
    text,
  ) {
    await append.call(this, text);
    if (changed || !text.includes('"item":')) return;
    changed = true;
    await outside(write);
  });
}

async function expectRestorableExport(
  credential: "key" | "owner",
  items: number,
  edges: number,
) {
  const response = await exportArchive(ctx, credential);
  expect(
    response.status,
    response.status === 200 ? undefined : await response.clone().text(),
  ).toBe(200);
  const archive = Buffer.from(await response.arrayBuffer());
  const target = await createTestContext();
  try {
    const restored = await restore(target, archive);
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect(await restored.json()).toMatchObject({
      imported: items,
      duplicates: 0,
      edges_imported: edges,
      edges_skipped: 0,
    });
  } finally {
    await target.cleanup();
  }
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

withReader("archive scheduling (%s)", (credential) => {
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
      const res = await exportArchive(ctx, credential);
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

withReader("archive spool (%s)", (credential) => {
  it("writes the manifest first, then the line files, then the blobs, each as long as it said", async () => {
    await seedNotes(ctx, 120);
    await seedEdges(ctx, 120, 7);
    const hash = await upload(ctx, randomBytes(1000));
    await attach(ctx, hash);
    const res = await exportArchive(ctx, credential);
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
    const res = await exportArchive(ctx, credential);
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
    const parse = vi.spyOn(JSON, "parse");
    const res = await exportArchive(ctx, credential);
    const bytes = Buffer.from(await res.arrayBuffer());
    // The manifest is checked a page of entries at a time, never whole.
    const named = parse.mock.calls.map(
      ([text]) => text.split('"sha256:').length - 1,
    );
    parse.mockRestore();
    expect(named.reduce((most, one) => Math.max(most, one), 0)).toBe(200);
    const entries = await unpack(bytes);
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
    const res = await exportArchive(ctx, credential, "&type=core.bookmark");
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

/** Collects what the server logs and reports as a fault while `run` goes. */
async function watchingFaults<T>(
  run: () => Promise<T>,
): Promise<{ result: T; logged: string; reported: unknown[] }> {
  const lines: string[] = [];
  const reported: unknown[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  globalThis.__marfaReportException = (err) => {
    reported.push(err);
  };
  try {
    const result = await run();
    return { result, logged: lines.join(""), reported };
  } finally {
    globalThis.__marfaReportException = undefined;
  }
}

withReader("archive fault reporting (%s)", (credential) => {
  it("logs and reports nothing when the client leaves while the tar is being written", async () => {
    await seedNotes(ctx, 5);
    const hash = await upload(ctx, randomBytes(8 * 1024 * 1024));
    await attach(ctx, hash);

    const { logged, reported } = await watchingFaults(async () => {
      const res = await exportArchive(ctx, credential);
      const reader = res.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      await reader.cancel();
      await untilSpoolEmpty();
    });

    expect(logged).not.toContain("Archive export failed");
    expect(reported).toEqual([]);
  });

  it("logs and reports the failure when a blob cannot be read once the body has begun", async () => {
    await seedNotes(ctx, 5);
    const hash = await upload(ctx, randomBytes(4 * 1024 * 1024));
    await attach(ctx, hash);
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

    const { logged, reported } = await watchingFaults(async () => {
      const res = await exportArchive(ctx, credential);
      await expect(res.arrayBuffer()).rejects.toThrow();
      await untilSpoolEmpty();
    });

    expect(logged).toContain("Archive export failed");
    expect(logged).toContain("disk read failed");
    expect(reported).toHaveLength(1);
  });
});

withReader("archive cleanup (%s)", (credential) => {
  it("with the spool removed when the client leaves while the tar is being written", async () => {
    await seedNotes(ctx, 5);
    // Random bytes do not compress, so the writer is held by the reader
    // mid-blob however large the buffers are.
    const hash = await upload(ctx, randomBytes(8 * 1024 * 1024));
    await attach(ctx, hash);
    const res = await exportArchive(ctx, credential);
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
    const res = await exportArchive(ctx, credential, "", abort.signal);
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
    const res = await exportArchive(ctx, credential);
    expect(res.status).toBe(500);
    expect(spool()).toEqual([]);
  });

  it("cut short, never complete-looking, when a blob cannot be read once the body has begun", async () => {
    await seedNotes(ctx, 5);
    const bytes = randomBytes(4 * 1024 * 1024);
    const hash = await upload(ctx, bytes);
    await attach(ctx, hash);

    // The witness: the same export, undisturbed, is a whole archive.
    const whole = await exportArchive(ctx, credential);
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
    const res = await exportArchive(ctx, credential);
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
    await untilSpoolEmpty();
  });
});

withReader("archive concurrent writes (%s)", (credential) => {
  it("reads each item with its metadata, history and lending references", async () => {
    await seedNotes(ctx, 59);
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: "note 1" },
        occurred_at: "2023-01-01T00:00:00.000Z",
      },
    });
    expect(created.status).toBe(201);
    const {
      item: { id },
    } = (await created.json()) as { item: { id: string } };
    await sql(ctx, "UPDATE items SET created_at = ? WHERE id = ?", [
      "2023-01-01T00:00:00.000Z",
      id,
    ]);
    const original = await upload(ctx, Buffer.from("original bytes"));
    const later = await upload(ctx, Buffer.from("later bytes"));
    const patch = (version: number, hash: string) =>
      request(ctx.app, "PATCH", `/items/${id}`, {
        key: ctx.workingKey,
        body: { version, properties: { body: `![bytes](${hash})` } },
      });
    expect((await patch(1, original)).status).toBe(200);
    await ctx.storage.metadata.addTags(id, ["before"]);
    const outside = AsyncLocalStorage.snapshot();
    const list = ctx.storage.items.list.bind(ctx.storage.items);
    let pages = 0;
    vi.spyOn(ctx.storage.items, "list").mockImplementation(async (filters) => {
      const page = await list(filters);
      if (++pages === 3)
        await outside(async () => {
          expect(page.data.map((item) => item.id)).toContain(id);
          expect((await patch(2, later)).status).toBe(200);
          await ctx.storage.metadata.removeTag(id, "before");
          await ctx.storage.metadata.addTags(id, ["after"]);
        });
      return page;
    });
    const response = await exportArchive(ctx, credential);
    expect(response.status).toBe(200);
    const entries = await unpack(Buffer.from(await response.arrayBuffer()));
    const rows = entries
      .find((entry) => entry.name === "items.ndjson")!
      .data.toString()
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            item: { id: string; version: number; properties: { body: string } };
            metadata: { tags: string[] };
            versions: { version: number; properties: { body: string } }[];
            lending_blobs: string[];
          },
      );
    const carried = rows.find((row) => row.item.id === id)!;
    expect(carried.item).toMatchObject({
      version: 2,
      properties: { body: `![bytes](${original})` },
    });
    expect(carried.metadata.tags).toEqual(["before"]);
    expect(carried.versions).toHaveLength(1);
    expect(carried.versions[0]).toMatchObject({
      version: 1,
      properties: { body: "note 1" },
    });
    expect(carried.lending_blobs).toContain(original);
    expect(carried.lending_blobs).not.toContain(later);
    const manifest = JSON.parse(entries[0]!.data.toString()) as {
      blobs: Record<string, unknown>;
    };
    expect(Object.keys(manifest.blobs)).toEqual([original]);
    expect(
      entries.find((entry) => entry.name === `blobs/${original}`)?.data,
    ).toEqual(Buffer.from("original bytes"));
  });

  it("checkpoints while a page append stalls and permits exports longer than 30 seconds", async () => {
    await seedNotes(ctx, 60);
    const outside = AsyncLocalStorage.snapshot();
    const raw = ctx.storage as typeof ctx.storage & {
      __sqliteAll(
        query: string,
      ): Promise<{ log: number; checkpointed: number }[]>;
    };
    const checkpoint = () => raw.__sqliteAll("PRAGMA wal_checkpoint(PASSIVE)");
    const now = clock.monotonicMs;
    let elapsed = 0;
    vi.spyOn(clock, "monotonicMs").mockImplementation(() => now() + elapsed);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded with its original receiver below.
    const append = TextSpool.prototype.append;
    let stalled = false;
    vi.spyOn(TextSpool.prototype, "append").mockImplementation(async function (
      this: TextSpool,
      text,
    ) {
      if (!stalled && text.includes('"item":')) {
        stalled = true;
        await outside(async () => {
          for (let i = 0; i < 256; i++) {
            await ctx.storage.settings.set(
              "export.wal",
              String.fromCharCode(65 + (i % 26)).repeat(64 * 1024),
            );
          }
          const [released] = await checkpoint();
          expect(released!.checkpointed).toBe(released!.log);
          elapsed = 35_000;
        });
      }
      await append.call(this, text);
    });
    const response = await exportArchive(ctx, credential);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(stalled).toBe(true);
    const target = await createTestContext();
    try {
      const restored = await restore(
        target,
        Buffer.from(await response.arrayBuffer()),
      );
      expect(restored.status, await restored.clone().text()).toBe(200);
      expect(await restored.json()).toMatchObject({ imported: 60 });
    } finally {
      await target.cleanup();
    }
    await untilSpoolEmpty();
  });

  it("restores a single item's history when its page read takes over 30 seconds", async () => {
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "before" } },
    });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as { item: { id: string } };
    expect(
      (
        await request(ctx.app, "PATCH", `/items/${item.id}`, {
          key: ctx.workingKey,
          body: { version: 1, properties: { body: "after" } },
        })
      ).status,
    ).toBe(200);
    const now = clock.monotonicMs;
    let elapsed = 0;
    vi.spyOn(clock, "monotonicMs").mockImplementation(() => now() + elapsed);
    const list = ctx.storage.versions.list.bind(ctx.storage.versions);
    vi.spyOn(ctx.storage.versions, "list").mockImplementationOnce(
      async (...args) => {
        const page = await list(...args);
        elapsed = 35_000;
        return page;
      },
    );
    const exported = await exportArchive(ctx, credential);
    expect(exported.status, await exported.clone().text()).toBe(200);
    const target = await createTestContext();
    try {
      const restored = await restore(
        target,
        Buffer.from(await exported.arrayBuffer()),
      );
      expect(restored.status, await restored.clone().text()).toBe(200);
      expect(await target.storage.versions.all(item.id)).toMatchObject([
        { version: 1, properties: { body: "before" } },
      ]);
    } finally {
      await target.cleanup();
    }
  });

  it("carries a type registered after the first page with an item on a later page", async () => {
    await seedNotes(ctx, 60);
    const outside = AsyncLocalStorage.snapshot();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded with its original receiver below.
    const append = TextSpool.prototype.append;
    let changed = false;
    vi.spyOn(TextSpool.prototype, "append").mockImplementation(async function (
      this: TextSpool,
      text,
    ) {
      await append.call(this, text);
      if (changed || !text.includes('"item":')) return;
      changed = true;
      await outside(async () => {
        for (const [id, parent] of [
          ["snapshot.root", undefined],
          ["snapshot.parent", "snapshot.root"],
          ["snapshot.later", "snapshot.parent"],
        ] as const) {
          const registered = await request(ctx.app, "POST", "/types", {
            key: ctx.workingKey,
            body: {
              id,
              parent,
              version: 1,
              fields: {},
              ...(id === "snapshot.later" && {
                compatible_with: ["snapshot.root"],
              }),
            },
          });
          expect(registered.status, await registered.clone().text()).toBe(201);
        }
        const retyped = await request(ctx.app, "PATCH", `/items/${idAt(1)}`, {
          key: ctx.workingKey,
          body: {
            version: 1,
            retype: true,
            type: "snapshot.later",
            properties: {},
          },
        });
        expect(retyped.status, await retyped.clone().text()).toBe(200);
      });
    });
    const response = await exportArchive(ctx, credential);
    expect(response.status).toBe(200);
    const archive = Buffer.from(await response.arrayBuffer());
    const entries = await unpack(archive);
    expect(
      entries.find((entry) => entry.name === "items.ndjson")!.data.toString(),
    ).toContain('"type":"snapshot.later"');
    const target = await createTestContext();
    try {
      const restored = await restore(target, archive);
      expect(restored.status, await restored.clone().text()).toBe(200);
      expect(await restored.json()).toMatchObject({
        imported: 60,
        types_registered: 3,
      });
    } finally {
      await target.cleanup();
    }
  });

  it("keeps one registration when optional fields are added between pages", async () => {
    await seedNotes(ctx, 60);
    const registered = await request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: {
        id: "snapshot.evolving",
        version: 1,
        fields: { body: { type: "string" } },
      },
    });
    expect(registered.status).toBe(201);
    for (const n of [1, 60]) {
      expect(
        (
          await request(ctx.app, "PATCH", `/items/${idAt(n)}`, {
            key: ctx.workingKey,
            body: {
              version: 1,
              retype: true,
              type: "snapshot.evolving",
              properties: { body: `note ${String(n)}` },
            },
          })
        ).status,
      ).toBe(200);
    }
    const outside = AsyncLocalStorage.snapshot();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded with its original receiver below.
    const append = TextSpool.prototype.append;
    let changed = false;
    vi.spyOn(TextSpool.prototype, "append").mockImplementation(async function (
      this: TextSpool,
      text,
    ) {
      await append.call(this, text);
      if (changed || !text.includes('"item":')) return;
      changed = true;
      await outside(async () => {
        const updated = await request(
          ctx.app,
          "PUT",
          "/types/snapshot.evolving",
          {
            key: ctx.workingKey,
            body: {
              version: 2,
              fields: { body: { type: "string" }, extra: { type: "string" } },
            },
          },
        );
        expect(updated.status, await updated.clone().text()).toBe(200);
        expect(
          (
            await request(ctx.app, "PATCH", `/items/${idAt(1)}`, {
              key: ctx.workingKey,
              body: { version: 2, properties: { extra: "later field" } },
            })
          ).status,
        ).toBe(200);
      });
    });
    const response = await exportArchive(ctx, credential);
    expect(response.status).toBe(200);
    const archive = Buffer.from(await response.arrayBuffer());
    const entries = await unpack(archive);
    const registrations = entries
      .find((entry) => entry.name === "types.ndjson")!
      .data.toString()
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { type?: { id: string; version: number } },
      );
    expect(
      registrations.filter((row) => row.type?.id === "snapshot.evolving"),
    ).toEqual([
      expect.objectContaining({
        type: expect.objectContaining({ version: 2 }),
      }),
    ]);
    const target = await createTestContext();
    try {
      const restored = await restore(target, archive);
      expect(restored.status, await restored.clone().text()).toBe(200);
      const item = await target.storage.items.get(idAt(1));
      expect(item?.properties).toMatchObject({ extra: "later field" });
    } finally {
      await target.cleanup();
    }
  });

  it("refuses incompatible row schemas before sending archive bytes", async () => {
    await seedNotes(ctx, 60);
    const registered = await request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: {
        id: "snapshot.changed",
        version: 1,
        fields: { value: { type: "string", required: true } },
      },
    });
    expect(registered.status).toBe(201);
    for (const n of [1, 60]) {
      expect(
        (
          await request(ctx.app, "PATCH", `/items/${idAt(n)}`, {
            key: ctx.workingKey,
            body: {
              version: 1,
              retype: true,
              type: "snapshot.changed",
              properties: { value: "original" },
            },
          })
        ).status,
      ).toBe(200);
    }
    const witness = await exportArchive(ctx, credential);
    expect(witness.status).toBe(200);
    await witness.arrayBuffer();
    const outside = AsyncLocalStorage.snapshot();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded with its original receiver below.
    const append = TextSpool.prototype.append;
    let changed = false;
    vi.spyOn(TextSpool.prototype, "append").mockImplementation(async function (
      this: TextSpool,
      text,
    ) {
      await append.call(this, text);
      if (changed || !text.includes('"item":')) return;
      changed = true;
      await outside(async () => {
        const updated = await request(
          ctx.app,
          "PUT",
          "/types/snapshot.changed",
          {
            key: ctx.workingKey,
            body: {
              version: 2,
              fields: { value: { type: "number", required: true } },
            },
          },
        );
        expect(updated.status, await updated.clone().text()).toBe(200);
        expect(
          (
            await request(ctx.app, "PATCH", `/items/${idAt(1)}`, {
              key: ctx.workingKey,
              body: { version: 2, properties: { value: 42 } },
            })
          ).status,
        ).toBe(200);
      });
    });
    // The write lands before the last page is read, so both selections
    // read the same rows, and the row the replacement left invalid is the
    // instance's own.
    const { result, logged } = await watchingFaults(() =>
      exportArchive(ctx, credential),
    );
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({
      error: {
        code: "export_rows_unrestorable",
        details: {
          row: {
            kind: "item",
            id: idAt(60),
            type: "snapshot.changed",
            field: "properties.value",
            code: "invalid_properties",
          },
        },
      },
    });
    expect(
      logged.split("Archive export selection would not restore"),
    ).toHaveLength(3);
    await untilSpoolEmpty();
  });

  it("names a lasting bad row even while writes land on other rows", async () => {
    await seedNotes(ctx, 60);
    expect(
      (
        await request(ctx.app, "POST", "/types", {
          key: ctx.workingKey,
          body: {
            id: "snapshot.moving",
            version: 1,
            fields: { value: { type: "number", required: true } },
          },
        })
      ).status,
    ).toBe(201);
    await sql(
      ctx,
      "UPDATE items SET type = 'snapshot.moving', properties = jsonb(?) WHERE id = ?",
      [JSON.stringify({ value: "not a number" }), idAt(60)],
    );
    const outside = AsyncLocalStorage.snapshot();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded with its original receiver below.
    const append = TextSpool.prototype.append;
    let writes = 0;
    vi.spyOn(TextSpool.prototype, "append").mockImplementation(async function (
      this: TextSpool,
      text,
    ) {
      await append.call(this, text);
      if (!text.includes('"item":') || !text.includes(idAt(60))) return;
      writes++;
      await outside(async () => {
        const edited = await request(ctx.app, "PATCH", `/items/${idAt(1)}`, {
          key: ctx.workingKey,
          body: {
            version: writes,
            properties: { body: `edit ${String(writes)}` },
          },
        });
        expect(edited.status, await edited.clone().text()).toBe(200);
      });
    });
    const { result, logged } = await watchingFaults(() =>
      exportArchive(ctx, credential),
    );
    expect(writes).toBe(2);
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({
      error: {
        code: "export_rows_unrestorable",
        details: {
          row: {
            kind: "item",
            id: idAt(60),
            type: "snapshot.moving",
            field: "properties.value",
            code: "invalid_properties",
          },
        },
      },
    });
    expect(
      logged.split("Archive export selection would not restore"),
    ).toHaveLength(3);
    await untilSpoolEmpty();
  });

  it("answers 503 to retry when the refused row itself changes between the reads", async () => {
    await seedNotes(ctx, 60);
    expect(
      (
        await request(ctx.app, "POST", "/types", {
          key: ctx.workingKey,
          body: {
            id: "snapshot.moving",
            version: 1,
            fields: { value: { type: "number", required: true } },
          },
        })
      ).status,
    ).toBe(201);
    await sql(
      ctx,
      "UPDATE items SET type = 'snapshot.moving', properties = jsonb(?) WHERE id = ?",
      [JSON.stringify({ value: "not a number" }), idAt(60)],
    );
    const outside = AsyncLocalStorage.snapshot();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded with its original receiver below.
    const append = TextSpool.prototype.append;
    let writes = 0;
    vi.spyOn(TextSpool.prototype, "append").mockImplementation(async function (
      this: TextSpool,
      text,
    ) {
      await append.call(this, text);
      if (!text.includes('"item":') || !text.includes(idAt(60))) return;
      writes++;
      await outside(async () => {
        await sql(ctx, "UPDATE items SET properties = jsonb(?) WHERE id = ?", [
          JSON.stringify({ value: `still not a number ${String(writes)}` }),
          idAt(60),
        ]);
      });
    });
    const { result, logged } = await watchingFaults(() =>
      exportArchive(ctx, credential),
    );
    expect(writes).toBe(2);
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({
      error: { code: "export_unrestorable" },
    });
    expect(
      logged.split("Archive export selection would not restore"),
    ).toHaveLength(3);
    await untilSpoolEmpty();
  });

  it("judges row sizes by this instance's cap, which its restore applies", async () => {
    const capped = await createTestContext({ maxBulkRequestBytes: 4096 });
    try {
      await seedNotes(capped, 1);
      await sql(capped, "UPDATE items SET properties = jsonb(?) WHERE id = ?", [
        JSON.stringify({ body: "x".repeat(8192) }),
        idAt(1),
      ]);
      const response = await exportArchive(capped, credential);
      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.json()).toMatchObject({
        error: {
          code: "export_rows_unrestorable",
          details: {
            row: {
              kind: "item",
              id: idAt(1),
              type: "core.note",
              field: "properties",
              code: "request_too_large",
            },
          },
        },
      });
    } finally {
      await capped.cleanup();
    }
  });

  it("logs a fault in the check with the selection it was checking, and answers 500", async () => {
    await seedNotes(ctx, 3);
    vi.spyOn(DiskReserve.prototype, "look").mockRejectedValueOnce(
      new Error("probe exploded"),
    );
    const { result, logged } = await watchingFaults(() =>
      exportArchive(ctx, credential),
    );
    expect(result.status).toBe(500);
    expect(logged).toContain(
      "Archive export failed while reading or checking selection 1 of 2",
    );
    expect(logged).toContain("probe exploded");
    await untilSpoolEmpty();
  });

  it("restores edges allowed by a compatible widening between pages", async () => {
    await seedNotes(ctx, 60);
    const definition = {
      id: "snapshot.widened",
      label: "Widened",
      cardinality: "many-to-many",
      source_type_constraints: ["core.note"],
      target_type_constraints: ["core.note"],
    };
    expect(
      (
        await request(ctx.app, "POST", "/edge-types", {
          key: ctx.workingKey,
          body: definition,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(ctx.app, "PATCH", `/items/${idAt(1)}`, {
          key: ctx.workingKey,
          body: {
            version: 1,
            retype: true,
            type: "core.bookmark",
            properties: { url: "https://example.com" },
          },
        })
      ).status,
    ).toBe(200);
    afterFirstItemPage(async () => {
      const widened = await request(ctx.app, "POST", "/edge-types", {
        key: ctx.workingKey,
        body: {
          ...definition,
          evolve_constraints: true,
          source_type_constraints: ["core.note", "core.bookmark"],
        },
      });
      expect(widened.status, await widened.clone().text()).toBe(200);
      expect(
        (
          await request(ctx.app, "POST", "/edges", {
            key: ctx.workingKey,
            body: {
              source_id: idAt(1),
              target_id: idAt(60),
              edge_type: definition.id,
            },
          })
        ).status,
      ).toBe(201);
    });
    await expectRestorableExport(credential, 60, 1);
  });

  it("restores a child registered after its parent's chain was shortened", async () => {
    await seedNotes(ctx, 60);
    const typeAt = (n: number) => `snapshot.chain${String(n)}`;
    for (let n = 0; n <= 10; n++) {
      const registered = await request(ctx.app, "POST", "/types", {
        key: ctx.workingKey,
        body: {
          id: typeAt(n),
          version: 1,
          fields: {},
          ...(n > 0 && { parent: typeAt(n - 1) }),
        },
      });
      expect(registered.status, await registered.clone().text()).toBe(201);
    }
    afterFirstItemPage(async () => {
      expect(
        (
          await request(ctx.app, "PUT", `/types/${typeAt(10)}`, {
            key: ctx.workingKey,
            body: { version: 2, fields: {}, parent: typeAt(0) },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(ctx.app, "POST", "/types", {
            key: ctx.workingKey,
            body: {
              id: typeAt(11),
              version: 1,
              fields: {},
              parent: typeAt(10),
            },
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await request(ctx.app, "PATCH", `/items/${idAt(1)}`, {
            key: ctx.workingKey,
            body: {
              version: 1,
              retype: true,
              type: typeAt(11),
              properties: {},
            },
          })
        ).status,
      ).toBe(200);
    });
    await expectRestorableExport(credential, 60, 0);
  });

  it("restarts the whole selection once when mixed row schemas cannot restore", async () => {
    await seedNotes(ctx, 60);
    expect(
      (
        await request(ctx.app, "POST", "/types", {
          key: ctx.workingKey,
          body: {
            id: "snapshot.retry",
            version: 1,
            fields: { value: { type: "string", required: true } },
          },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(ctx.app, "PATCH", `/items/${idAt(60)}`, {
          key: ctx.workingKey,
          body: {
            version: 1,
            retype: true,
            type: "snapshot.retry",
            properties: { value: "before" },
          },
        })
      ).status,
    ).toBe(200);
    const list = vi.spyOn(ctx.storage.items, "list");
    afterFirstItemPage(async () => {
      expect(
        (
          await request(ctx.app, "PUT", "/types/snapshot.retry", {
            key: ctx.workingKey,
            body: {
              version: 2,
              fields: { value: { type: "number", required: true } },
            },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(ctx.app, "PATCH", `/items/${idAt(60)}`, {
            key: ctx.workingKey,
            body: { version: 2, properties: { value: 42 } },
          })
        ).status,
      ).toBe(200);
    });
    await expectRestorableExport(credential, 60, 0);
    expect(list.mock.calls.filter(([filter]) => !filter.cursor)).toHaveLength(
      2,
    );
  });

  it("keeps validation registrations, rows, blobs and events out of the source", async () => {
    expect(
      (
        await request(ctx.app, "POST", "/types", {
          key: ctx.workingKey,
          body: { id: "snapshot.isolated", version: 1, fields: {} },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(ctx.app, "POST", "/items", {
          key: ctx.workingKey,
          body: { type: "snapshot.isolated", properties: {} },
        })
      ).status,
    ).toBe(201);
    const hash = await upload(
      ctx,
      Buffer.from("validation leaves the bytes alone"),
    );
    await attach(ctx, hash);
    const vocabulary = registryView();
    const before = {
      items: await ctx.storage.items.list({ limit: 100 }),
      events: await ctx.storage.eventLog.getAfter(0n, 100),
      audit: (await ctx.storage.audit.list({ limit: 100 })).data.filter(
        (entry) => entry.action !== "export.run",
      ),
      blobs: await ctx.storage.blobs.count(),
      locations: await ctx.storage.blobs.listLocations(hash),
    };
    expect(before.events.length).toBeGreaterThan(0);
    expect(before.items.data.length).toBeGreaterThan(0);
    const answer = await exportArchive(ctx, credential);
    expect(
      answer.status,
      answer.status === 200 ? undefined : await answer.clone().text(),
    ).toBe(200);
    await answer.arrayBuffer();
    await untilSpoolEmpty();
    expect(registryView()).toBe(vocabulary);
    expect({
      items: await ctx.storage.items.list({ limit: 100 }),
      events: await ctx.storage.eventLog.getAfter(0n, 100),
      audit: (await ctx.storage.audit.list({ limit: 100 })).data.filter(
        (entry) => entry.action !== "export.run",
      ),
      blobs: await ctx.storage.blobs.count(),
      locations: await ctx.storage.blobs.listLocations(hash),
    }).toEqual(before);
  });

  it.each(["schema", "natural key"])(
    "refuses both invalid %s selections before headers and removes every spool",
    async (kind) => {
      await seedNotes(ctx, 60);
      const witness = await exportArchive(ctx, credential);
      expect(witness.status).toBe(200);
      await witness.arrayBuffer();
      await untilSpoolEmpty();
      const list = vi.spyOn(ctx.storage.items, "list");
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded with its original receiver below.
      const append = TextSpool.prototype.append;
      let poisoned = 0;
      vi.spyOn(TextSpool.prototype, "append").mockImplementation(
        async function (this: TextSpool, text) {
          if (text.includes('"item":')) {
            poisoned++;
            if (kind === "schema")
              text = text.replace(
                '"type":"core.note"',
                '"type":"snapshot.missing"',
              );
            else
              text =
                text
                  .trimEnd()
                  .split("\n")
                  .map((line) => {
                    const row = JSON.parse(line) as {
                      item: { source: string; source_id: string };
                    };
                    row.item.source = "snapshot";
                    row.item.source_id = "duplicate";
                    return JSON.stringify(row);
                  })
                  .join("\n") + "\n";
          }
          await append.call(this, text);
        },
      );
      const response = await exportArchive(ctx, credential);
      expect(response.status).toBe(409);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(await response.json()).toMatchObject({
        error: {
          code: "export_rows_unrestorable",
          details: {
            row:
              kind === "schema"
                ? {
                    kind: "item",
                    type: "snapshot.missing",
                    field: "type",
                    code: "unknown_type",
                  }
                : {
                    kind: "item",
                    type: "core.note",
                    field: "source_id",
                    code: "already_present",
                  },
          },
        },
      });
      expect(list.mock.calls.filter(([filter]) => !filter.cursor)).toHaveLength(
        2,
      );
      expect(poisoned).toBe(6);
      expect(spool()).toEqual([]);
    },
  );

  it.each(["a duplicate", "an unregistered type", "a cycle"])(
    "refuses both selections whose edges carry %s before headers",
    async (kind) => {
      await seedNotes(ctx, 3);
      await seedEdges(ctx, 3, 1);
      const witness = await exportArchive(ctx, credential);
      expect(witness.status).toBe(200);
      await witness.arrayBuffer();
      await untilSpoolEmpty();
      const list = vi.spyOn(ctx.storage.items, "list");
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded with its original receiver below.
      const append = TextSpool.prototype.append;
      let poisoned = 0;
      vi.spyOn(TextSpool.prototype, "append").mockImplementation(
        async function (this: TextSpool, text) {
          if (text.includes('"edge":')) {
            poisoned++;
            text =
              text
                .trimEnd()
                .split("\n")
                .map((line) => {
                  const row = JSON.parse(line) as {
                    edge: Record<string, unknown>;
                  };
                  if (kind === "a duplicate") {
                    row.edge.source_id = idAt(1);
                    row.edge.target_id = idAt(2);
                  } else if (kind === "a cycle") {
                    row.edge.edge_type = "supersedes";
                    if (row.edge.source_id === idAt(2))
                      row.edge.target_id = idAt(1);
                  } else row.edge.edge_type = "snapshot.unregistered";
                  return JSON.stringify(row);
                })
                .join("\n") + "\n";
          }
          await append.call(this, text);
        },
      );
      const response = await exportArchive(ctx, credential);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: {
          code: "export_rows_unrestorable",
          details: {
            row: {
              kind: "edge",
              ...{
                "a duplicate": {
                  type: "references",
                  code: "edge_constraint_violation",
                },
                "an unregistered type": {
                  type: "snapshot.unregistered",
                  field: "edge_type",
                  code: "edge_type_not_found",
                },
                "a cycle": {
                  type: "supersedes",
                  code: "edge_cycle",
                },
              }[kind],
            },
          },
        },
      });
      expect(list.mock.calls.filter(([filter]) => !filter.cursor)).toHaveLength(
        2,
      );
      expect(poisoned).toBe(2);
      expect(spool()).toEqual([]);
    },
  );

  it("restores a type deleted after its item was spooled", async () => {
    await seedNotes(ctx, 59);
    const registered = await request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: { id: "snapshot.custom", version: 1, fields: {} },
    });
    expect(registered.status, await registered.clone().text()).toBe(201);
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "snapshot.custom", properties: {} },
    });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as {
      item: { id: string; version: number };
    };
    const before = await exportArchive(ctx, credential);
    const beforeBytes = Buffer.from(await before.arrayBuffer());
    let arrived!: () => void;
    const held = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let resume!: () => void;
    const release = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const list = ctx.storage.items.list.bind(ctx.storage.items);
    let pages = 0;
    const spy = vi
      .spyOn(ctx.storage.items, "list")
      .mockImplementation(async (filters) => {
        if (++pages === 2) {
          arrived();
          await release;
        }
        return list(filters);
      });
    const pending = exportArchive(ctx, credential);
    let duringBytes: Buffer;
    try {
      await held;
      const retyped = await request(ctx.app, "PATCH", `/items/${item.id}`, {
        key: ctx.workingKey,
        body: {
          version: item.version,
          retype: true,
          type: "core.note",
          properties: { body: "now a note" },
        },
      });
      expect(retyped.status, await retyped.clone().text()).toBe(200);
      const deleted = await request(
        ctx.app,
        "DELETE",
        "/types/snapshot.custom",
        {
          key: ctx.workingKey,
        },
      );
      expect(deleted.status, await deleted.clone().text()).toBe(200);
      resume();
      const during = await pending;
      expect(during.status).toBe(200);
      duringBytes = Buffer.from(await during.arrayBuffer());
    } finally {
      resume();
      await pending;
      spy.mockRestore();
    }
    const after = await exportArchive(ctx, credential);
    const afterBytes = Buffer.from(await after.arrayBuffer());
    for (const [label, bytes] of [
      ["before", beforeBytes],
      ["after", afterBytes],
      ["during", duringBytes],
    ] as const) {
      const target = await createTestContext();
      try {
        const restored = await restore(target, bytes);
        expect(
          restored.status,
          `${label}: ${await restored.clone().text()}`,
        ).toBe(200);
        expect(await restored.json()).toMatchObject({ imported: 60 });
      } finally {
        await target.cleanup();
      }
    }
  });

  it("restores an archive of an instance written to between its pages", async () => {
    await seedNotes(ctx, 300);
    await seedEdges(ctx, 300, 100);
    const outside = AsyncLocalStorage.snapshot();
    const list = ctx.storage.items.list.bind(ctx.storage.items);
    let pages = 0;
    vi.spyOn(ctx.storage.items, "list").mockImplementation(async (filters) => {
      const page = await list(filters);
      pages++;
      if (pages === 2)
        await outside(async () => {
          // Pages walk newest first. These land after two pages were read:
          // the first rewrites a row already carried, the second trashes one
          // not yet read (with its edges), the third adds a row and an edge to
          // a row not yet read.
          const patched = await request(
            ctx.app,
            "PATCH",
            `/items/${idAt(300)}`,
            {
              key: ctx.workingKey,
              body: { version: 1, properties: { body: "rewritten" } },
            },
          );
          expect(patched.status, await patched.clone().text()).toBe(200);
          const trashed = await request(
            ctx.app,
            "DELETE",
            `/items/${idAt(20)}`,
            {
              key: ctx.workingKey,
            },
          );
          expect(trashed.status).toBe(200);
          const added = await request(ctx.app, "POST", "/items", {
            key: ctx.workingKey,
            body: { type: "core.note", properties: { body: "added" } },
          });
          expect(added.status).toBe(201);
          const addedId = ((await added.json()) as { item: { id: string } })
            .item.id;
          const linked = await request(ctx.app, "POST", "/edges", {
            key: ctx.workingKey,
            body: {
              source_id: addedId,
              target_id: idAt(250),
              edge_type: "references",
            },
          });
          expect(linked.status, await linked.clone().text()).toBe(201);
        });
      return page;
    });
    const res = await exportArchive(ctx, credential);
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
      expect(counts.edges_imported).toBe(199);
    } finally {
      await target.cleanup();
    }
  });

  it("reads edges in separate pages after the item pages", async () => {
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
    const outside = AsyncLocalStorage.snapshot();
    const created: Record<string, string> = {};
    const listItems = ctx.storage.items.list.bind(ctx.storage.items);
    let itemPages = 0;
    vi.spyOn(ctx.storage.items, "list").mockImplementation(async (filters) => {
      const page = await listItems(filters);
      itemPages++;
      // Both ends are on the first page, which the export has carried.
      if (itemPages === 2)
        created.duringItems = await outside(() => link(300, 299));
      return page;
    });
    const listEdges = ctx.storage.edges.list.bind(ctx.storage.edges);
    let edgePages = 0;
    vi.spyOn(ctx.storage.edges, "list").mockImplementation(async (filters) => {
      const page = await listEdges(filters);
      edgePages++;
      if (edgePages === 1)
        created.afterFirstEdgePage = await outside(() => link(300, 298));
      return page;
    });

    const res = await exportArchive(ctx, credential);
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
    // The edge pass starts after the item pass; its own cursor excludes newer edges.
    expect(edgeIds.has(created.duringItems!)).toBe(true);
    expect(edgeIds.has(created.afterFirstEdgePage!)).toBe(false);
    expect(edgeIds.size).toBe(300);
  });
});
