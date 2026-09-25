/**
 * The purge door says which of two refusals this is.
 *
 * Purging is trash-then-purge, so a caller meets `DELETE /items/{id}` first.
 * For a reserved-namespace row a working credential is refused there,
 * by name: "no credential writes `marfa.*` items". The row
 * therefore never becomes trashed, and `DELETE /items/{id}/purge` then
 * answers "Only trashed items can be purged" — which is true, and which
 * describes an ordering mistake the caller did not make.
 *
 * **Two refusals sharing a status is what makes this expensive.** Both are
 * 400-shaped to a reader skimming, so the second message is the one acted
 * on, and it sends somebody looking for a trash step they think they
 * skipped, and the namespace gate above it is never suspected.
 *
 * So the door asks the write rule on the not-trashed path, which is the path
 * the purge was going to be refused on anyway. So the assertions here are about
 * *which message* comes back, and the case that matters most is the one
 * proving the ordinary refusal is unchanged — a fix that renamed every
 * refusal would pass a test that only checked the reserved-namespace one.
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
    // What the guard's placement exists for: the check runs only on the
    // not-trashed path, so an already-trashed row is purged as any other.
    //
    // Trashed through the storage layer, which is how a reserved-namespace
    // row reaches that state at all: the trash door asks the same write rule
    // and refuses every working credential, and the operator key holds no
    // permissions to pass it with either. So the platform's own machinery is
    // what moves these rows.
    const id = await seedReservedRow("relic:refusal-2");
    await ctx.storage.items.transition(id, "trashed");

    const purged = await request(ctx.app, "DELETE", `/items/${id}/purge`, {
      key: workingKey,
    });
    expect(purged.status).toBe(200);
  });
});
