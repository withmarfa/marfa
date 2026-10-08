import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import { TEST_OWNER } from "../../utils/target.js";
import { itemsArchive, listTarGzEntries, tarGz } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { clientsFor } from "../../utils/own-blob-server.js";

/**
 * What a restore does with the size of an archive, on servers of the fixture's
 * own. The counts of a restore are held by no limit but the instance's; the
 * size of one row is held to what the write doors take, which is a setting
 * the shared server cannot change for every other file.
 */
const SMALL_CAP = 8192;

function ownerFor(server: FreshServer): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    ownerCookie: server.ownerCookie,
    ownerCredentials: TEST_OWNER,
    ownerSessionFile: `${server.stateDir}/owner-session.json`,
  });
}

let source: FreshServer | undefined;
let target: FreshServer | undefined;
let capped: FreshServer | undefined;

beforeAll(async () => {
  [source, target, capped] = await Promise.all([
    bootFreshServer("archive-counts-source"),
    bootFreshServer("archive-counts-target"),
    bootFreshServer("archive-row-cap", {
      MARFA_MAX_BULK_REQUEST_BYTES: String(SMALL_CAP),
    }),
  ]);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(stopFreshServers, FRESH_SERVER_TIMEOUT_MS);

describe("the counts an archive carries", () => {
  it(
    "restores an archive of more than 5,000 items, 20,000 edges, 200 types and 200 edge types, as one the same build wrote",
    async () => {
      const items = 5_001;
      const { working } = clientsFor(source!);
      const owner = ownerFor(target!);

      // One more than each round number a limit might once have sat at.
      const types = 201;
      for (let from = 0; from < types; from += 25) {
        await Promise.all(
          Array.from({ length: Math.min(25, types - from) }, async (_, at) => {
            const n = from + at;
            const type = await working.registerType({
              id: `user.counts${String(n)}`,
              fields: { label: { type: "string" } },
            });
            expect(type.status, JSON.stringify(type.error)).toBe(201);
            const edgeType = await working.registerEdgeType({
              id: `counts.edge${String(n)}`,
              cardinality: "many-to-many",
            });
            expect(edgeType.status, JSON.stringify(edgeType.error)).toBe(201);
          }),
        );
      }

      const ids: string[] = [];
      for (let from = 0; from < items; from += 5_000) {
        const page = await working.bulkItems({
          items: Array.from(
            { length: Math.min(5_000, items - from) },
            (_, at) => ({
              type: "core.note",
              properties: { body: `counted ${String(from + at)}` },
            }),
          ),
        });
        expect(page.status, JSON.stringify(page.error)).toBe(200);
        for (const entry of page.data.results) {
          expect(entry.outcome, JSON.stringify(entry)).toBe("created");
          ids.push(entry.id!);
        }
      }
      expect(ids).toHaveLength(items);

      const wanted = 20_001;
      const edges = Array.from({ length: 4 }, (_, k) =>
        ids.map((id, at) => ({
          source_id: id,
          target_id: ids[(at + k + 1) % items]!,
          edge_type: "about",
        })),
      )
        .flat()
        .slice(0, wanted);
      for (let from = 0; from < edges.length; from += 5_000) {
        const page = await working.bulkEdges({
          edges: edges.slice(from, from + 5_000),
        });
        expect(page.status, JSON.stringify(page.error)).toBe(200);
      }

      const archive = await working.exportArchive({ type: "core.note" });
      expect(archive.status).toBe(200);
      const restored = await owner.restoreArchive(archive.data);
      expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
      expect(restored.data).toMatchObject({
        imported: items,
        duplicates: 0,
        edges_imported: wanted,
        edges_skipped: 0,
        types_registered: types,
        edge_types_registered: types,
      });
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("the size of a row an archive carries", () => {
  type Oversized = "item" | "version" | "edge";

  /** Properties that are exactly `bytes` bytes of JSON. */
  const propertiesOf = (bytes: number): Record<string, unknown> => ({
    body: "x".repeat(bytes - `{"body":""}`.length),
  });

  const SOURCE = "archive-row-cap";

  /** A row ahead, and a second row, one of whose kinds of properties is `bytes`. */
  function archiveOf(kind: Oversized, bytes: number) {
    const first = uuidv7();
    const second = uuidv7();
    const edge = uuidv7();
    const ordinary = { body: "an ordinary row" };
    const row = (id: string, extra: Record<string, unknown>) =>
      JSON.stringify({
        item: {
          id,
          type: "core.note",
          source: SOURCE,
          properties: ordinary,
          ...extra,
        },
        metadata: { tags: [], extensions: {} },
        ...(extra.version === 2 && {
          versions: [
            {
              id: uuidv7(),
              item_id: id,
              version: 1,
              properties: propertiesOf(bytes),
              type: "core.note",
              tier: "library",
              occurred_at: "2030-01-01T00:00:00.000Z",
              source_id: null,
              created_at: "2030-01-01T00:00:00.000Z",
            },
          ],
        }),
      });
    const lines = [
      row(first, {}),
      row(
        second,
        kind === "item"
          ? { properties: propertiesOf(bytes) }
          : kind === "version"
            ? { version: 2 }
            : {},
      ),
    ];
    const edges =
      kind === "edge"
        ? `${JSON.stringify({
            edge: {
              id: edge,
              source_id: first,
              target_id: second,
              edge_type: "about",
              properties: propertiesOf(bytes),
            },
          })}\n`
        : "";
    const archive = tarGz(
      listTarGzEntries(itemsArchive([])).map((entry) => {
        if (entry.name === "items.ndjson") {
          return {
            name: entry.name,
            body: lines.map((l) => `${l}\n`).join(""),
          };
        }
        return {
          name: entry.name,
          body: entry.name === "edges.ndjson" ? edges : entry.body,
        };
      }),
    );
    return { archive, first, second, edge };
  }

  it.each([
    ["an item's properties", "item", "properties", "item_id", 2],
    [
      "the properties of an earlier version",
      "version",
      "versions.0.properties",
      "item_id",
      2,
    ],
    ["an edge's properties", "edge", "properties", "edge_id", 1],
  ] as const)(
    "takes %s of exactly the bulk write cap and refuses one byte more, 413 naming the row and the field, and writes nothing",
    async (_what, kind, field, idField, row) => {
      const { working } = clientsFor(capped!);
      const owner = ownerFor(capped!);

      // The witness: at the cap, both rows restore.
      const atCap = archiveOf(kind, SMALL_CAP);
      const taken = await owner.restoreArchive(atCap.archive);
      expect(taken.ok, JSON.stringify(taken.error)).toBe(true);
      expect(taken.data.imported).toBe(2);
      expect((await working.getItem(atCap.second)).status).toBe(200);

      const over = archiveOf(kind, SMALL_CAP + 1);
      const refused = await owner.restoreArchive(over.archive);
      expect(refused.status, JSON.stringify(refused.error)).toBe(413);
      expect(refused.error?.error.code).toBe("request_too_large");
      expect(refused.error?.error.details).toMatchObject({
        [idField]: kind === "edge" ? over.edge : over.second,
        row,
        field,
        limit_bytes: SMALL_CAP,
      });
      expect((await working.getItem(over.first)).status).toBe(404);
      expect((await working.getItem(over.second)).status).toBe(404);
    },
  );
});
