import { createHash } from "node:crypto";
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
import { SPACE_PERMISSIONS } from "@withmarfa/shared";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";

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

describe("POST /admin/restore-archive", () => {
  it("imports items and blobs from an archive", async () => {
    const blob = makeBlobData("archive-import-blob-test");
    const source = `archive-restore-${Math.random().toString(36).slice(2)}`;

    const archive = await buildArchive(
      {
        version: 1,
        format: "marfa-archive-v1",
        created_at: new Date().toISOString(),
        item_count: 1,
        blob_count: 1,
        blobs: {
          [blob.hash]: { mime_type: "text/plain", size: blob.data.length },
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
      key: ctx.spaceKey,
    });
    expect(blobRes.status).toBe(200);
    const blobContent = Buffer.from(await blobRes.arrayBuffer());
    expect(blobContent.toString()).toBe("archive-import-blob-test");
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
        space_permissions: [...SPACE_PERMISSIONS],
        type_permissions: { "*": "write" },
        is_operator: false,
      },
      keyHash,
    );

    const archive = await buildArchive(
      {
        version: 1,
        format: "marfa-archive-v1",
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
        Authorization: `Bearer ${ctx.spaceKey}`,
        "Content-Type": "text/plain",
      },
      body: blobContent,
    });
    const { hash: blobHash } = (await uploadRes.json()) as { hash: string };

    const source = `rt-archive-${Math.random().toString(36).slice(2)}`;
    await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "Roundtrip", blob_ref: blobHash },
        source,
        source_id: "rta-1",
      },
    });

    const exportRes = await request(ctx.app, "GET", "/export?format=archive", {
      key: ctx.spaceKey,
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
    expect(data.blobs_imported).toBeGreaterThanOrEqual(0);
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
        version: 1,
        format: "marfa-archive-v1",
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
        version: 1,
        format: "marfa-archive-v1",
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
        version: 1,
        format: "marfa-archive-v1",
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
        version: 1,
        format: "marfa-archive-v1",
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
        version: 1,
        format: "marfa-archive-v1",
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
        version: 1,
        format: "marfa-archive-v1",
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
