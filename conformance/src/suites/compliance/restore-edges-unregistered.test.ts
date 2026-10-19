import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { v7 as uuidv7 } from "uuid";
import { listTarGzEntries, tarGz } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * A real round trip on throwaway servers: the archive is exported from an
 * instance that force-deleted an edge type while edges of it stood, restored
 * into a fresh one, and the edges the second instance holds are compared with
 * the first's. The state is the instance's own, made through the HTTP API
 * alone: a registration, edges, and `DELETE /edge-types/{id}?force=true`.
 */
let origin: FreshServer;
let destination: FreshServer;
let third: FreshServer;
beforeEach(async () => {
  [origin, destination, third] = await Promise.all([
    bootFreshServer("edges-unregistered-origin"),
    bootFreshServer("edges-unregistered-destination"),
    bootFreshServer("edges-unregistered-third"),
  ]);
}, 3 * FRESH_SERVER_TIMEOUT_MS);
afterEach(async () => {
  await Promise.all([origin?.stop(), destination?.stop(), third?.stop()]);
}, FRESH_SERVER_TIMEOUT_MS);

const working = (server: FreshServer) =>
  new MarfaClient({ baseUrl: server.apiUrl, apiKey: server.workingKey });
const owner = (server: FreshServer) =>
  new MarfaClient({ baseUrl: server.apiUrl, ownerCookie: server.ownerCookie });

/** The archive with one member replaced, every other as it was. */
function withEntry(archive: Uint8Array, name: string, body: string) {
  return tarGz(
    listTarGzEntries(archive).map((entry) => ({
      name: entry.name,
      body: entry.name === name ? body : entry.body,
    })),
  );
}

async function archiveOf(client: MarfaClient) {
  const exported = await client.exportArchive({ state: "any" });
  expect(
    exported.status,
    Buffer.from(exported.data).toString().slice(0, 500),
  ).toBe(200);
  return exported.data;
}

/** Every edge an instance holds, whole, in id order. */
async function edgesOf(client: MarfaClient) {
  const listed = await client.listEdges({ limit: 200 });
  expect(listed.status, JSON.stringify(listed.error)).toBe(200);
  expect(listed.data.next_cursor).toBeNull();
  return [...listed.data.data].sort((a, b) => a.id.localeCompare(b.id));
}

describe("a restore of an edge whose type was force-deleted", () => {
  it("keeps the edge as the archive holds it, reads it as the origin does, and restores its own export again", async () => {
    const source = working(origin);
    const kept = "user.retired-cascade";
    const blocking = "user.retired-block";
    for (const [id, cascade] of [
      [kept, "cascade"],
      [blocking, "block"],
    ] as const) {
      const registered = await source.registerEdgeType({
        id,
        cardinality: "many-to-many",
        cascade_on_delete: cascade,
      });
      expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    }
    const notes = [];
    for (const body of ["first", "second", "third"]) {
      const made = await source.createItem({
        type: "core.note",
        properties: { body },
      });
      expect(made.status, JSON.stringify(made.error)).toBe(201);
      notes.push(made.data.item.id);
    }
    const [a, b, c] = notes as [string, string, string];
    const links: [string, string, string][] = [
      [a, b, kept],
      [c, a, blocking],
      [a, c, "references"],
    ];
    for (const [source_id, target_id, edge_type] of links) {
      const made = await source.createEdge({
        source_id,
        target_id,
        edge_type,
        properties: edge_type === kept ? { weight: "heavy" } : {},
      });
      expect(made.status, JSON.stringify(made.error)).toBe(201);
    }
    // An edit moves one edge past version 1, which the restore must carry.
    const [firstEdge] = (await edgesOf(source)).filter(
      (edge) => edge.edge_type === kept,
    );
    expect(
      (
        await source.updateEdge(firstEdge!.id, {
          version: 1,
          properties: { weight: "light" },
        })
      ).status,
    ).toBe(200);

    // The witness: while the types are registered the delete is refused, and
    // forcing it leaves the edges naming a type the instance no longer holds.
    expect((await source.deleteEdgeType(kept)).status).toBe(409);
    for (const id of [kept, blocking])
      expect((await source.deleteEdgeType(id, true)).status).toBe(200);
    const typeIds = (await source.listEdgeTypes()).data.data.map((t) => t.id);
    expect(typeIds).not.toContain(kept);
    expect(typeIds).not.toContain(blocking);

    // The export succeeds, carries the edges and not the types.
    const exported = await archiveOf(source);
    const members = listTarGzEntries(exported);
    const edgeLines = members
      .find((m) => m.name === "edges.ndjson")!
      .body.toString();
    expect(edgeLines).toContain(`"edge_type":"${kept}"`);
    expect(edgeLines).toContain(`"edge_type":"${blocking}"`);
    const typeLines = members
      .find((m) => m.name === "types.ndjson")!
      .body.toString();
    expect(typeLines).not.toContain(kept);
    expect(typeLines).not.toContain(blocking);

    const restored = await owner(destination).restoreArchive(exported);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data).toMatchObject({
      imported: 3,
      edges_imported: 3,
      edges_skipped: 0,
      edge_types_registered: 0,
    });

    // The destination holds the edges the origin holds, to the version and
    // the date, and still registers neither type.
    const reader = working(destination);
    const before = await edgesOf(source);
    expect(before).toHaveLength(3);
    expect(await edgesOf(reader)).toEqual(before);
    const registered = (await reader.listEdgeTypes()).data.data.map(
      (t) => t.id,
    );
    expect(registered).not.toContain(kept);
    expect(registered).not.toContain(blocking);
    expect(before.find((edge) => edge.edge_type === kept)).toMatchObject({
      properties: { weight: "light" },
      version: 2,
    });

    // The reads the origin serves, the destination serves
    // (`edges/orphan-read`).
    for (const client of [source, reader]) {
      expect(
        (await client.getEdge(firstEdge!.id)).data.edge.edge_type,
        "get",
      ).toBe(kept);
      expect(
        (await client.listEdges({ edge_type: kept })).data.data.map(
          (edge) => edge.id,
        ),
        "list by type",
      ).toEqual([firstEdge!.id]);
      expect(
        (await client.listItemEdges(a, { edge_type: kept })).data.data.map(
          (edge) => edge.id,
        ),
        "from the source",
      ).toEqual([firstEdge!.id]);
      expect(
        (await client.listItemBackrefs(b, { edge_type: kept })).data.data.map(
          (edge) => edge.id,
        ),
        "to the target",
      ).toEqual([firstEdge!.id]);
      const hydrated = await client.getItem(a);
      expect(
        hydrated.data.item.edges?.[kept]?.data.map((edge) => edge.id),
        "inline",
      ).toEqual([firstEdge!.id]);
    }

    // Nothing of an unregistered type cascades or blocks
    // (`edges/orphan-delete`): the bin takes the first note on both
    // instances, which a registered `block` edge would refuse, and the second
    // note stays, which a registered `cascade` edge would not allow.
    for (const client of [source, reader]) {
      expect((await client.deleteItem(a)).status, "trash").toBe(200);
      expect((await client.getItem(b)).data.item.state, "kept").toBe("active");
      expect((await client.getItem(c)).data.item.state, "kept").toBe("active");
    }
    expect(await edgesOf(reader)).toEqual(await edgesOf(source));

    // The edge's type stays unregistered for ordinary writes.
    const refused = await reader.createEdge({
      source_id: b,
      target_id: c,
      edge_type: kept,
    });
    expect(refused.status).toBe(404);
    expect(refused.error?.error.code).toBe("edge_type_not_found");

    // A second generation: what was restored exports and restores again.
    const second = await archiveOf(reader);
    const restoredAgain = await owner(third).restoreArchive(second);
    expect(restoredAgain.status, JSON.stringify(restoredAgain.error)).toBe(200);
    expect(restoredAgain.data).toMatchObject({
      edges_imported: 3,
      edges_skipped: 0,
    });
    expect(await edgesOf(working(third))).toEqual(await edgesOf(reader));
  }, 180_000);

  it("judges an edge of an unregistered type by what needs no edge type, still holds a registered one to its constraints, and refuses an edge whose type is no identifier", async () => {
    const source = working(origin);
    const type = "user.bound-link";
    expect(
      (
        await source.registerEdgeType({
          id: type,
          cardinality: "one-to-one",
          source_type_constraints: ["core.note"],
        })
      ).status,
    ).toBe(201);
    const ids = [];
    for (const body of ["one", "two", "three"]) {
      const made = await source.createItem({
        type: "core.note",
        properties: { body },
      });
      ids.push(made.data.item.id);
    }
    const [x, y, z] = ids as [string, string, string];
    expect(
      (await source.createEdge({ source_id: x, target_id: y, edge_type: type }))
        .status,
    ).toBe(201);
    const exported = await archiveOf(source);
    const lineOf = (edge_type: string) =>
      `${JSON.stringify({
        edge: {
          id: uuidv7(),
          source_id: x,
          target_id: z,
          edge_type,
          properties: {},
        },
      })}\n`;
    const carrying = (extra: string) =>
      withEntry(
        exported,
        "edges.ndjson",
        listTarGzEntries(exported)
          .find((m) => m.name === "edges.ndjson")!
          .body.toString() + extra,
      );

    // A second edge out of the same source breaks the one-to-one the archive
    // itself registers, so it is skipped and the first stays. Beside it, edges
    // of an unregistered type are judged by what needs no edge type: the first
    // `x -> z` is kept, and its second copy, a loop and an edge to an item the
    // archive does not carry are skipped.
    const gone = "user.gone-link";
    const line = (source_id: string, target_id: string, edge_type: string) =>
      `${JSON.stringify({
        edge: { id: uuidv7(), source_id, target_id, edge_type, properties: {} },
      })}\n`;
    const reader = working(destination);
    const crowded = await owner(destination).restoreArchive(
      carrying(
        lineOf(type) +
          line(x, x, gone) +
          line(x, z, gone) +
          line(x, z, gone) +
          line(y, uuidv7(), gone),
      ),
    );
    expect(crowded.status, JSON.stringify(crowded.error)).toBe(200);
    expect(crowded.data).toMatchObject({
      edges_imported: 2,
      edges_skipped: 4,
      edges_skipped_reasons: {
        edge_constraint_violation: 2,
        edge_cycle: 1,
        endpoint_missing: 1,
      },
    });
    expect(crowded.data.edges_skipped_reasons).toEqual({
      edge_constraint_violation: 2,
      edge_cycle: 1,
      endpoint_missing: 1,
    });
    const held = await edgesOf(reader);
    expect(held.map((edge) => [edge.edge_type, edge.source_id])).toEqual(
      expect.arrayContaining([
        [type, x],
        [gone, x],
      ]),
    );
    expect(held).toHaveLength(2);
    expect(held.find((edge) => edge.edge_type === gone)).toMatchObject({
      target_id: z,
    });

    // An edge whose type no instance could have registered is no archive an
    // instance wrote (`search-and-filters/restore-edge-type`).
    const refused = await owner(third).restoreArchive(
      carrying(lineOf("Not An Edge Type")),
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(await edgesOf(working(third))).toEqual([]);
    expect((await working(third).getItem(x)).status).toBe(404);
  }, 180_000);
});
