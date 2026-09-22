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
  cleanup,
} from "../../utils/setup.js";
import { createNote, createBookmark } from "../../generators/items.js";
import { readTarGzEntry } from "../../utils/archive.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext("compliance", "export"));
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
      // Its own source, not the writer's: a display name belongs to one
      // credential, and what this key exports is chosen by the `source`
      // filter rather than by the source it writes under.
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
    // page is fetched, so a bound the store refuses used to arrive after the
    // response had begun: the caller was handed an empty body with a success
    // status, which is an export narrowed by a filter nobody could read and
    // written to a file they believe is a slice. The archive format of the
    // same door, with the same query schema, refused it. The control is the
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
