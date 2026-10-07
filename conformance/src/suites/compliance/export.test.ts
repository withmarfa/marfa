import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type {
  TestContext,
  MarfaItem,
  MarfaEdge,
  MarfaMetadata,
} from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  trackEdgeType,
  trackKey,
  trackWebhook,
  cleanup,
} from "../../utils/setup.js";
import { createNote, createBookmark } from "../../generators/items.js";
import { listTarGzEntries, readTarGzEntry } from "../../utils/archive.js";
import { startReceiver } from "../../utils/webhook-receiver.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "export",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

/** Item lines only, for the filter cases; the edge line is read raw below. */
function parseNdjson(
  raw: string,
): Array<{ item: MarfaItem; metadata: MarfaMetadata }> {
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(
      (line) =>
        JSON.parse(line) as { item?: MarfaItem; metadata?: MarfaMetadata },
    )
    .filter(
      (parsed): parsed is { item: MarfaItem; metadata: MarfaMetadata } =>
        parsed.item !== undefined,
    );
}

/**
 * Every filter case seeds a row the filter must return and a row it must
 * exclude, and asserts both, because a loop over an empty export passes
 * whatever the filter did.
 */
describe("export", () => {
  it("filters by type", async () => {
    const n = await client.createItem(createNote({ source: ctx.source }));
    expect(n.ok).toBe(true);
    trackItem(ctx, n.data.item.id);

    const b = await client.createItem(createBookmark({ source: ctx.source }));
    expect(b.ok).toBe(true);
    trackItem(ctx, b.data.item.id);

    const exported = await client.exportItems({
      type: "core.note",
      source: ctx.source,
    });
    expect(exported.ok).toBe(true);
    const ids = parseNdjson(exported.data).map((line) => line.item.id);
    expect(ids).toContain(n.data.item.id);
    expect(ids).not.toContain(b.data.item.id);
    for (const line of parseNdjson(exported.data)) {
      expect(line.item.type).toBe("core.note");
    }
  });

  it("filters by date range on the item's own time", async () => {
    const inside = await client.createItem(createNote({ source: ctx.source }));
    expect(inside.ok).toBe(true);
    trackItem(ctx, inside.data.item.id);

    const outside = await client.createItem(
      createNote({
        source: ctx.source,
        occurred_at: "2001-01-01T00:00:00.000Z",
      }),
    );
    expect(outside.ok).toBe(true);
    trackItem(ctx, outside.data.item.id);

    const pivot = new Date(inside.data.item.created_at).getTime();
    const exported = await client.exportItems({
      source: ctx.source,
      occurred_after: new Date(pivot - 1000).toISOString(),
      occurred_before: new Date(pivot + 1000).toISOString(),
    });
    expect(exported.ok).toBe(true);
    const ids = parseNdjson(exported.data).map((line) => line.item.id);
    expect(ids).toContain(inside.data.item.id);
    expect(ids).not.toContain(outside.data.item.id);
  });

  it("filters by state", async () => {
    const active = await client.createItem(createNote({ source: ctx.source }));
    expect(active.ok).toBe(true);
    trackItem(ctx, active.data.item.id);

    const trashed = await client.createItem(createNote({ source: ctx.source }));
    expect(trashed.ok).toBe(true);
    trackItem(ctx, trashed.data.item.id);
    const deleted = await client.deleteItem(trashed.data.item.id);
    expect(deleted.ok).toBe(true);

    const exported = await client.exportItems({
      state: "active",
      source: ctx.source,
    });
    expect(exported.ok).toBe(true);
    const lines = parseNdjson(exported.data);
    const ids = lines.map((line) => line.item.id);
    expect(ids).toContain(active.data.item.id);
    expect(ids).not.toContain(trashed.data.item.id);
    for (const line of lines) {
      expect(line.item.state).toBe("active");
    }
  });

  it("respects type permissions on a scoped key", async () => {
    const n = await client.createItem(createNote({ source: ctx.source }));
    expect(n.ok).toBe(true);
    trackItem(ctx, n.data.item.id);

    const b = await client.createItem(createBookmark({ source: ctx.source }));
    expect(b.ok).toBe(true);
    trackItem(ctx, b.data.item.id);

    const keyResp = await client.createKey({
      label: "export-scoped",
      source: `${ctx.source}-export-scoped`,
      type_permissions: { "core.note": "read" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);

    const scoped = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    const exported = await scoped.exportItems({ source: ctx.source });
    expect(exported.ok).toBe(true);
    const lines = parseNdjson(exported.data);
    const ids = lines.map((line) => line.item.id);
    expect(ids).toContain(n.data.item.id);
    expect(ids).not.toContain(b.data.item.id);
    for (const line of lines) {
      expect(line.item.type).toBe("core.note");
    }
  });

  it("carries an edge line behind the item lines it joins", async () => {
    const a = await client.createItem(createNote({ source: ctx.source }));
    expect(a.ok).toBe(true);
    trackItem(ctx, a.data.item.id);

    const b = await client.createItem(createNote({ source: ctx.source }));
    expect(b.ok).toBe(true);
    trackItem(ctx, b.data.item.id);

    const edge = await client.createEdge({
      source_id: a.data.item.id,
      target_id: b.data.item.id,
      edge_type: "about",
    });
    expect(edge.ok).toBe(true);
    trackEdge(ctx, edge.data.edge.id);

    const exported = await client.exportItems({ source: ctx.source });
    expect(exported.ok).toBe(true);
    const lines = exported.data
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map(
        (line) => JSON.parse(line) as { item?: MarfaItem; edge?: MarfaEdge },
      );

    const itemIds = lines.flatMap((line) => (line.item ? [line.item.id] : []));
    expect(itemIds).toContain(a.data.item.id);
    expect(itemIds).toContain(b.data.item.id);

    const edgeIndex = lines.findIndex(
      (line) => line.edge?.id === edge.data.edge.id,
    );
    expect(edgeIndex).not.toBe(-1);
    expect(lines[edgeIndex].edge?.source_id).toBe(a.data.item.id);
    expect(lines[edgeIndex].edge?.target_id).toBe(b.data.item.id);
    expect(lines[edgeIndex].edge?.edge_type).toBe("about");

    const lastItemIndex = lines.reduce(
      (last, line, index) => (line.item ? index : last),
      -1,
    );
    expect(lastItemIndex).not.toBe(-1);
    expect(edgeIndex).toBeGreaterThan(lastItemIndex);
  });

  it("carries only the kinds of relationship the credential may read", async () => {
    // An export is a copy of what the credential may read, and its items
    // already are: they go through the same type map every listing does.
    // Its edges did not — every kind of relationship among those items
    // came out whatever the edge map said, which is the disclosure
    // `GET /edges` closed, reached through a copy instead of a page.
    const seenKind = `mock.export.seen.${ctx.runId}`;
    const unseenKind = `mock.export.unseen.${ctx.runId}`;
    for (const id of [seenKind, unseenKind]) {
      const registered = await client.registerEdgeType({
        id,
        cardinality: "many-to-many",
      });
      expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
      trackEdgeType(ctx, id);
    }

    const source = `${ctx.source}-edge-scope`;
    const writerResp = await client.createKey({
      label: "export-edge-scope-writer",
      source,
      permissions: [],
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
    });
    expect(writerResp.ok, JSON.stringify(writerResp.error)).toBe(true);
    trackKey(ctx, writerResp.data.id);
    const writer = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: writerResp.data.key,
    });

    const a = await writer.createItem(createNote({ source }));
    expect(a.ok, JSON.stringify(a.error)).toBe(true);
    trackItem(ctx, a.data.item.id);
    const b = await writer.createItem(createNote({ source }));
    expect(b.ok, JSON.stringify(b.error)).toBe(true);
    trackItem(ctx, b.data.item.id);

    const visible = await writer.createEdge({
      source_id: a.data.item.id,
      target_id: b.data.item.id,
      edge_type: seenKind,
    });
    expect(visible.ok, JSON.stringify(visible.error)).toBe(true);
    trackEdge(ctx, visible.data.edge.id);
    const hidden = await writer.createEdge({
      source_id: a.data.item.id,
      target_id: b.data.item.id,
      edge_type: unseenKind,
    });
    expect(hidden.ok, JSON.stringify(hidden.error)).toBe(true);
    trackEdge(ctx, hidden.data.edge.id);

    const edgeIdsOf = (raw: string): string[] =>
      raw
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as { edge?: MarfaEdge })
        .flatMap((line) => (line.edge ? [line.edge.id] : []));

    // Both endpoints are the same two readable items in both rows, so
    // what the export leaves out can only be the kind of relationship.
    const narrowResp = await client.createKey({
      label: "export-edge-scope-narrow",
      // Its own source, not the writer's: a key's own source belongs to one
      // key, and what this key exports is chosen by the `source` filter
      // rather than by the source it writes under.
      source: `${source}-reader`,
      permissions: [],
      type_permissions: { "*": "read" },
      edge_permissions: { [seenKind]: "read" },
    });
    expect(narrowResp.ok, JSON.stringify(narrowResp.error)).toBe(true);
    trackKey(ctx, narrowResp.data.id);
    const narrowExport = await new MarfaClient({
      baseUrl: apiUrl,
      apiKey: narrowResp.data.key,
    }).exportItems({ source });
    expect(narrowExport.ok, JSON.stringify(narrowExport.error)).toBe(true);
    const narrowIds = edgeIdsOf(narrowExport.data);
    expect(
      narrowIds,
      "the export dropped an edge of a kind the credential holds, so it refuses more than the gate asks",
    ).toContain(visible.data.edge.id);
    expect(
      narrowIds,
      "the export carried a kind of relationship this credential may not read",
    ).not.toContain(hidden.data.edge.id);

    // The archive format of the same door, under the same query schema.
    // One format honoring the gate while the other did not would be the
    // disclosure moved rather than closed, and the archive is the copy a
    // restore writes back.
    const narrowArchive = await new MarfaClient({
      baseUrl: apiUrl,
      apiKey: narrowResp.data.key,
    }).exportArchive({ source });
    expect(narrowArchive.status).toBe(200);
    const archivedIds = edgeIdsOf(
      readTarGzEntry(narrowArchive.data, "edges.ndjson") ?? "",
    );
    expect(
      archivedIds,
      "the archive dropped an edge of a kind the credential holds",
    ).toContain(visible.data.edge.id);
    expect(
      archivedIds,
      "the archive carried a kind of relationship this credential may not read",
    ).not.toContain(hidden.data.edge.id);

    // The witness for both formats: the same export under a credential
    // holding both kinds carries both rows, so the absences above are the
    // edge map.
    const wideExport = await client.exportItems({ source });
    expect(wideExport.ok, JSON.stringify(wideExport.error)).toBe(true);
    const wideIds = edgeIdsOf(wideExport.data);
    expect(wideIds).toContain(visible.data.edge.id);
    expect(wideIds).toContain(hidden.data.edge.id);
  });

  it("carries on each row only the extension namespaces the key may read, on both output formats", async () => {
    const seen = `export-seen-${ctx.runId}`;
    const unseen = `export-unseen-${ctx.runId}`;
    const note = await client.createItem(createNote({ source: ctx.source }));
    expect(note.ok).toBe(true);
    const id = note.data.item.id;
    trackItem(ctx, id);
    expect((await client.setItemExtension(id, seen, { a: 1 })).ok).toBe(true);
    expect((await client.setItemExtension(id, unseen, { secret: 2 })).ok).toBe(
      true,
    );

    const keyResp = await client.createKey({
      label: "export-one-namespace",
      source: `${ctx.source}-export-one-namespace`,
      permissions: [],
      type_permissions: { "core.note": "read" },
      extension_permissions: { [seen]: "read" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    const narrow = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    const lineFor = (raw: string) =>
      parseNdjson(raw).find((line) => line.item.id === id);
    const archiveLineFor = (archive: Uint8Array) =>
      lineFor(readTarGzEntry(archive, "items.ndjson") ?? "");

    // The witness, on both formats: a key that may read the namespace is
    // carried it.
    const fullStream = await client.exportItems({ source: ctx.source });
    expect(lineFor(fullStream.data)?.metadata.extensions?.[unseen]).toEqual({
      secret: 2,
    });
    const fullArchive = await client.exportArchive({ source: ctx.source });
    expect(fullArchive.ok).toBe(true);
    expect(
      archiveLineFor(fullArchive.data)?.metadata.extensions?.[unseen],
    ).toEqual({ secret: 2 });

    const stream = await narrow.exportItems({ source: ctx.source });
    expect(stream.ok).toBe(true);
    expect(lineFor(stream.data)?.metadata.extensions).toEqual({
      [seen]: { a: 1 },
    });
    const archive = await narrow.exportArchive({ source: ctx.source });
    expect(archive.ok).toBe(true);
    expect(archiveLineFor(archive.data)?.metadata.extensions).toEqual({
      [seen]: { a: 1 },
    });
  });

  it("refuses a format outside the two it offers", async () => {
    // `format` was `z.string()` under a description offering `ndjson` or
    // `archive`, an enumeration a reader takes as closed. `?format=bogus`
    // answered 200 with NDJSON and recorded `format: "bogus"` in the audit
    // row: a caller who asked for an archive and mistyped it got a stream
    // named like a success. The reasoning is the door's own, twelve lines
    // from where it refuses an undeclared query key.
    //
    // The control is the second half. A refusal of everything would pass the
    // first assertion, so both accepted values are exercised beside it.
    const bogus = await client.rawRequest("/export?format=bogus");
    expect(bogus.status).toBe(400);
    expect(bogus.error?.error.code).toBe("validation_error");

    const item = await client.createItem(createNote({ source: ctx.source }));
    expect(item.ok).toBe(true);
    trackItem(ctx, item.data.item.id);
    const scope = encodeURIComponent(ctx.source);
    const ndjson = await client.rawRequest<string>(
      `/export?source=${scope}&format=ndjson`,
    );
    expect(ndjson.status).toBe(200);
    const archive = await client.exportArchive({ source: ctx.source });
    expect(archive.status).toBe(200);
  });

  it("refuses an unknown state filter", async () => {
    const r = await client.exportItems({ state: "bogus" });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("validation_error");
  });

  it("refuses a bound that is not an instant, on both output formats", async () => {
    // The streaming format flushes its 200 and its headers before the first
    // page is fetched, so a bound the store refuses has to be refused before
    // the response begins, or the caller is handed an empty body with a
    // success status. The control is the
    // third assertion — a readable bound must still stream something, or
    // this case would pass against a door that refused every export.
    const stream = await client.exportItems({ occurred_after: "banana" });
    expect(stream.status).toBe(400);
    expect(stream.error?.error.code).toBe("validation_error");

    const archive = await client.exportArchive({ occurred_after: "banana" });
    expect(archive.status).toBe(400);

    const item = await client.createItem(createNote({ source: ctx.source }));
    expect(item.ok).toBe(true);
    trackItem(ctx, item.data.item.id);
    const readable = await client.exportItems({
      source: ctx.source,
      occurred_after: new Date(0).toISOString(),
    });
    expect(readable.status).toBe(200);
    expect(readable.data.length).toBeGreaterThan(0);
  });
});

/** The parsed lines of one line file of an archive. */
function archiveLines<T = Record<string, unknown>>(
  archive: Uint8Array,
  name: string,
): T[] {
  const text = readTarGzEntry(archive, name);
  expect(text, `${name} is a member of the archive`).not.toBeNull();
  return (text ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

function archiveItemIds(archive: Uint8Array): string[] {
  return archiveLines<{ item: MarfaItem }>(archive, "items.ndjson").map(
    (line) => line.item.id,
  );
}

/** A key of its own under a source of its own, so a row count can be exact. */
async function writerOfItsOwn(label: string): Promise<{
  writer: MarfaClient;
  source: string;
}> {
  const source = `${ctx.source}-${label}`;
  const minted = await client.createKey({
    label: `export-${label}`,
    source,
    permissions: [],
    type_permissions: { "*": "write" },
    edge_permissions: { "*": "write" },
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  return {
    writer: new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key }),
    source,
  };
}

async function noteIn(
  writer: MarfaClient,
  source: string,
  extra: Partial<Parameters<MarfaClient["createItem"]>[0]> = {},
): Promise<string> {
  const made = await writer.createItem({
    ...createNote({ source }),
    ...extra,
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackItem(ctx, made.data.item.id);
  return made.data.item.id;
}

describe("the states an export carries", () => {
  /** An active row, an archived one and a trashed one, under a source of its own. */
  async function oneOfEachState() {
    const { writer, source } = await writerOfItsOwn(
      `states-${String(Math.random()).slice(2, 8)}`,
    );
    const active = await noteIn(writer, source);
    const archived = await noteIn(writer, source);
    expect((await writer.transitionItem(archived, "archived")).ok).toBe(true);
    const trashed = await noteIn(writer, source);
    expect((await writer.deleteItem(trashed)).ok).toBe(true);
    return { source, active, archived, trashed };
  }

  const idsOf = (raw: string) => parseNdjson(raw).map((l) => l.item.id);

  it("carries every row it holds, the bin included, when it names state=any, on both formats", async () => {
    const { source, active, archived, trashed } = await oneOfEachState();
    const stream = await client.exportItems({ source, state: "any" });
    expect(stream.status).toBe(200);
    expect(idsOf(stream.data).sort()).toEqual(
      [active, archived, trashed].sort(),
    );
    const archive = await client.exportArchive({ source, state: "any" });
    expect(archive.status).toBe(200);
    expect(archiveItemIds(archive.data).sort()).toEqual(
      [active, archived, trashed].sort(),
    );
  });

  it("carries only the rows in the bin when it names state=trashed, on both formats", async () => {
    const { source, active, archived, trashed } = await oneOfEachState();
    const stream = await client.exportItems({ source, state: "trashed" });
    expect(stream.status).toBe(200);
    expect(idsOf(stream.data)).toEqual([trashed]);
    const archive = await client.exportArchive({ source, state: "trashed" });
    expect(archive.status).toBe(200);
    expect(archiveItemIds(archive.data)).toEqual([trashed]);
    // The witness: the same source names the other two under their states.
    expect(
      idsOf((await client.exportItems({ source, state: "active" })).data),
    ).toEqual([active]);
    expect(
      archiveItemIds(
        (await client.exportArchive({ source, state: "archived" })).data,
      ),
    ).toEqual([archived]);
  });

  it("carries archived rows and leaves out the bin when an archive names no state", async () => {
    const { source, active, archived } = await oneOfEachState();
    const archive = await client.exportArchive({ source });
    expect(archive.status).toBe(200);
    expect(archiveItemIds(archive.data).sort()).toEqual(
      [active, archived].sort(),
    );
  });
});

describe("the archive's contents", () => {
  const archiveOf = async (source: string): Promise<Uint8Array> => {
    const archive = await client.exportArchive({ source });
    expect(archive.status).toBe(200);
    return archive.data;
  };

  it("opens an archive with its manifest, and the manifest counts what the archive holds", async () => {
    const { writer, source } = await writerOfItsOwn("manifest");
    const bytes = new Uint8Array(Buffer.from(`manifest bytes ${ctx.runId}`));
    const upload = await writer.uploadBlob(bytes, "text/plain");
    expect(upload.ok, JSON.stringify(upload.error)).toBe(true);
    const withBlob = await noteIn(writer, source, {
      properties: { body: `![bytes](${upload.data.hash})` },
    });
    const a = await noteIn(writer, source);
    const b = await noteIn(writer, source);
    const edge = await writer.createEdge({
      source_id: a,
      target_id: b,
      edge_type: "about",
    });
    expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
    trackEdge(ctx, edge.data.edge.id);

    const archive = await archiveOf(source);
    const entries = listTarGzEntries(archive).map((e) => e.name);
    expect(entries.slice(0, 4)).toEqual([
      "manifest.json",
      "items.ndjson",
      "edges.ndjson",
      "types.ndjson",
    ]);
    expect(entries.slice(4)).toEqual([`blobs/${upload.data.hash}`]);

    const manifest = JSON.parse(
      readTarGzEntry(archive, "manifest.json") ?? "{}",
    ) as Record<string, unknown>;
    const typeLines = archiveLines(archive, "types.ndjson");
    expect(manifest).toMatchObject({
      version: 0,
      format: "marfa-archive-v0",
      item_count: 3,
      edge_count: 1,
      blob_count: 1,
      type_count: typeLines.filter((l) => "type" in l).length,
      edge_type_count: typeLines.filter((l) => "edge_type" in l).length,
      blobs: {
        [upload.data.hash]: {
          mime_type: "text/plain",
          size_bytes: bytes.length,
        },
      },
    });
    expect(archiveItemIds(archive).sort()).toEqual([withBlob, a, b].sort());
    expect(archiveLines(archive, "edges.ndjson")).toHaveLength(1);
    expect(Number.isNaN(Date.parse(String(manifest.created_at)))).toBe(false);
  });

  it("holds nothing in an archive but its manifest, items, edges, types and blobs", async () => {
    // A key, a webhook, a configuration and a tombstone all exist, so what
    // the archive does not carry is a choice it made.
    const { writer, source } = await writerOfItsOwn("scope");
    const receiver = await startReceiver();
    try {
      const hook = await client.createWebhook({
        url: receiver.hookUrl(`scope-${ctx.runId}`),
        events: ["item.created"],
      });
      expect(hook.status, JSON.stringify(hook.error)).toBe(201);
      trackWebhook(ctx, hook.data.id, client);

      const linked = `user.exportscope${ctx.runId}`;
      const registered = await client.registerType({
        id: linked,
        fields: { vendor_id: { type: "string" } },
        link_field: "vendor_id",
      });
      expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
      const purgedLink = `purged-link-${ctx.runId}`;
      const made = await writer.createItem({
        type: linked,
        source,
        properties: { vendor_id: purgedLink },
      });
      expect(made.ok, JSON.stringify(made.error)).toBe(true);
      expect((await writer.deleteItem(made.data.item.id)).ok).toBe(true);
      expect((await client.purgeItem(made.data.item.id)).ok).toBe(true);
      const tombstone = await client.lookupItems({
        type: linked,
        links: [purgedLink],
      });
      expect(tombstone.data.tombstones).toHaveLength(1);
      expect((await client.getConfig()).ok).toBe(true);
      await noteIn(writer, source);

      const archive = await client.exportArchive({ state: "any", source });
      expect(archive.status).toBe(200);
      const entries = listTarGzEntries(archive.data);
      expect(entries.map((e) => e.name).sort()).toEqual([
        "edges.ndjson",
        "items.ndjson",
        "manifest.json",
        "types.ndjson",
      ]);
      const everything = entries.map((e) => e.body.toString("utf8")).join("\n");
      for (const absent of [
        hook.data.id,
        hook.data.secret,
        receiver.hookUrl(`scope-${ctx.runId}`),
        purgedLink,
        apiKey,
      ]) {
        expect(everything, absent).not.toContain(absent);
      }
    } finally {
      await receiver.close();
    }
  });

  it("carries every registered type and edge type in an archive, whatever its selection and credential reach", async () => {
    const typeId = `user.exporttypes${ctx.runId}`;
    const edgeTypeId = `exporttypes.${ctx.runId}`;
    expect(
      (
        await client.registerType({
          id: typeId,
          fields: { label: { type: "string" } },
        })
      ).ok,
    ).toBe(true);
    const edgeType = await client.registerEdgeType({
      id: edgeTypeId,
      cardinality: "many-to-many",
    });
    expect(edgeType.ok, JSON.stringify(edgeType.error)).toBe(true);
    trackEdgeType(ctx, edgeTypeId);
    const types = await client.listTypes();
    const edgeTypes = await client.listEdgeTypes();
    expect(types.data.next_cursor).toBeNull();
    expect(edgeTypes.data.next_cursor).toBeNull();

    // A selection that holds no row of the registered type, under a key that
    // reads one type only.
    const narrow = await client.createKey({
      label: "export-types-narrow",
      source: `${ctx.source}-types-narrow`,
      permissions: [],
      type_permissions: { "core.note": "read" },
    });
    expect(narrow.ok, JSON.stringify(narrow.error)).toBe(true);
    trackKey(ctx, narrow.data.id);
    const reader = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: narrow.data.key,
    });
    const nothing = { type: "core.note", source: `no-rows-${ctx.runId}` };

    for (const credential of [client, reader]) {
      const archive = await credential.exportArchive(nothing);
      expect(archive.status).toBe(200);
      expect(archiveItemIds(archive.data)).toEqual([]);
      const lines = archiveLines<{
        type?: { id: string };
        edge_type?: { id: string };
      }>(archive.data, "types.ndjson");
      const carriedTypes = lines.flatMap((l) => (l.type ? [l.type.id] : []));
      const carriedEdgeTypes = lines.flatMap((l) =>
        l.edge_type ? [l.edge_type.id] : [],
      );
      expect(carriedTypes).toContain(typeId);
      expect(carriedEdgeTypes).toContain(edgeTypeId);
      // The build ships its own `core.` and `system.` types on every boot, so
      // what the archive carries is what was registered beside them, and the shipped
      // edge types likewise.
      for (const registered of types.data.data.filter(
        (t) => !/^(core|system)\./.test(t.id),
      )) {
        expect(carriedTypes, registered.id).toContain(registered.id);
      }
      for (const registered of edgeTypes.data.data.filter((e) => !e.shipped)) {
        expect(carriedEdgeTypes, registered.id).toContain(registered.id);
      }
      const manifest = JSON.parse(
        readTarGzEntry(archive.data, "manifest.json") ?? "{}",
      ) as { type_count: number; edge_type_count: number };
      expect(manifest.type_count).toBe(carriedTypes.length);
      expect(manifest.edge_type_count).toBe(carriedEdgeTypes.length);
    }
  });
});

describe("an archive is the selection as it stood when its headers arrived", () => {
  /**
   * Requests an archive of `source`, runs `afterHeaders` once the response has
   * begun and before any of its body is read, then reads the body. The server
   * answers only once it has read the whole selection, so what `afterHeaders`
   * writes comes after the selection and cannot be in it.
   */
  async function archiveWrittenToAfterHeaders(
    source: string,
    afterHeaders: () => Promise<void>,
  ): Promise<Uint8Array> {
    const response = await fetch(
      `${apiUrl}/export?format=archive&source=${encodeURIComponent(source)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    expect(response.status).toBe(200);
    await afterHeaders();
    return new Uint8Array(await response.arrayBuffer());
  }

  const titleOf = (archive: Uint8Array, id: string): unknown =>
    archiveLines<{ item: MarfaItem }>(archive, "items.ndjson").find(
      (line) => line.item.id === id,
    )?.item.properties.title;

  it("counts every row the archive holds in its manifest when the headers arrive", async () => {
    const { writer, source } = await writerOfItsOwn("selection");
    const a = await noteIn(writer, source);
    const b = await noteIn(writer, source);
    const edge = await writer.createEdge({
      source_id: a,
      target_id: b,
      edge_type: "about",
    });
    expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
    trackEdge(ctx, edge.data.edge.id);

    let writtenAfter = "";
    const archive = await archiveWrittenToAfterHeaders(source, async () => {
      writtenAfter = await noteIn(writer, source);
    });
    const manifest = JSON.parse(
      readTarGzEntry(archive, "manifest.json") ?? "{}",
    ) as { item_count: number; edge_count: number };
    expect(manifest.item_count).toBe(2);
    expect(manifest.edge_count).toBe(1);
    expect(archiveItemIds(archive).sort()).toEqual([a, b].sort());
    expect(archiveLines(archive, "edges.ndjson")).toHaveLength(1);
    // The witness: a later export carries the row the first one did not.
    const later = await client.exportArchive({ source });
    expect(archiveItemIds(later.data)).toContain(writtenAfter);
  });

  it("carries a row as it stood when the export read it, whatever is written to it after the headers", async () => {
    const { writer, source } = await writerOfItsOwn("as-read");
    const id = await noteIn(writer, source, {
      properties: { title: "as read", body: "before" },
    });
    const archive = await archiveWrittenToAfterHeaders(source, async () => {
      const read = await writer.getItem(id);
      const patched = await writer.updateItem(id, {
        version: read.data.item.version,
        properties: { title: "written after the headers" },
      });
      expect(patched.ok, JSON.stringify(patched.error)).toBe(true);
    });
    const [line] = archiveLines<{ item: MarfaItem }>(archive, "items.ndjson");
    expect(line?.item.id).toBe(id);
    expect(titleOf(archive, id)).toBe("as read");
    expect(line?.item.version).toBe(1);
    // The witness: the write landed, and a later export carries it.
    const later = await client.exportArchive({ source });
    expect(titleOf(later.data, id)).toBe("written after the headers");
  });

  it("does not carry an item created after the headers arrived", async () => {
    const { writer, source } = await writerOfItsOwn("created-after");
    const before = await noteIn(writer, source);
    let after = "";
    const archive = await archiveWrittenToAfterHeaders(source, async () => {
      after = await noteIn(writer, source);
    });
    expect(archiveItemIds(archive)).toEqual([before]);
    const later = await client.exportArchive({ source });
    expect(archiveItemIds(later.data).sort()).toEqual([before, after].sort());
  });

  it("carries an edge created before the export began, and not one created after its headers arrived", async () => {
    const { writer, source } = await writerOfItsOwn("edge-after");
    const a = await noteIn(writer, source);
    const b = await noteIn(writer, source);
    const early = await writer.createEdge({
      source_id: a,
      target_id: b,
      edge_type: "about",
    });
    expect(early.ok, JSON.stringify(early.error)).toBe(true);
    trackEdge(ctx, early.data.edge.id);

    let lateId = "";
    const archive = await archiveWrittenToAfterHeaders(source, async () => {
      const late = await writer.createEdge({
        source_id: b,
        target_id: a,
        edge_type: "about",
      });
      expect(late.ok, JSON.stringify(late.error)).toBe(true);
      trackEdge(ctx, late.data.edge.id);
      lateId = late.data.edge.id;
    });
    const carried = archiveLines<{ edge: MarfaEdge }>(
      archive,
      "edges.ndjson",
    ).map((line) => line.edge.id);
    expect(carried).toEqual([early.data.edge.id]);
    // The witness: both endpoints were carried, so the later edge was
    // eligible and a later export holds it.
    const later = await client.exportArchive({ source });
    expect(
      archiveLines<{ edge: MarfaEdge }>(later.data, "edges.ndjson")
        .map((line) => line.edge.id)
        .sort(),
    ).toEqual([early.data.edge.id, lateId].sort());
  });
});
