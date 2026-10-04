import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate } from "node:timers";
import { createGzip } from "node:zlib";
import * as tar from "tar-stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateId,
  getEdgeTypeSchema,
  getTypeSchema,
} from "@withmarfa/shared";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import {
  initEventLog,
  subscribeAll,
  __resetEventLogForTests,
} from "../pubsub.js";
import { setBusyBudgetMs } from "../storage/sqlite/connection.js";
import { finishPendingCopyDeletions } from "../housekeeping/blob-delete.js";
import { MAX_ARCHIVE_TEXT_BYTES } from "./admin-archive-read.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
});
afterEach(async () => {
  __resetEventLogForTests();
  await ctx.cleanup();
});

type Entry =
  | { name: string; text: string }
  | { name: string; zeros: number }
  | { name: string; lines: () => Iterable<Buffer>; size: number };

function* zeroChunks(bytes: number): Generator<Buffer> {
  const chunk = Buffer.alloc(1 << 20);
  for (let left = bytes; left > 0; left -= chunk.length) {
    yield left >= chunk.length ? chunk : chunk.subarray(0, left);
  }
}

/** A gzipped tar of `entries`, streamed so an entry of zeros costs nothing
 *  to build however large it is. */
async function buildArchive(entries: Entry[]): Promise<Buffer> {
  const pack = tar.pack();
  const gzip = createGzip();
  const chunks: Buffer[] = [];
  gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise((resolve) => gzip.on("end", resolve));
  pack.pipe(gzip);
  for (const entry of entries) {
    if ("text" in entry) {
      const bytes = Buffer.from(entry.text);
      pack.entry({ name: entry.name, size: bytes.length }, bytes);
    } else if ("lines" in entry) {
      await pipeline(
        Readable.from(entry.lines()),
        pack.entry({ name: entry.name, size: entry.size }),
      );
    } else {
      await pipeline(
        Readable.from(zeroChunks(entry.zeros)),
        pack.entry({ name: entry.name, size: entry.zeros }),
      );
    }
  }
  pack.finalize();
  await ended;
  return Buffer.concat(chunks);
}

function manifestFor(blobs: { hash: string; data: Buffer }[]): Entry {
  return {
    name: "manifest.json",
    text: JSON.stringify({
      version: 0,
      format: "marfa-archive-v0",
      blobs: Object.fromEntries(
        blobs.map(({ hash, data }) => [
          hash,
          { mime_type: "text/plain", size_bytes: data.length },
        ]),
      ),
    }),
  };
}

const MANIFEST = manifestFor([]);

function blobsOf(count: number, tag: string) {
  return Array.from({ length: count }, (_, i) => {
    const data = Buffer.from(`${tag} blob ${String(i)}`);
    const hash = `sha256:${createHash("sha256").update(data).digest("hex")}`;
    return { hash, data };
  });
}

function blobEntries(blobs: { hash: string; data: Buffer }[]): Entry[] {
  return blobs.map(({ hash, data }) => ({
    name: `blobs/${hash}`,
    text: data.toString(),
  }));
}

/** The live heap after a full collection. */
const liveHeap = (() => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  return (): number => {
    gc();
    return process.memoryUsage().heapUsed;
  };
})();

const TYPE = "user.bounds_note";
const EDGE_TYPE = "user.bounds-link";
const TYPES: Entry = {
  name: "types.ndjson",
  text:
    [
      JSON.stringify({
        type: {
          id: TYPE,
          name: "Bounds note",
          description: "A type the archive registers",
          version: 1,
          fields: { body: { type: "string", description: "Body" } },
        },
        provenance: { origin: "user" },
      }),
      JSON.stringify({
        edge_type: { id: EDGE_TYPE, cardinality: "many-to-many" },
      }),
    ].join("\n") + "\n",
};

/** `count` rows of `type`, each linked to the next by `EDGE_TYPE`. */
function rows(count: number, type: string, withEdges = true) {
  const ids = Array.from({ length: count }, () => generateId());
  const items: Entry = {
    name: "items.ndjson",
    text: ids
      .map((id, i) =>
        JSON.stringify({
          item: {
            id,
            type,
            properties: { body: `row ${String(i)}` },
            source: "bounds",
            source_id: id,
          },
          metadata: { tags: [], extensions: {} },
        }),
      )
      .join("\n"),
  };
  const edges: Entry = {
    name: "edges.ndjson",
    text: withEdges
      ? ids
          .slice(1)
          .map((target, i) =>
            JSON.stringify({
              edge: {
                id: generateId(),
                source_id: ids[i],
                target_id: target,
                edge_type: EDGE_TYPE,
                properties: {},
              },
            }),
          )
          .join("\n")
      : "",
  };
  return { ids, items, edges };
}

function restore(archive: Buffer): Promise<Response> {
  return Promise.resolve(
    ctx.app.request("/admin/restore-archive", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.operatorKey}`,
        "Content-Type": "application/gzip",
      },
      body: archive,
    }),
  );
}

async function errorOf(res: Response) {
  return ((await res.json()) as { error: { code: string; message: string } })
    .error;
}

async function countRows(table: string): Promise<number> {
  const storage = ctx.storage as typeof ctx.storage & {
    __sqliteAll(sql: string): Promise<unknown[]>;
  };
  const [row] = (await storage.__sqliteAll(
    `SELECT count(*) AS n FROM ${table}`,
  )) as { n: number }[];
  return Number(row?.n);
}

describe("POST /admin/restore-archive in bounded memory", () => {
  it("steps past a 600 MB entry it does not read without holding it", async () => {
    const { items } = rows(1, "core.note", false);
    const archive = await buildArchive([
      MANIFEST,
      items,
      { name: "padding.bin", zeros: 600 * 1024 * 1024 },
    ]);
    expect(archive.length).toBeLessThan(2 * 1024 * 1024);

    const before = process.memoryUsage().rss;
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 5);
    let res: Response;
    try {
      res = await restore(archive);
    } finally {
      clearInterval(sampler);
    }
    peak = Math.max(peak, process.memoryUsage().rss);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { imported: number }).imported).toBe(1);
    expect(peak - before).toBeLessThan(150 * 1024 * 1024);
    expect(readdirSync(ctx.blobs.disk.spoolDir)).toEqual([]);
  });

  it("refuses a line longer than the most it reads at once, and writes nothing", async () => {
    const { items } = rows(1, "core.note", false);
    const witness = await restore(await buildArchive([MANIFEST, items]));
    expect(witness.status).toBe(200);

    const res = await restore(
      await buildArchive([
        MANIFEST,
        { name: "items.ndjson", zeros: MAX_ARCHIVE_TEXT_BYTES + 1 },
      ]),
    );
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe("validation_error");
    expect(error.message).toContain("items.ndjson line 1");
    expect(readdirSync(ctx.blobs.disk.spoolDir)).toEqual([]);
  });

  it("refuses an archive carrying a name it reads twice, and writes nothing", async () => {
    const first = rows(1, "core.note", false);
    const second = rows(1, "core.note", false);
    const res = await restore(
      await buildArchive([MANIFEST, first.items, second.items]),
    );
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe("validation_error");
    expect(error.message).toContain("items.ndjson more than once");
    expect(await ctx.storage.items.get(first.ids[0] ?? "")).toBeNull();
    expect(readdirSync(ctx.blobs.disk.spoolDir)).toEqual([]);

    // Each half restores on its own.
    expect(
      (await restore(await buildArchive([MANIFEST, first.items]))).status,
    ).toBe(200);
    expect(await ctx.storage.items.get(first.ids[0] ?? "")).not.toBeNull();
  });

  it("refuses a body whose gzip stream breaks partway, leaving no spool", async () => {
    const { items } = rows(3000, "core.note", false);
    const archive = await buildArchive([MANIFEST, items]);
    const broken = Buffer.from(archive);
    broken.fill(0xff, broken.length >> 1, (broken.length >> 1) + 64);
    const res = await restore(broken);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation_error");
    expect(readdirSync(ctx.blobs.disk.spoolDir)).toEqual([]);
    expect(await countRows("items WHERE source = 'bounds'")).toBe(0);
    expect((await restore(archive)).status).toBe(200);
    expect(await countRows("items WHERE source = 'bounds'")).toBe(3000);
  });
});

describe("POST /admin/restore-archive all or nothing", () => {
  it("leaves no registration, row or event when it fails after registering the archive's types", async () => {
    const { ids, items, edges } = rows(3, TYPE);
    const archive = await buildArchive([MANIFEST, TYPES, items, edges]);
    const store = ctx.storage.edges;
    const createRaw = store.createRaw.bind(store);
    let registeredInside = false;
    store.createRaw = () => {
      registeredInside =
        getTypeSchema(TYPE) !== undefined &&
        getEdgeTypeSchema(EDGE_TYPE) !== undefined;
      return Promise.reject(new Error("simulated storage failure"));
    };
    let res: Response;
    try {
      res = await restore(archive);
    } finally {
      store.createRaw = createRaw;
    }
    expect(res.status).toBe(500);
    expect(registeredInside).toBe(true);
    expect(getTypeSchema(TYPE)).toBeUndefined();
    expect(getEdgeTypeSchema(EDGE_TYPE)).toBeUndefined();
    expect(
      (await ctx.storage.types.listRegistered()).map((t) => t.id),
    ).not.toContain(TYPE);
    expect((await ctx.storage.edgeTypes.list()).map((t) => t.id)).not.toContain(
      EDGE_TYPE,
    );
    expect(await ctx.storage.items.get(ids[0] ?? "")).toBeNull();
    expect(await ctx.storage.eventLog.getAfter(0n, 100)).toEqual([]);
    for (const action of [
      "admin.restore_archive",
      "admin.restore_archive.type",
      "admin.restore_archive.edge_type",
    ]) {
      expect((await ctx.storage.audit.list({ action })).data).toEqual([]);
    }

    const restored = await restore(archive);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({
      imported: 3,
      edges_imported: 2,
      types_registered: 1,
      edge_types_registered: 1,
    });
    expect(getTypeSchema(TYPE)).toBeDefined();
    expect(await ctx.storage.eventLog.getAfter(0n, 100)).toHaveLength(5);

    // Restored again, everything is already there and is skipped.
    const again = await restore(archive);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      imported: 0,
      duplicates: 3,
      edges_imported: 0,
      edges_skipped: 2,
      types_registered: 0,
      types_skipped: 1,
      edge_types_registered: 0,
      edge_types_skipped: 1,
    });
    expect(await ctx.storage.eventLog.getAfter(0n, 100)).toHaveLength(5);
  });

  it("gives the event loop a turn between batches inside its transaction", async () => {
    const { items } = rows(450, "core.note", false);
    const archive = await buildArchive([MANIFEST, items]);
    const metadata = ctx.storage.metadata;
    const setExtensions = metadata.setExtensions.bind(metadata);
    let written = 0;
    let observed: Promise<number> | undefined;
    metadata.setExtensions = async (id, extensions) => {
      const result = await setExtensions(id, extensions);
      written += 1;
      observed ??= new Promise((resolve) =>
        setImmediate(() => {
          resolve(written);
        }),
      );
      return result;
    };
    let res: Response;
    try {
      res = await restore(archive);
    } finally {
      metadata.setExtensions = setExtensions;
    }
    expect(res.status).toBe(200);
    expect(written).toBe(450);
    // A turn came within the first batch, long before the last row.
    expect(await observed).toBeLessThanOrEqual(100);
  });

  it("holds no restored row's content in memory, before or after it commits, and gives a large row a turn of its own", async () => {
    const count = 8;
    const property = 30 * 1024 * 1024;
    const line = (i: number): Buffer =>
      Buffer.from(
        JSON.stringify({
          item: {
            id: generateId(),
            type: "core.note",
            properties: {
              body: `large ${String(i)}`,
              blob: "x".repeat(property),
            },
            source: "bounds",
            source_id: `large-${String(i)}`,
          },
        }) + "\n",
      );
    const size = line(0).length * count;
    const archive = await buildArchive([
      MANIFEST,
      {
        name: "items.ndjson",
        size,
        lines: function* () {
          for (let i = 0; i < count; i++) yield line(i);
        },
      },
    ]);

    let turns = 0;
    const ticker = setInterval(() => {
      turns += 1;
    }, 1);
    const turnsAtRow: number[] = [];
    const metadata = ctx.storage.metadata;
    const setExtensions = metadata.setExtensions.bind(metadata);
    metadata.setExtensions = async (id, extensions) => {
      turnsAtRow.push(turns);
      return setExtensions(id, extensions);
    };
    const audit = ctx.storage.audit;
    const log = audit.log.bind(audit);
    let heapAtCommit = 0;
    audit.log = (entry, id) => {
      if (entry.action === "admin.restore_archive") heapAtCommit = liveHeap();
      return log(entry, id);
    };
    // Read back after the commit to tell subscribers, a page at a time.
    const eventLog = ctx.storage.eventLog;
    const getAfter = eventLog.getAfter.bind(eventLog);
    let largestPage = 0;
    eventLog.getAfter = async (after, limit, options) => {
      const page = await getAfter(after, limit, options);
      largestPage = Math.max(
        largestPage,
        page.reduce((sum, row) => sum + row.payload.length, 0),
      );
      return page;
    };
    const abort = new AbortController();
    let announced = 0;
    const listening = (async () => {
      try {
        for await (const batch of subscribeAll({ signal: abort.signal })) {
          announced += batch.length;
          if (announced >= count) return;
        }
      } catch {
        // The abort ends the generator.
      }
    })();
    const before = liveHeap();
    let res: Response;
    try {
      res = await restore(archive);
      await listening;
    } finally {
      abort.abort();
      clearInterval(ticker);
      metadata.setExtensions = setExtensions;
      audit.log = log;
      eventLog.getAfter = getAfter;
    }
    expect(res.status).toBe(200);
    expect(((await res.json()) as { imported: number }).imported).toBe(count);
    expect(announced).toBe(count);
    expect(largestPage).toBeLessThan(2 * (property + 1024));
    // Every row was written; their content, eight times 30 MiB, is not held.
    expect(heapAtCommit).toBeGreaterThan(0);
    expect(heapAtCommit - before).toBeLessThan(100 * 1024 * 1024);
    expect(turnsAtRow).toHaveLength(count);
    for (let i = 1; i < count; i++) {
      expect(turnsAtRow[i]).toBeGreaterThan(turnsAtRow[i - 1] ?? 0);
    }
  });

  it("gives the event loop a turn over lines it skips as well as rows it writes", async () => {
    const { items } = rows(450, "core.note", false);
    const archive = await buildArchive([MANIFEST, items]);
    expect((await restore(archive)).status).toBe(200);

    // Each line is offered to the store, which finds its id taken.
    const store = ctx.storage.items as unknown as {
      create: (input: unknown) => Promise<unknown>;
    };
    const create = store.create.bind(store);
    let looked = 0;
    let observed: Promise<number> | undefined;
    store.create = async (input: unknown) => {
      looked += 1;
      observed ??= new Promise((resolve) =>
        setImmediate(() => {
          resolve(looked);
        }),
      );
      return create(input);
    };
    let res: Response;
    try {
      res = await restore(archive);
    } finally {
      store.create = create;
    }
    expect(res.status).toBe(200);
    expect(((await res.json()) as { duplicates: number }).duplicates).toBe(450);
    expect(looked).toBeGreaterThanOrEqual(450);
    expect(await observed).toBeLessThanOrEqual(100);
  });

  it("tells live subscribers every restored event once it commits, in id order and ahead of the next write", async () => {
    const { ids, items, edges } = rows(450, TYPE);
    const archive = await buildArchive([MANIFEST, TYPES, items, edges]);
    const abort = new AbortController();
    const frames: { kind: string; id: string; eventId: bigint }[] = [];
    const listening = (async () => {
      try {
        for await (const batch of subscribeAll({ signal: abort.signal })) {
          for (const frame of batch) {
            frames.push(
              frame.kind === "item"
                ? {
                    kind: frame.event.type,
                    id: frame.event.item.id,
                    eventId: frame.event.eventId ?? -1n,
                  }
                : {
                    kind: frame.event.type,
                    id: frame.event.edge.id,
                    eventId: frame.event.eventId ?? -1n,
                  },
            );
          }
        }
      } catch {
        // The abort ends the generator.
      }
    })();
    try {
      expect((await restore(archive)).status).toBe(200);
      const after = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: { type: "core.note", properties: { body: "after the restore" } },
      });
      expect(after.status).toBe(201);
      const { item } = (await after.json()) as { item: { id: string } };
      const deadline = Date.now() + 10_000;
      while (!frames.some((frame) => frame.id === item.id)) {
        if (Date.now() > deadline) throw new Error("no frame for the write");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      abort.abort();
      await listening;
    }
    expect(frames).toHaveLength(450 + 449 + 1);
    expect(frames.slice(0, 450).map((frame) => frame.id)).toEqual(ids);
    expect(
      frames.slice(0, 450).every((frame) => frame.kind === "created"),
    ).toBe(true);
    expect(
      frames.slice(450, 899).every((frame) => frame.kind === "edge_created"),
    ).toBe(true);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]?.eventId).toBeGreaterThan(frames[i - 1]?.eventId ?? 0n);
    }
    expect(await countRows("event_log")).toBe(450 + 449 + 1);
  });

  it("holds other writers in the queue and keeps its rows and types from readers until it commits", async () => {
    const { ids, items, edges } = rows(250, TYPE);
    const archive = await buildArchive([MANIFEST, TYPES, items, edges]);
    const metadata = ctx.storage.metadata;
    const setExtensions = metadata.setExtensions.bind(metadata);
    let written = 0;
    let stopped!: () => void;
    const reached = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    metadata.setExtensions = async (id, extensions) => {
      const result = await setExtensions(id, extensions);
      written += 1;
      if (written === 150) {
        stopped();
        await resumed;
      }
      return result;
    };
    const otherType = (id: string) =>
      request(ctx.app, "POST", "/types", {
        key: ctx.workingKey,
        body: {
          id,
          name: "Other",
          version: 1,
          fields: { body: { type: "string" } },
        },
      });
    // A key's first use stamps it, which is a write; used once beforehand,
    // the reads below write nothing.
    expect(
      (await request(ctx.app, "GET", "/types", { key: ctx.workingKey })).status,
    ).toBe(200);
    try {
      const restoring = restore(archive);
      await reached;

      // Answered, though the write probe reports the database held.
      expect((await request(ctx.app, "GET", "/health")).status).toBe(200);
      const listed = await request(ctx.app, "GET", "/types", {
        key: ctx.workingKey,
      });
      expect(listed.status).toBe(200);
      expect(JSON.stringify(await listed.json())).not.toContain(TYPE);
      const read = await request(ctx.app, "GET", `/items/${ids[0] ?? ""}`, {
        key: ctx.workingKey,
      });
      expect(read.status).toBe(404);

      const waiting = otherType("user.bounds_waiting");
      const early = await Promise.race([
        waiting.then(() => "answered"),
        new Promise((resolve) => setTimeout(resolve, 200, "waiting")),
      ]);
      expect(early).toBe("waiting");

      setBusyBudgetMs(100);
      let refused: Response;
      try {
        refused = await otherType("user.bounds_refused");
      } finally {
        setBusyBudgetMs(5_000);
      }
      expect(refused.status).toBe(503);
      expect((await errorOf(refused)).code).toBe("write_contention");

      resume();
      const res = await restoring;
      expect(res.status).toBe(200);
      expect((await waiting).status).toBe(201);
    } finally {
      metadata.setExtensions = setExtensions;
      resume();
    }
    expect(getTypeSchema(TYPE)).toBeDefined();
    expect((await otherType(TYPE)).status).toBe(409);
    expect(await countRows("items WHERE source = 'bounds'")).toBe(250);
  });
});

interface Message {
  kind: string;
  url?: string;
  written?: number;
}

function next(child: ChildProcess, kind: string): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", receive);
      reject(new Error(`child did not report ${kind}`));
    }, 20_000);
    const receive = (message: Message) => {
      if (message.kind !== kind) return;
      clearTimeout(timer);
      child.off("message", receive);
      resolve(message);
    };
    child.on("message", receive);
  });
}

describe("POST /admin/restore-archive killed partway", () => {
  it("leaves no type, row, event or audit record behind, and its blob bytes to the copy cleanup", async () => {
    const children: ChildProcess[] = [];
    const boot = async (stopAfter?: number) => {
      const child = fork(
        new URL(
          "../../scripts/test-fixtures/restore-crash.ts",
          import.meta.url,
        ),
        [],
        {
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        },
      );
      children.push(child);
      const ready = next(child, "ready");
      child.send({ dir: ctx.tmpDir, config: ctx.config, stopAfter });
      const { url } = await ready;
      if (!url) throw new Error("child has no URL");
      return { child, url };
    };
    try {
      const { ids, items, edges } = rows(250, TYPE);
      const blobs = blobsOf(3, "killed");
      const archive = await buildArchive([
        manifestFor(blobs),
        TYPES,
        items,
        edges,
        ...blobEntries(blobs),
      ]);
      const first = await boot(150);
      const stopped = next(first.child, "stopped");
      const answer = fetch(`${first.url}/admin/restore-archive`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.operatorKey}`,
          "Content-Type": "application/gzip",
        },
        body: archive,
      }).catch((err: unknown) => err);
      // The witness: the restore had registered its types and written rows
      // inside its transaction when it was killed.
      expect((await stopped).written).toBe(150);
      const exited = new Promise((resolve) =>
        first.child.once("exit", resolve),
      );
      first.child.kill("SIGKILL");
      await exited;
      expect(await answer).toBeInstanceOf(Error);

      const second = await boot();
      const listed = await fetch(`${second.url}/types`, {
        headers: { Authorization: `Bearer ${ctx.workingKey}` },
      });
      expect(listed.status).toBe(200);
      expect(JSON.stringify(await listed.json())).not.toContain(TYPE);
      expect(
        (await ctx.storage.types.listRegistered()).map((t) => t.id),
      ).not.toContain(TYPE);
      expect(
        (await ctx.storage.edgeTypes.list()).map((t) => t.id),
      ).not.toContain(EDGE_TYPE);
      expect(await countRows("items WHERE source = 'bounds'")).toBe(0);
      expect(await countRows("event_log")).toBe(0);
      expect(
        await countRows("audit_log WHERE action LIKE 'admin.restore_archive%'"),
      ).toBe(0);

      // The bytes were placed before the transaction and are still there,
      // each named by a cleanup record and by no row, which the copy cleanup
      // a running server does on its own schedule then removes.
      expect(await countRows("blobs")).toBe(0);
      for (const { hash } of blobs) {
        expect(await ctx.blobs.disk.has(hash)).not.toBeNull();
      }
      const pending = await ctx.storage.blobs.listPendingCopyDeletions(100);
      expect(pending.map((copy) => copy.hash).sort()).toEqual(
        blobs.map((blob) => blob.hash).sort(),
      );
      await finishPendingCopyDeletions(ctx.storage, ctx.blobs, 100);
      for (const { hash } of blobs) {
        expect(await ctx.blobs.disk.has(hash)).toBeNull();
      }
      expect(await ctx.storage.blobs.listPendingCopyDeletions(100)).toEqual([]);

      // The same archive restores whole into the restarted server.
      const restored = await fetch(`${second.url}/admin/restore-archive`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.operatorKey}`,
          "Content-Type": "application/gzip",
        },
        body: archive,
      });
      expect(restored.status).toBe(200);
      expect(await countRows("items WHERE source = 'bounds'")).toBe(250);
      expect(ids).toHaveLength(250);
      for (const { hash } of blobs) {
        expect(await ctx.blobs.disk.has(hash)).not.toBeNull();
        expect(await ctx.storage.blobs.get(hash)).not.toBeNull();
      }
      expect(await ctx.storage.blobs.listPendingCopyDeletions(100)).toEqual([]);
    } finally {
      for (const child of children) child.kill("SIGKILL");
    }
  });
});
