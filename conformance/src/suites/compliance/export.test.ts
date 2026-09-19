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
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { createNote, createBookmark } from "../../generators/items.js";

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
