import { fork, type ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
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
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";
import { setBusyBudgetMs } from "../storage/sqlite/connection.js";
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

type Entry = { name: string; text: string } | { name: string; zeros: number };

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

const MANIFEST: Entry = {
  name: "manifest.json",
  text: JSON.stringify({ version: 0, format: "marfa-archive-v0", blobs: {} }),
};

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
  it("leaves no type, row, event or audit record behind", async () => {
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
      const archive = await buildArchive([MANIFEST, TYPES, items, edges]);
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
    } finally {
      for (const child of children) child.kill("SIGKILL");
    }
  });
});
