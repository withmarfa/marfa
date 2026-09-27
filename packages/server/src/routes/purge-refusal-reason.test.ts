/**
 * The purge door says which of two refusals this is.
 *
 * Purging is trash-then-purge, so a caller meets `DELETE /items/{id}` first.
 * For a reserved-namespace row a working credential is refused there `403`,
 * by name: "no credential writes `marfa.*` items". The row therefore never
 * becomes trashed through that door, and a purge that asked nothing first
 * would answer `400` "Only trashed items can be purged", which is true and
 * describes an ordering mistake the caller did not make. The later message
 * is the one acted on, and it sends somebody looking for a trash step they
 * think they skipped while the namespace gate is never suspected.
 *
 * So the door asks the reserved-namespace fence on the not-trashed path,
 * which is the path the purge was going to be refused on anyway. The
 * assertions here are about *which message* comes back, and the case that
 * matters most is the one proving the ordinary refusal is unchanged: a fix
 * that renamed every refusal would pass a test that only checked the
 * reserved-namespace one.
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

  // The build ships no `marfa.*` type, so the row's type is a platform row
  // an instance can still hold after the build stopped shipping it.
  await ctx.storage.types.create(
    { id: "marfa.relic", version: 1, fields: { title: { type: "string" } } },
    { origin: "platform" },
  );

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
    type: "marfa.relic",
    properties: { title: "A relic" },
    source: "test/purge-refusal",
    source_id: sourceId,
  });
  return item.id;
}

describe("purging a row a working credential may not write", () => {
  it("names the namespace rather than the trashed-state precondition", async () => {
    const id = await seedReservedRow("relic:refusal-1");

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
    expect(body.error.message).toContain("marfa.*");
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

  it("purges a reserved-namespace row once it is trashed", async () => {
    // What the fence's placement exists for: it runs only on the not-trashed
    // path, so an already-trashed row is purged as any other, by a key whose
    // own map writes the type.
    //
    // Trashed through the storage layer, standing in for the doors that do
    // put a reserved row there, a delete cascade and an archive restore: the
    // trash door asks the fence and refuses every working credential.
    const id = await seedReservedRow("relic:refusal-2");
    await ctx.storage.items.transition(id, "trashed");

    const purged = await request(ctx.app, "DELETE", `/items/${id}/purge`, {
      key: workingKey,
    });
    expect(purged.status).toBe(200);
  });
});

/**
 * A soft-deleted row takes write on its type, from the credential's own map.
 *
 * The door opens on `items.purge`, and the map says which rows it destroys,
 * as the restore door beside it asks. The reserved-namespace fence is the one
 * half of the write rule a soft-deleted row is not asked: the row got there
 * by a door that does not ask it, and the fence admits no credential.
 */
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

  it("refuses a trashed reserved-namespace row to a key whose map does not reach it", async () => {
    const id = await seedReservedRow("relic:narrow-map");
    await ctx.storage.items.transition(id, "trashed");

    await expectRefused(id, coreOnlyKey);

    const purged = await request(ctx.app, "DELETE", `/items/${id}/purge`, {
      key: workingKey,
    });
    expect(purged.status).toBe(200);
  });

  it("purges a revoked connection for a key whose map writes the type, and only for one", async () => {
    // The bounded lifecycle: a connection soft-deletes to `revoked`, not to
    // `trashed`, and a revoked one is ordinary history the liveness refusal
    // lets go.
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

    await expectRefused(conn.id, coreOnlyKey);

    const purged = await request(ctx.app, "DELETE", `/items/${conn.id}/purge`, {
      key: workingKey,
    });
    expect(purged.status).toBe(200);
    expect(await ctx.storage.items.getIncludingTrashed(conn.id)).toBeNull();
  });
});
