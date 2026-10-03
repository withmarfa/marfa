/**
 * The round trip that matters: export a slice of the dataset, hard-purge it,
 * restore the archive, and get the same content back — items under their
 * original ids, tags, extensions, and the edges between them. The sibling
 * admin-archive suite proves the archive format is accepted; this one proves
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
  getOperatorClient,
  trackItem,
  trackEdge,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";

let client: MarfaClient;
/** The operator key's client, for the restore half alone. */
let operator: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  const setup = await createTestContext("compliance", "export-roundtrip");
  ({ ctx, client } = setup);
  operator = getOperatorClient();
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

    const restored = await operator.restoreArchive(archive.data);
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

    const restored = await operator.restoreArchive(archive.data);
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
});
