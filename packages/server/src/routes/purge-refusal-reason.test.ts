/**
 * The purge door says which of two refusals this is.
 *
 * Purging is trash-then-purge, so a caller meets `DELETE /items/{id}` first.
 * For a reserved-namespace row a space-scoped credential is refused there,
 * by name: "only the operator key may write `marfa.*` items". The row
 * therefore never becomes trashed, and `DELETE /items/{id}/purge` then
 * answers "Only trashed items can be purged" — which is true, and which
 * describes an ordering mistake the caller did not make.
 *
 * **Two refusals sharing a status is what makes this expensive.** Both are
 * 400-shaped to a reader skimming, so the second message is the one acted
 * on, and it sends somebody looking for a trash step they think they
 * skipped. That happened: a purge of a `marfa.*` corpus was read as an
 * ordering problem and the namespace gate above it was never suspected.
 *
 * The fix asks the write rule on the not-trashed path, which is the path the
 * purge was going to be refused on anyway. So the assertions here are about
 * *which message* comes back, and the case that matters most is the one
 * proving the ordinary refusal is unchanged — a fix that renamed every
 * refusal would pass a test that only checked the reserved-namespace one.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
/** Space-scoped and deliberately NOT platform: the credential the refusal is
 *  about. The operator key is refused by neither gate. */
let spaceKey: string;
let spaceId: string;

beforeAll(async () => {
  ctx = await createTestContext();

  const spaceRes = await request(ctx.app, "POST", "/admin/spaces", {
    key: ctx.operatorKey,
    body: { name: "purge-refusal" },
  });
  const spaceBody = (await spaceRes.json()) as { id: string };
  expect(spaceRes.status, JSON.stringify(spaceBody)).toBe(201);
  spaceId = spaceBody.id;

  const keyRes = await request(
    ctx.app,
    "POST",
    `/admin/spaces/${spaceId}/keys`,
    {
      key: ctx.operatorKey,
      // Reaches every type in its space and is still not the instance tier,
      // which is the whole shape this file is about: the reserved namespace
      // is fenced off a space credential however wide its maps are.
      body: {
        label: "purger",
        source: "purger",
        type_permissions: { "*": "write" },
      },
    },
  );
  const keyBody = (await keyRes.json()) as { key: string };
  expect(keyRes.status, JSON.stringify(keyBody)).toBe(201);
  spaceKey = keyBody.key;
});

afterAll(async () => {
  await ctx.cleanup();
});

/**
 * A reserved-namespace row inside the space, seeded through storage.
 *
 * Through storage rather than the API because the API gate is the very
 * thing under test: a space credential cannot create one, and the operator
 * key holds no space, so neither route puts a `marfa.*` row where a
 * space-scoped caller can address it. That combination is exactly the
 * situation an integration's corpus is in.
 */
async function seedReservedRow(sourceId: string): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "marfa.podcast.show",
      properties: { title: "A show", feed_url: "https://example.com/feed.xml" },
      source: "integration:marfa/podcasts",
      source_id: sourceId,
    },
    spaceId,
  );
  return item.id;
}

describe("purging a row a space credential may not write", () => {
  it("names the namespace rather than the trashed-state precondition", async () => {
    const id = await seedReservedRow("show:refusal-1");

    const res = await request(ctx.app, "DELETE", `/items/${id}/purge`, {
      key: spaceKey,
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
    expect(body.error.message).toContain("only the operator key");
    // And it does NOT say the thing that misdirected: a caller told to trash
    // first will try, be refused there too, and learn nothing either time.
    expect(body.error.message).not.toContain("trashed");

    // The row is untouched. A refusal that half-purged would be worse than
    // the message it replaced.
    const after = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.spaceKey,
    });
    expect(after.status).toBe(200);
  });

  it("still tells a caller who simply forgot to trash first", async () => {
    // The case that stops this becoming "rename every refusal". `core.note`
    // is in no reserved namespace, so the write rule passes and the original
    // message is what should come back.
    const created = await request(ctx.app, "POST", "/items", {
      key: spaceKey,
      body: { type: "core.note", properties: { body: "ordinary" } },
    });
    const createdBody = (await created.json()) as { item: { id: string } };
    expect(created.status, JSON.stringify(createdBody)).toBe(201);

    const res = await request(
      ctx.app,
      "DELETE",
      `/items/${createdBody.item.id}/purge`,
      { key: spaceKey },
    );

    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.error.message).toContain("trashed");
  });

  it("purges a reserved-namespace row once it is trashed, as before", async () => {
    // The non-regression the guard's placement exists for. The new check
    // runs only on the not-trashed path, so a credential that may write the
    // namespace still trashes and purges exactly as it did.
    const id = await seedReservedRow("show:refusal-2");

    const trashed = await request(ctx.app, "DELETE", `/items/${id}`, {
      key: ctx.spaceKey,
    });
    expect(trashed.status).toBe(200);

    const purged = await request(ctx.app, "DELETE", `/items/${id}/purge`, {
      key: ctx.spaceKey,
    });
    expect(purged.status).toBe(200);
  });
});
