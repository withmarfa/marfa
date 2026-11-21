import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { itemsArchive } from "../../utils/archive.js";
import {
  cleanup,
  createTestContext,
  getOwnerClient,
  trackItem,
  trackType,
} from "../../utils/setup.js";

let client: MarfaClient;
let owner: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext(
    "compliance",
    "restore-array-items",
  ));
  owner = getOwnerClient();
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("a type whose array field names an items_type that is no field type", () => {
  it("restores a type whose items_type names no field type, and its items take any elements", async () => {
    const id = `user.unnamed-items-${ctx.runId}`;
    const fields = {
      loose: { type: "array", items_type: "somethingelse" },
      names: { type: "array", items_type: "string" },
    };
    // The witness: a registration of the same fields is refused.
    const refused = await client.registerType({ id, fields } as never);
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_schema");
    expect((await client.getType(id)).status).toBe(404);

    trackType(ctx, id);
    const restored = await owner.restoreArchive(
      itemsArchive([], [], [{ id, fields }]),
    );
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect((await client.getType(id)).data.fields.loose).toMatchObject({
      type: "array",
      items_type: "somethingelse",
    });

    const taken = await client.createItem({
      type: id,
      source: ctx.source,
      properties: { loose: [1, "x", {}, null], names: ["a"] },
    });
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
    trackItem(ctx, taken.data.item.id);

    // A field that does name a field type is still held to it.
    const wrong = await client.createItem({
      type: id,
      source: ctx.source,
      properties: { names: [1] },
    });
    expect(wrong.status).toBe(400);
    expect(wrong.error?.error.code).toBe("invalid_properties");

    // A replacement that keeps the name is refused, and one that corrects it is taken.
    const kept = await client.replaceType(id, { fields } as never);
    expect(kept.status).toBe(400);
    expect(kept.error?.error.code).toBe("invalid_schema");
    const mended = await client.replaceType(id, {
      fields: { ...fields, loose: { type: "array", items_type: "string" } },
    } as never);
    expect(mended.status, JSON.stringify(mended.error)).toBe(200);
  });
});
