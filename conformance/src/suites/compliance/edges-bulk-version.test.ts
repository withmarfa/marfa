/**
 * `POST /edges/bulk` entries that match a held edge and name its version.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackEdge,
  trackEdgeType,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { createBookmark, createNote } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "edges-bulk-version",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function note(): Promise<string> {
  const r = await client.createItem(createNote({ source: ctx.source }));
  expect(r.status).toBe(201);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

/** An `about` edge edited once, so it stands at version 2 and 1 is stale. */
async function editedEdge() {
  const source = await note();
  const target = await note();
  const made = await client.createEdge({
    source_id: source,
    target_id: target,
    edge_type: "about",
    properties: { weight: 1 },
  });
  expect(made.status).toBe(201);
  trackEdge(ctx, made.data.edge.id);
  const edited = await client.updateEdge(made.data.edge.id, {
    version: made.data.edge.version,
    properties: { weight: 2 },
  });
  expect(edited.status).toBe(200);
  expect(edited.data.edge.version).toBe(made.data.edge.version + 1);
  return {
    source,
    target,
    edge: edited.data.edge,
    staleVersion: made.data.edge.version,
  };
}

describe("edges.bulk with a version on an entry that matches a held edge", () => {
  it("reports a stale version as errored with version_conflict under atomic false", async () => {
    const { source, target, edge, staleVersion } = await editedEdge();
    const other = await note();

    const res = await client.bulkEdges({
      atomic: false,
      edges: [
        {
          source_id: source,
          target_id: target,
          edge_type: "about",
          properties: { weight: 99 },
          version: staleVersion,
        },
        { source_id: source, target_id: other, edge_type: "about" },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.data.counts).toMatchObject({ errored: 1, created: 1 });
    expect(res.data.results[0]).toMatchObject({
      index: 0,
      outcome: "errored",
      id: edge.id,
      error: { code: "version_conflict" },
    });
    // Its neighbor in the page still lands.
    expect(res.data.results[1]?.outcome).toBe("created");
    trackEdge(ctx, res.data.results[1]!.id!);

    const read = await client.getEdge(edge.id);
    expect(read.data.edge.properties).toEqual({ weight: 2 });
    expect(read.data.edge.version).toBe(edge.version);
  });

  it("rolls the page back with a 409 whose details.code is version_conflict under atomic true", async () => {
    const { source, target, edge, staleVersion } = await editedEdge();
    const other = await note();

    const res = await client.bulkEdges({
      atomic: true,
      edges: [
        { source_id: source, target_id: other, edge_type: "about" },
        {
          source_id: source,
          target_id: target,
          edge_type: "about",
          properties: { weight: 99 },
          version: staleVersion,
        },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.error?.error.code).toBe("bulk_atomic_rollback");
    expect(res.error?.error.details).toMatchObject({
      code: "version_conflict",
      index: 1,
    });

    // Nothing was written: the held edge stands and the entry before it was undone.
    const read = await client.getEdge(edge.id);
    expect(read.data.edge.properties).toEqual({ weight: 2 });
    expect(read.data.edge.version).toBe(edge.version);
    const held = await client.listItemEdges(source, { edge_type: "about" });
    expect(held.data.data.map((e) => e.id)).toEqual([edge.id]);
  });

  it("updates an entry that names the current version", async () => {
    const { source, target, edge } = await editedEdge();

    for (const atomic of [true, false]) {
      const current = (await client.getEdge(edge.id)).data.edge;
      const res = await client.bulkEdges({
        atomic,
        edges: [
          {
            source_id: source,
            target_id: target,
            edge_type: "about",
            properties: { weight: current.version * 10 },
            version: current.version,
          },
        ],
      });
      expect(res.status, `atomic ${String(atomic)}`).toBe(200);
      expect(res.data.results[0]).toMatchObject({
        outcome: "updated",
        id: edge.id,
      });

      const read = (await client.getEdge(edge.id)).data.edge;
      expect(read.properties).toEqual({ weight: current.version * 10 });
      expect(read.version).toBe(current.version + 1);
    }
  });

  it("answers updated for an entry whose triple an edge of a force-deleted type holds", async () => {
    const edgeType = `mock.bulk-version.${ctx.runId}`;
    const registered = await client.registerEdgeType({
      id: edgeType,
      cardinality: "many-to-many",
    });
    expect(registered.status).toBe(201);
    trackEdgeType(ctx, edgeType);
    const source = await note();
    const target = await note();
    const made = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: edgeType,
      properties: { weight: 1 },
    });
    expect(made.status).toBe(201);
    trackEdge(ctx, made.data.edge.id);
    expect((await client.deleteEdgeType(edgeType, true)).status).toBe(200);

    // The witness: the type is gone, so a triple no edge holds is refused.
    const unheld = await client.bulkEdges({
      atomic: false,
      edges: [
        { source_id: source, target_id: await note(), edge_type: edgeType },
      ],
    });
    expect(unheld.status).toBe(200);
    expect(unheld.data.results[0]).toMatchObject({
      outcome: "errored",
      error: { code: "edge_type_not_found" },
    });

    const res = await client.bulkEdges({
      edges: [
        {
          source_id: source,
          target_id: target,
          edge_type: edgeType,
          properties: { weight: 2 },
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.data.results[0]).toMatchObject({
      outcome: "updated",
      id: made.data.edge.id,
    });
    const read = await client.getEdge(made.data.edge.id);
    expect(read.data.edge.properties).toEqual({ weight: 2 });
  });
});

describe("edges.bulk with a stale version beside other refusals and modes", () => {
  it("refuses an atomic page for an entry the key may not write before a stale entry ahead of it", async () => {
    const { source, target, staleVersion } = await editedEdge();
    const minted = await client.createKey({
      label: "edges-bulk-gates-first",
      source: `${ctx.source}-gates-first`,
      permissions: [],
      type_permissions: { "core.note": "write", "core.bookmark": "read" },
      edge_permissions: { about: "write" },
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    const writer = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });
    const stale = {
      source_id: source,
      target_id: target,
      edge_type: "about",
      properties: { weight: 99 },
      version: staleVersion,
    };

    // The witness: alone, the stale entry rolls the page back for its version.
    const alone = await writer.bulkEdges({ atomic: true, edges: [stale] });
    expect(alone.status).toBe(409);
    expect(alone.error?.error.code).toBe("bulk_atomic_rollback");
    expect(alone.error?.error.details).toMatchObject({
      code: "version_conflict",
      index: 0,
    });

    const bookmark = await client.createItem(
      createBookmark({ source: ctx.source }),
    );
    expect(bookmark.status).toBe(201);
    trackItem(ctx, bookmark.data.item.id);
    const refusals = [
      {
        label: "an edge type the key may not write",
        entry: {
          source_id: source,
          target_id: target,
          edge_type: "references",
        },
        code: "edge_permission_denied",
      },
      {
        label: "a source whose type the key may not write",
        entry: {
          source_id: bookmark.data.item.id,
          target_id: target,
          edge_type: "about",
        },
        code: "type_not_permitted",
      },
    ];
    for (const { label, entry, code } of refusals) {
      const res = await writer.bulkEdges({
        atomic: true,
        edges: [stale, entry],
      });
      expect(res.status, label).toBe(403);
      expect(res.error?.error.code, label).toBe("bulk_atomic_rollback");
      expect(res.error?.error.details, label).toMatchObject({
        code,
        index: 1,
      });
    }
  });

  it("skips an entry naming a held triple as duplicate_edge under create_only, whatever version it names", async () => {
    const { source, target, edge, staleVersion } = await editedEdge();
    const entry = {
      source_id: source,
      target_id: target,
      edge_type: "about",
      properties: { weight: 99 },
    };

    // The witness: under upsert, the same stale entry is refused for its version.
    const upsert = await client.bulkEdges({
      mode: "upsert",
      atomic: false,
      edges: [{ ...entry, version: staleVersion }],
    });
    expect(upsert.status).toBe(200);
    expect(upsert.data.results[0]).toMatchObject({
      outcome: "errored",
      error: { code: "version_conflict" },
    });

    for (const atomic of [true, false]) {
      for (const version of [staleVersion, edge.version, edge.version + 7]) {
        const res = await client.bulkEdges({
          mode: "create_only",
          atomic,
          edges: [{ ...entry, version }],
        });
        const label = `atomic ${String(atomic)}, version ${String(version)}`;
        expect(res.status, label).toBe(200);
        expect(res.data.results[0], label).toMatchObject({
          outcome: "skipped",
          id: edge.id,
          reason: "duplicate_edge",
        });
      }
    }

    const read = await client.getEdge(edge.id);
    expect(read.data.edge.properties).toEqual({ weight: 2 });
    expect(read.data.edge.version).toBe(edge.version);
  });
});
