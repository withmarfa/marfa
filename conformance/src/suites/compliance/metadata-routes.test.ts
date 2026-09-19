import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "metadata-routes",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function seed(): Promise<string> {
  const item = await client.createItem(createNote({ source: ctx.source }));
  expect(item.ok).toBe(true);
  trackItem(ctx, item.data.item.id);
  return item.data.item.id;
}

describe("metadata doors", () => {
  it("adds tags, reads them back, and replaces them wholesale", async () => {
    const id = await seed();
    const tagA = `md-a-${ctx.runId}`;
    const tagB = `md-b-${ctx.runId}`;
    const tagC = `md-c-${ctx.runId}`;

    const added = await client.addTags(id, [tagA, tagB]);
    expect(added.ok).toBe(true);
    await expectMatchesSchema("POST", "/items/{id}/tags", 200, added.data);
    expect([...added.data.metadata.tags].sort()).toEqual([tagA, tagB].sort());

    const again = await client.addTags(id, [tagB]);
    expect(again.ok).toBe(true);
    expect([...again.data.metadata.tags].sort()).toEqual([tagA, tagB].sort());

    const read = await client.getMetadata(id);
    expect(read.ok).toBe(true);
    await expectMatchesSchema("GET", "/items/{id}/metadata", 200, read.data);
    expect(read.data.metadata.item_id).toBe(id);
    expect([...read.data.metadata.tags].sort()).toEqual([tagA, tagB].sort());

    const replaced = await client.replaceMetadata(id, { tags: [tagC] });
    expect(replaced.ok).toBe(true);
    await expectMatchesSchema(
      "PUT",
      "/items/{id}/metadata",
      200,
      replaced.data,
    );
    expect(replaced.data.metadata.tags).toEqual([tagC]);

    const after = await client.getMetadata(id);
    expect(after.ok).toBe(true);
    expect(after.data.metadata.tags).toEqual([tagC]);
  });

  it("counts distinct tags across the dataset", async () => {
    const shared = `md-shared-${ctx.runId}`;
    const lone = `md-lone-${ctx.runId}`;
    const tieEarly = `md-tie-a-${ctx.runId}`;
    const tieLate = `md-tie-z-${ctx.runId}`;
    const first = await seed();
    const second = await seed();
    expect((await client.addTags(first, [shared, lone, tieLate])).ok).toBe(
      true,
    );
    expect((await client.addTags(second, [shared, tieEarly])).ok).toBe(true);

    const tags = await client.listTags();
    expect(tags.ok).toBe(true);
    await expectMatchesSchema("GET", "/metadata/tags", 200, tags.data);
    const counts = new Map(tags.data.tags.map((t) => [t.tag, t.count]));
    expect(counts.get(shared)).toBe(2);
    expect(counts.get(lone)).toBe(1);
    expect(counts.get(`md-absent-${ctx.runId}`)).toBeUndefined();

    const order = tags.data.tags.map((t) => t.tag);
    expect(order.indexOf(shared)).toBeLessThan(order.indexOf(lone));

    expect(counts.get(tieEarly)).toBe(1);
    expect(counts.get(tieLate)).toBe(1);
    expect(order.indexOf(tieEarly)).toBeLessThan(order.indexOf(tieLate));
  });

  it("refuses a tags body that is not an array", async () => {
    const id = await seed();
    const r = await client.rawRequest(`/items/${id}/tags`, {
      method: "POST",
      body: { tags: "not-a-list" },
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("validation_error");
  });

  it("answers 404 for an unknown item on every metadata door", async () => {
    const unknown = "00000000-0000-7000-8000-000000000000";
    expect((await client.getMetadata(unknown)).status).toBe(404);
    expect((await client.addTags(unknown, ["x"])).status).toBe(404);
    expect((await client.replaceMetadata(unknown, { tags: [] })).status).toBe(
      404,
    );
  });

  it("refuses every metadata door without a credential, on an id nothing carries", async () => {
    // A row nothing carries, and an empty body where the door wants one.
    // Both of these used to be answered first — `404` for the id on three of
    // these doors, `400` for the body on two — which is exactly what a
    // credential-less caller must not be able to read.
    const unknown = "01999999-9999-7999-8999-999999999999";
    const anonymous = new MarfaClient({ baseUrl: apiUrl, apiKey: "" });
    expect((await anonymous.getMetadata(unknown)).status).toBe(401);
    expect((await anonymous.addTags(unknown, [])).status).toBe(401);
    expect((await anonymous.replaceMetadata(unknown, {})).status).toBe(401);
    expect((await anonymous.listTags()).status).toBe(401);
  });
});
