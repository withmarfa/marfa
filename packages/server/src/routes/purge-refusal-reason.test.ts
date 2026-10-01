/**
 * Which refusal the purge door gives, and to whom.
 *
 * No working credential can trash a reserved-namespace row, so on a row not
 * yet trashed the door names the namespace fence rather than answering "Only
 * trashed items can be purged", which would send the caller looking for a
 * trash step they never skipped. The ordinary refusal must stay as it was, so
 * that case is asserted too. A soft-deleted row is asked the key's type map.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
/** A working credential and deliberately NOT the operator key: the
 *  credential the refusal is about. The operator key holds no permission to
 *  purge one with. */
let workingKey: string;

beforeAll(async () => {
  ctx = await createTestContext();

  // Reaches every type and is still not the instance tier,
  // which is the whole shape this file is about: the reserved namespace
  // is fenced off a working credential however wide its maps are.
  workingKey = await mintWorkingKey(ctx, {
    label: "purger",
    source: "purger",
    type_permissions: { "*": "write" },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

/**
 * A reserved-namespace row, seeded through storage.
 *
 * Through storage rather than the API because the API gate is the very
 * thing under test: a working credential cannot create one, and the operator
 * key holds no permissions to create one with.
 */
async function seedReservedRow(sourceId: string): Promise<string> {
  const item = await ctx.storage.items.create({
    type: "system.device",
    properties: { name: "A device", kind: "laptop" },
    source: "test/purge-refusal",
    source_id: sourceId,
  });
  return item.id;
}

describe("purging a row a working credential may not write", () => {
  it("names the namespace rather than the trashed-state precondition", async () => {
    const id = await seedReservedRow("device:refusal-1");

    const res = await request(ctx.app, "DELETE", `/items/${id}/purge`, {
      key: workingKey,
    });

    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(res.status, JSON.stringify(body)).toBe(403);
    expect(body.error.code).toBe("type_not_permitted");
    // The namespace is named. Asserted on the message rather than the code
    // alone, because the code is what a machine reads and the message is
    // what sent somebody to the wrong place.
    expect(body.error.message).toContain("system.*");
    expect(body.error.message).toContain("no credential writes");
    // And it does NOT say the thing that misdirected: a caller told to trash
    // first will try, be refused there too, and learn nothing either time.
    expect(body.error.message).not.toContain("trashed");

    // The row is untouched. A refusal that half-purged would be worse than
    // the message it replaced. Read back through the same credential, which
    // reads are not fenced by the reserved namespace, only writes are.
    const after = await request(ctx.app, "GET", `/items/${id}`, {
      key: workingKey,
    });
    expect(after.status).toBe(200);
  });

  it("still tells a caller who simply forgot to trash first", async () => {
    // The case that stops this becoming "rename every refusal". `core.note`
    // is in no reserved namespace, so the write rule passes and the original
    // message is what should come back.
    const created = await request(ctx.app, "POST", "/items", {
      key: workingKey,
      body: { type: "core.note", properties: { body: "ordinary" } },
    });
    const createdBody = (await created.json()) as { item: { id: string } };
    expect(created.status, JSON.stringify(createdBody)).toBe(201);

    const res = await request(
      ctx.app,
      "DELETE",
      `/items/${createdBody.item.id}/purge`,
      { key: workingKey },
    );

    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.error.message).toContain("trashed");
  });

  it("purges a reserved-namespace row once it is soft-deleted", async () => {
    // An already soft-deleted reserved row is purged as any other, by a key
    // whose map writes the type. Soft-deleted through storage, standing in
    // for the cascade and archive restore that put such rows there.
    const id = await seedReservedRow("device:refusal-2");
    await ctx.storage.items.delete(id);

    const purged = await request(ctx.app, "DELETE", `/items/${id}/purge`, {
      key: workingKey,
    });
    expect(purged.status).toBe(200);
  });
});

/** A soft-deleted row takes write on its type in the key's own map, as restore asks. */
describe("purging a soft-deleted row", () => {
  /** Holds `items.purge`, writes `core.note`, and only reads `core.task`. */
  let coreOnlyKey: string;

  beforeAll(async () => {
    coreOnlyKey = await mintWorkingKey(ctx, {
      label: "core-purger",
      source: "core-purger",
      type_permissions: { "core.note": "write", "core.task": "read" },
      permissions: ["items.purge"],
    });
  });

  async function trashedNote(): Promise<string> {
    const note = await ctx.storage.items.create({
      type: "core.note",
      properties: { body: "trashed" },
    });
    await ctx.storage.items.delete(note.id);
    return note.id;
  }

  async function expectRefused(id: string, key: string): Promise<void> {
    const res = await request(ctx.app, "DELETE", `/items/${id}/purge`, {
      key,
    });
    const body = (await res.json()) as { error: { code: string } };
    expect(res.status, JSON.stringify(body)).toBe(403);
    expect(body.error.code).toBe("type_not_permitted");
    expect(await ctx.storage.items.getIncludingTrashed(id)).not.toBeNull();
  }

  /** A row whose type the key may not read answers as no row, and stays. */
  async function expectHidden(id: string, key: string): Promise<void> {
    const res = await request(ctx.app, "DELETE", `/items/${id}/purge`, {
      key,
    });
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(res.status, JSON.stringify(body)).toBe(404);
    expect(body.error).toEqual({
      code: "item_not_found",
      message: "Item not found",
    });
    expect(await ctx.storage.items.getIncludingTrashed(id)).not.toBeNull();
  }

  it("refuses a trashed row of a type the key may only read", async () => {
    const task = await ctx.storage.items.create({
      type: "core.task",
      properties: { title: "read only here" },
    });
    await ctx.storage.items.delete(task.id);

    await expectRefused(task.id, coreOnlyKey);

    // The witness: the same key purges a trashed row of the type it writes.
    const purged = await request(
      ctx.app,
      "DELETE",
      `/items/${await trashedNote()}/purge`,
      { key: coreOnlyKey },
    );
    expect(purged.status).toBe(200);
  });

  it("answers a soft-deleted reserved-namespace row to a key whose map does not reach it as no row", async () => {
    const id = await seedReservedRow("device:narrow-map");
    await ctx.storage.items.delete(id);

    await expectHidden(id, coreOnlyKey);

    const purged = await request(ctx.app, "DELETE", `/items/${id}/purge`, {
      key: workingKey,
    });
    expect(purged.status).toBe(200);
  });

  it("purges a revoked connection for a key whose map writes the type, and only for one", async () => {
    // A connection soft-deletes to `revoked`, not `trashed`.
    const conn = await ctx.storage.items.create({
      type: "system.connection",
      properties: {
        kind: "connector",
        status: "revoked",
        granted_at: new Date().toISOString(),
        connector_id: "acme.demo",
      },
    });
    await ctx.storage.items.delete(conn.id);
    expect((await ctx.storage.items.getIncludingTrashed(conn.id))?.state).toBe(
      "revoked",
    );

    await expectHidden(conn.id, coreOnlyKey);

    const purged = await request(ctx.app, "DELETE", `/items/${conn.id}/purge`, {
      key: workingKey,
    });
    expect(purged.status).toBe(200);
    expect(await ctx.storage.items.getIncludingTrashed(conn.id)).toBeNull();
  });
});
