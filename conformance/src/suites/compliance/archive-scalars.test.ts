import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  blobHash,
  itemsArchive,
  readTarGzEntry,
  tarGz,
} from "../../utils/archive.js";
import {
  cleanup,
  createTestContext,
  getOwnerClient,
  trackEdge,
  trackItem,
  trackType,
} from "../../utils/setup.js";

let client: MarfaClient;
let owner: MarfaClient;
let ctx: TestContext;
beforeAll(async () => {
  ({ client, ctx } = await createTestContext("compliance", "archive-scalars"));
  owner = getOwnerClient();
});
afterAll(async () => {
  await cleanup(ctx);
});

function fixture() {
  const first = uuidv7();
  const last = uuidv7();
  const edgeId = uuidv7();
  const typeId = `user.archive_scalar_${first.replaceAll("-", "")}`;
  const data = new Uint8Array(randomBytes(32));
  const hash = blobHash(data);
  const rows: Record<string, unknown>[] = [first, last].map((id) => ({
    id,
    type: "core.note",
    source: ctx.source,
    properties: { body: "Archived scalar", blob_ref: hash },
    version: 7,
    tier: "feed",
  }));
  const edge: Record<string, unknown> = {
    id: edgeId,
    source_id: first,
    target_id: last,
    edge_type: "references",
    version: 9,
  };
  const archive = () => {
    const base = itemsArchive(
      rows as unknown as Parameters<typeof itemsArchive>[0],
      [{ data, mime_type: "text/plain" }],
      [{ id: typeId, label: "Archive scalar", version: 1, fields: {} }],
    );
    const entry = (name: string) => {
      const body = readTarGzEntry(base, name);
      if (body === null) throw new Error(`Missing archive entry ${name}`);
      return body;
    };
    return tarGz([
      {
        name: "manifest.json",
        body: JSON.stringify({
          ...JSON.parse(entry("manifest.json")),
          edge_count: 1,
        }),
      },
      { name: "types.ndjson", body: entry("types.ndjson") },
      { name: `blobs/${hash}`, body: data },
      { name: "items.ndjson", body: entry("items.ndjson") },
      { name: "edges.ndjson", body: JSON.stringify({ edge }) + "\n" },
    ]);
  };
  // Also track refused fixtures: a regression that accepts them must clean up.
  trackItem(ctx, first);
  trackItem(ctx, last);
  trackEdge(ctx, edgeId);
  trackType(ctx, typeId);
  return { first, last, edgeId, typeId, hash, rows, edge, archive };
}

const invalid = [-1, 0, 1.5, "4", null, true, Number.MAX_SAFE_INTEGER + 1];
const cases = [
  ...invalid.map((value) => ({ field: "item.version", value })),
  ...invalid.map((value) => ({ field: "edge.version", value })),
  ...["invalid", null, 5].map((value) => ({ field: "item.tier", value })),
];
describe("archived row scalars", () => {
  it.each(cases)(
    "refuses invalid $field=$value before writing the archive",
    async ({ field, value }) => {
      const f = fixture();
      if (field === "edge.version") f.edge.version = value;
      else f.rows[1]![field.split(".")[1]!] = value;
      const response = await owner.restoreArchive(f.archive());
      const id = field.startsWith("edge") ? f.edgeId : f.last;
      expect(response.status).toBe(400);
      expect(response.error?.error.code).toBe("validation_error");
      expect(response.error?.error.message).toContain(id);
      expect(response.error?.error.message).toContain(field.split(".")[1]);
      for (const item of [f.first, f.last])
        expect((await client.getItem(item)).status).toBe(404);
      expect((await client.getEdge(f.edgeId)).status).toBe(404);
      expect((await client.getType(f.typeId)).status).toBe(404);
      expect((await owner.downloadBlob(f.hash)).status).toBe(404);

      f.rows[1]!.version = 7;
      f.rows[1]!.tier = "feed";
      f.edge.version = 9;
      const accepted = await owner.restoreArchive(f.archive());
      expect(accepted.ok, JSON.stringify(accepted.error)).toBe(true);
      expect(accepted.data).toMatchObject({
        imported: 2,
        edges_imported: 1,
        types_registered: 1,
        blobs_imported: 1,
      });
      expect((await client.getItem(f.last)).data.item).toMatchObject({
        version: 7,
        tier: "feed",
      });
      expect((await client.getEdge(f.edgeId)).data.edge.version).toBe(9);
      expect((await client.getType(f.typeId)).ok).toBe(true);
      expect((await client.downloadBlob(f.hash)).status).toBe(200);
    },
  );

  it.each(["item.version", "edge.version", "item.tier"])(
    "refuses invalid %s even when the row already exists",
    async (field) => {
      const f = fixture();
      expect((await owner.restoreArchive(f.archive())).ok).toBe(true);
      if (field === "item.tier") f.rows[1]!.tier = "invalid";
      else if (field === "item.version") f.rows[1]!.version = 0;
      else f.edge.version = 0;
      const refused = await owner.restoreArchive(f.archive());
      expect(refused.status).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect((await client.getItem(f.last)).data.item).toMatchObject({
        version: 7,
        tier: "feed",
      });
      expect((await client.getEdge(f.edgeId)).data.edge.version).toBe(9);
    },
  );

  it("refuses an invalid edge version even when its endpoint is missing", async () => {
    const f = fixture();
    f.edge.target_id = uuidv7();
    f.edge.version = 0;
    const refused = await owner.restoreArchive(f.archive());
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect((await client.getItem(f.first)).status).toBe(404);
    expect((await client.getType(f.typeId)).status).toBe(404);
    expect((await owner.downloadBlob(f.hash)).status).toBe(404);
    f.edge.version = 9;
    const accepted = await owner.restoreArchive(f.archive());
    expect(accepted.ok, JSON.stringify(accepted.error)).toBe(true);
    expect(accepted.data).toMatchObject({
      imported: 2,
      edges_imported: 0,
      edges_skipped: 1,
      edges_skipped_reasons: { endpoint_missing: 1 },
    });
  });

  it.each([
    { name: "omitted scalars", version: undefined, tier: undefined },
    { name: "initial versions", version: 1, tier: "library" },
    { name: "nondefault scalars", version: 7, tier: "feed" },
    {
      name: "largest safe integer",
      version: Number.MAX_SAFE_INTEGER,
      tier: "library",
    },
  ])(
    "restores $name without changing their meaning",
    async ({ version, tier }) => {
      const f = fixture();
      for (const row of f.rows) {
        row.version = version;
        row.tier = tier;
      }
      f.edge.version = version;
      const result = await owner.restoreArchive(f.archive());
      expect(result.ok, JSON.stringify(result.error)).toBe(true);
      for (const id of [f.first, f.last])
        expect((await client.getItem(id)).data.item).toMatchObject({
          version: version ?? 1,
          tier: tier ?? "library",
        });
      expect((await client.getEdge(f.edgeId)).data.edge.version).toBe(
        version ?? 1,
      );
    },
  );
});
