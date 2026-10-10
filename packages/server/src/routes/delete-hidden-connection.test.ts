import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { itemWrites } from "../storage/item-writes.js";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/** A note that is `parent-of` a live connection, seeded through storage. */
async function parentOfLiveConnection(): Promise<{
  note: string;
  connection: string;
}> {
  const note = await itemWrites(ctx.storage).create({
    writer: null,
    type: "core.note",
    properties: { body: "parent" },
  });
  const connection = await itemWrites(ctx.storage).create({
    writer: null,
    type: "system.connection",
    properties: {
      kind: "app",
      status: "active",
      granted_at: new Date().toISOString(),
      client_id: "acme.demo",
    },
  });
  await ctx.storage.edges.createRaw({
    source_id: note.id,
    target_id: connection.id,
    edge_type: "parent-of",
  });
  return { note: note.id, connection: connection.id };
}

describe("a delete refused for a live connection it would take with it", () => {
  it("names nothing of a connection the key cannot read", async () => {
    const blind = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "write" },
    });
    const { note, connection } = await parentOfLiveConnection();
    const res = await request(ctx.app, "DELETE", `/items/${note}`, {
      key: blind,
    });
    const text = await res.text();
    expect(res.status, text).toBe(400);
    expect(JSON.parse(text)).toMatchObject({
      error: { code: "validation_error" },
    });
    expect(text).not.toContain(connection);
    expect(text).not.toMatch(/Grant|Connection|connection|grants/);
    expect((await ctx.storage.items.get(note))?.state).toBe("active");

    // The witness: a key that reads the connection is told which one.
    const reader = await mintWorkingKey(ctx, {
      type_permissions: {
        "core.note": "write",
        "system.connection": "read",
      },
    });
    const named = await request(ctx.app, "DELETE", `/items/${note}`, {
      key: reader,
    });
    expect(named.status).toBe(400);
    expect(await named.text()).toContain(connection);
  });
});
