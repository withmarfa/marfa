import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "extensions",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

const UNKNOWN_ITEM = "00000000-0000-7000-8000-000000000000";

describe("metadata extensions", () => {
  let itemId: string;

  beforeAll(async () => {
    const r = await client.createItem(createNote({ source: ctx.source }));
    expect(r.ok).toBe(true);
    itemId = r.data.item.id;
    trackItem(ctx, itemId);
  });

  it("writes extension data to a namespace", async () => {
    const r = await client.setItemExtension(itemId, "test-app", {
      score: 42,
      label: "important",
    });
    expect(r.ok).toBe(true);
    await expectMatchesSchema(
      "PUT",
      "/items/{id}/extensions/{namespace}",
      200,
      r.data,
    );
    expect(r.data.extensions["test-app"]).toEqual({
      score: 42,
      label: "important",
    });
  });

  it("reads all extensions", async () => {
    const r = await client.listItemExtensions(itemId);
    expect(r.ok).toBe(true);
    await expectMatchesSchema("GET", "/items/{id}/extensions", 200, r.data);
    expect(r.data.extensions["test-app"]).toEqual({
      score: 42,
      label: "important",
    });
  });

  it("reads a specific namespace", async () => {
    const r = await client.getItemExtension(itemId, "test-app");
    expect(r.ok).toBe(true);
    await expectMatchesSchema(
      "GET",
      "/items/{id}/extensions/{namespace}",
      200,
      r.data,
    );
    expect((r.data as unknown as { namespace: string }).namespace).toBe(
      "test-app",
    );
    expect(r.data.data).toEqual({ score: 42, label: "important" });
  });

  it("overwrites extension on second PUT", async () => {
    const put = await client.setItemExtension(itemId, "test-app", {
      score: 99,
    });
    expect(put.ok).toBe(true);
    const r = await client.getItemExtension(itemId, "test-app");
    expect(r.ok).toBe(true);
    expect(r.data.data).toEqual({ score: 99 });
    expect(r.data.data).not.toHaveProperty("label");
  });

  it("writes multiple namespaces independently", async () => {
    expect((await client.setItemExtension(itemId, "app-a", { a: 1 })).ok).toBe(
      true,
    );
    expect((await client.setItemExtension(itemId, "app-b", { b: 2 })).ok).toBe(
      true,
    );
    const r = await client.listItemExtensions(itemId);
    expect(r.ok).toBe(true);
    expect(r.data.extensions["app-a"]).toEqual({ a: 1 });
    expect(r.data.extensions["app-b"]).toEqual({ b: 2 });
  });

  it("deletes a namespace, after which its read answers 200 with null data", async () => {
    const put = await client.setItemExtension(itemId, "to-delete", {
      temp: true,
    });
    expect(put.ok).toBe(true);
    const removed = await client.deleteItemExtension(itemId, "to-delete");
    expect(removed.ok).toBe(true);
    await expectMatchesSchema(
      "DELETE",
      "/items/{id}/extensions/{namespace}",
      200,
      removed.data,
    );
    expect(removed.data.extensions).not.toHaveProperty("to-delete");

    const r = await client.getItemExtension(itemId, "to-delete");
    expect(r.status).toBe(200);
    expect(r.data.data).toBeNull();
  });

  it("extensions persist on the item's metadata read", async () => {
    const put = await client.setItemExtension(itemId, "persist-test", {
      persisted: true,
    });
    expect(put.ok).toBe(true);
    const r = await client.getMetadata(itemId);
    expect(r.ok).toBe(true);
    expect(r.data.metadata.extensions?.["persist-test"]).toEqual({
      persisted: true,
    });
  });

  it("answers 404 for an unknown item and 400 for a malformed id on every door", async () => {
    for (const r of [
      await client.listItemExtensions(UNKNOWN_ITEM),
      await client.getItemExtension(UNKNOWN_ITEM, "x"),
      await client.setItemExtension(UNKNOWN_ITEM, "x", { a: 1 }),
      await client.deleteItemExtension(UNKNOWN_ITEM, "x"),
    ]) {
      expect(r.status).toBe(404);
      expect(r.error?.error.code).toBe("item_not_found");
    }
    const malformed = await client.listItemExtensions("not-an-id");
    expect(malformed.status).toBe(400);
    expect(malformed.error?.error.code).toBe("invalid_id");
  });

  it("refuses a key without reach on the namespace", async () => {
    // A key holding read on one type and no extension map: the listing
    // answers what the key may see, and every namespace door is refused.
    const keyResp = await client.createKey({
      label: "extensions-narrow",
      source: `${ctx.source}-extensions-narrow`,
      space_permissions: [],
      type_permissions: { "core.note": "read" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    const narrowed = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    const read = await narrowed.getItemExtension(itemId, "test-app");
    expect(read.status).toBe(403);
    expect(read.error?.error.code).toBe("forbidden");
    const write = await narrowed.setItemExtension(itemId, "test-app", { x: 1 });
    expect(write.status).toBe(403);
    expect(write.error?.error.code).toBe("forbidden");
    const remove = await narrowed.deleteItemExtension(itemId, "test-app");
    expect(remove.status).toBe(403);
    expect(remove.error?.error.code).toBe("forbidden");
  });
});
