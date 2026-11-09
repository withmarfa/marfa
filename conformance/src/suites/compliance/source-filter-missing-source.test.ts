import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { itemsArchive, type ArchiveItem } from "../../utils/archive.js";
import {
  cleanup,
  createTestContext,
  getOwnerClient,
  trackItem,
  trackKey,
} from "../../utils/setup.js";

let client: MarfaClient;
let owner: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ client, ctx, apiUrl } = await createTestContext(
    "compliance",
    "source-filter-missing-source",
  ));
  owner = getOwnerClient();
});

afterAll(async () => {
  await cleanup(ctx);
});

async function reader(label: string, sources: string[]): Promise<MarfaClient> {
  const minted = await client.createKey({
    label: `missing-source-${label}`,
    source: `${ctx.source}-${label}`,
    permissions: [],
    type_permissions: { "core.note": "read" },
    enforcement_override: {
      source_filter: { types: ["core.note"], sources },
    },
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  trackKey(ctx, minted.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
}

describe("an item that carries no source", () => {
  it("is decided by the source filter as an item whose source is unknown", async () => {
    const sourceless = uuidv7();
    const sourced = uuidv7();
    const body = `missing source ${ctx.runId}`;
    // A restored archive line may omit `source`.
    const rows = [
      { id: sourceless, type: "core.note", properties: { body } },
      {
        id: sourced,
        type: "core.note",
        source: ctx.source,
        properties: { body },
      },
    ] as unknown as ArchiveItem[];
    trackItem(ctx, sourceless);
    trackItem(ctx, sourced);
    const restored = await owner.restoreArchive(itemsArchive(rows));
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);

    const read = await client.getItem(sourceless);
    expect(read.status).toBe(200);
    expect(read.data.item.source).toBe("unknown");

    const listed = async (key: MarfaClient): Promise<string[]> => {
      const r = await key.rawRequest<{ data: { id: string }[] }>(
        `/items?type=core.note&limit=200&filter=${encodeURIComponent(
          `properties.body eq "${body}"`,
        )}`,
      );
      expect(r.status, JSON.stringify(r.error)).toBe(200);
      return r.data.data.map((row) => row.id).sort();
    };
    expect(await listed(await reader("unknown", ["unknown"]))).toEqual([
      sourceless,
    ]);
    // The witness: a filter naming the other row's source lists that row only.
    expect(await listed(await reader("sourced", [ctx.source]))).toEqual([
      sourced,
    ]);
  });
});
