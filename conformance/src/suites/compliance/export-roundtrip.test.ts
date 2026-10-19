/**
 * The round trip that matters: export a slice of the dataset, hard-purge it,
 * restore the archive, and get the same content back — items under their
 * original ids, tags, extensions, and the edges between them. The sibling
 * restore-archive suite proves the archive format is accepted; this one proves
 * a restore actually reconstructs what an export claims to carry, which is
 * the property a backup exists for.
 *
 * Scoped to this file's credential-stamped `source` throughout, so other
 * files' rows never enter the archive.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  getOwnerClient,
  trackItem,
  trackEdge,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";

let client: MarfaClient;
/** The direct owner's client, for the restore half alone. */
let owner: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  const setup = await createTestContext("compliance", "export-roundtrip");
  ({ ctx, client } = setup);
  owner = getOwnerClient();
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("export → purge → restore round trip", () => {
  it("reconstructs items with their ids, tags, and extensions", async () => {
    const seeded = await client.createItem(
      createNote({
        source: ctx.source,
        source_id: `rt-meta-${ctx.runId}`,
        tags: ["rt-alpha", "rt-beta"],
      }),
    );
    expect(seeded.ok).toBe(true);
    const itemId = seeded.data.item.id;
    trackItem(ctx, itemId);

    const ext = await client.setItemExtension(itemId, "conformance.roundtrip", {
      checked: true,
      label: "kept",
    });
    expect(ext.ok).toBe(true);

    const changed = await client.updateItem(itemId, {
      version: seeded.data.item.version,
      properties: { body: "The version kept in the archive" },
    });
    expect(changed.ok).toBe(true);
    const archivedItem = await client.getItem(itemId);
    expect(archivedItem.ok).toBe(true);
    const history = await client.getVersions(itemId);
    expect(history.ok).toBe(true);
    expect(history.data.data).toHaveLength(1);

    const archive = await client.exportArchive({ source: ctx.source });
    expect(archive.ok).toBe(true);
    expect(archive.data.byteLength).toBeGreaterThan(0);

    // Purge is a hard delete of a trashed row, so trash first.
    const trashed = await client.deleteItem(itemId);
    expect(trashed.ok).toBe(true);
    const purged = await client.purgeItem(itemId);
    expect(purged.ok).toBe(true);
    const gone = await client.getItem(itemId);
    expect(gone.status).toBe(404);

    const restored = await owner.restoreArchive(archive.data);
    expect(restored.ok).toBe(true);
    expect(restored.data.imported).toBeGreaterThanOrEqual(1);

    // The original id resolves again — restore preserved it — and the
    // metadata came back with the item rather than being dropped.
    const back = await client.getItem(itemId);
    expect(back.ok).toBe(true);
    expect(back.data.item).toEqual(archivedItem.data.item);
    const restoredHistory = await client.getVersions(itemId);
    expect(restoredHistory.ok).toBe(true);
    expect(restoredHistory.data).toEqual(history.data);
    expect(back.data.item.type).toBe("core.note");
    expect(back.data.item.source_id).toBe(`rt-meta-${ctx.runId}`);
    expect([...back.data.metadata.tags].sort()).toEqual([
      "rt-alpha",
      "rt-beta",
    ]);
    expect(back.data.metadata.extensions?.["conformance.roundtrip"]).toEqual({
      checked: true,
      label: "kept",
    });
  });

  it("reconstructs edges between restored items, in both directions", async () => {
    const a = await client.createItem(
      createNote({ source: ctx.source, source_id: `rt-edge-a-${ctx.runId}` }),
    );
    const b = await client.createItem(
      createNote({ source: ctx.source, source_id: `rt-edge-b-${ctx.runId}` }),
    );
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    trackItem(ctx, a.data.item.id);
    trackItem(ctx, b.data.item.id);

    const edge = await client.createEdge({
      source_id: a.data.item.id,
      target_id: b.data.item.id,
      edge_type: "references",
      properties: { context: "round trip" },
    });
    expect(edge.ok).toBe(true);
    const edgeId = edge.data.edge.id;
    trackEdge(ctx, edgeId);

    const archive = await client.exportArchive({ source: ctx.source });
    expect(archive.ok).toBe(true);

    // Purging both endpoints drops the edge with them; the restore has
    // to bring back all three or the archive did not carry the graph.
    for (const id of [a.data.item.id, b.data.item.id]) {
      const trashed = await client.deleteItem(id);
      expect(trashed.ok).toBe(true);
      const purged = await client.purgeItem(id);
      expect(purged.ok).toBe(true);
    }

    const restored = await owner.restoreArchive(archive.data);
    expect(restored.ok).toBe(true);
    expect(restored.data.imported).toBeGreaterThanOrEqual(2);
    expect(restored.data.edges_imported).toBeGreaterThanOrEqual(1);
    expect(restored.data.edges_skipped).toBe(0);

    const outbound = await client.listItemEdges(a.data.item.id, {
      edge_type: "references",
    });
    expect(outbound.ok).toBe(true);
    const forward = outbound.data.data.find((e) => e.id === edgeId);
    expect(forward).toEqual(edge.data.edge);
    expect(forward?.target_id).toBe(b.data.item.id);
    expect(forward?.properties).toEqual({ context: "round trip" });

    const inbound = await client.listItemBackrefs(b.data.item.id, {
      edge_type: "references",
    });
    expect(inbound.ok).toBe(true);
    expect(inbound.data.data.some((e) => e.id === edgeId)).toBe(true);
  });

  it("reconstructs the edges of an item in the bin, in both directions", async () => {
    const ids: string[] = [];
    for (const name of ["before", "binned", "after"]) {
      const created = await client.createItem(
        createNote({
          source: ctx.source,
          source_id: `rt-bin-${name}-${ctx.runId}`,
        }),
      );
      expect(created.ok).toBe(true);
      trackItem(ctx, created.data.item.id);
      ids.push(created.data.item.id);
    }
    const [before, binned, after] = ids as [string, string, string];

    const edges = [];
    for (const [from, to] of [
      [before, binned],
      [binned, after],
    ] as const) {
      const created = await client.createEdge({
        source_id: from,
        target_id: to,
        edge_type: "references",
        properties: { context: `bin round trip from ${from}` },
      });
      expect(created.ok).toBe(true);
      trackEdge(ctx, created.data.edge.id);
      edges.push(created.data.edge);
    }

    expect((await client.deleteItem(binned)).ok).toBe(true);
    const archive = await client.exportArchive({
      source: ctx.source,
      state: "any",
    });
    expect(archive.ok).toBe(true);

    for (const id of [before, after]) {
      expect((await client.deleteItem(id)).ok).toBe(true);
    }
    for (const id of ids) {
      expect((await client.purgeItem(id)).ok).toBe(true);
    }
    for (const edge of edges) {
      expect((await client.getEdge(edge.id)).status).toBe(404);
    }

    const restored = await owner.restoreArchive(archive.data);
    expect(restored.ok).toBe(true);
    // The archive also carries this file's other rows, which earlier tests
    // left restored, so their edges come back as already present.
    expect(
      Object.keys(restored.data.edges_skipped_reasons).filter(
        (reason) => reason !== "already_present",
      ),
    ).toEqual([]);
    expect(restored.data.edges_imported).toBeGreaterThanOrEqual(2);
    expect((await client.getItem(binned)).status).toBe(404);

    for (const edge of edges) {
      const read = await client.getEdge(edge.id);
      expect(read.status, edge.id).toBe(200);
      expect(read.data.edge).toEqual(edge);
    }
    const outbound = await client.listItemEdges(binned);
    expect(outbound.data.data.map((e) => e.id)).toEqual([edges[1]!.id]);
    const inbound = await client.listItemBackrefs(binned);
    expect(inbound.data.data.map((e) => e.id)).toEqual([edges[0]!.id]);

    // Out of the bin, the item has the edges it held there.
    expect((await client.restoreItem(binned)).ok).toBe(true);
    for (const edge of edges) {
      const read = await client.getEdge(edge.id);
      expect(read.status, edge.id).toBe(200);
      expect(read.data.edge).toEqual(edge);
    }
  });
});
