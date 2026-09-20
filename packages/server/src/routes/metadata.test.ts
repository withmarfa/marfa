import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

interface ItemResponse {
  item: { id: string };
}

async function createItemWithTags(tags: string[]): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: {
      type: "core.note",
      properties: { body: `tags-${tags.join("-")}-${String(Math.random())}` },
      tags,
    },
  });
  return ((await res.json()) as ItemResponse).item.id;
}

describe("GET /metadata/tags", () => {
  it("rejects unauthenticated", async () => {
    const res = await request(ctx.app, "GET", "/metadata/tags");
    expect(res.status).toBe(401);
  });

  it("returns distinct tags with counts, sorted by count desc", async () => {
    await createItemWithTags(["alpha", "beta"]);
    await createItemWithTags(["alpha", "gamma"]);
    await createItemWithTags(["alpha"]);

    const res = await request(ctx.app, "GET", "/metadata/tags", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      tags: { tag: string; count: number }[];
    };
    const lookup = new Map(data.tags.map((t) => [t.tag, t.count]));
    expect(lookup.get("alpha") ?? 0).toBeGreaterThanOrEqual(3);
    expect(lookup.get("beta") ?? 0).toBeGreaterThanOrEqual(1);
    expect(lookup.get("gamma") ?? 0).toBeGreaterThanOrEqual(1);
    // Sorted by count desc; alpha should appear before its single-use peers.
    const alphaIdx = data.tags.findIndex((t) => t.tag === "alpha");
    const betaIdx = data.tags.findIndex((t) => t.tag === "beta");
    expect(alphaIdx).toBeGreaterThanOrEqual(0);
    expect(betaIdx).toBeGreaterThanOrEqual(0);
    expect(alphaIdx).toBeLessThan(betaIdx);
  });

  it("counts the same rows a listing answers, and no others", async () => {
    // Both of the states a row can be put away in. The facet is a view on
    // the listing beside it, so a tag counted here that `GET /items?tags=`
    // answers nothing for is a name a reader clicks through to an empty
    // page. A case that named only the bin would not see the archive move.
    const listed = async (tag: string): Promise<boolean> => {
      const res = await request(ctx.app, "GET", "/metadata/tags", {
        key: ctx.workingKey,
      });
      expect(
        res.status,
        "the facet door stopped answering, so every reading below is taken from an error body and means nothing",
      ).toBe(200);
      const data = (await res.json()) as { tags: { tag: string }[] };
      return data.tags.some((t) => t.tag === tag);
    };

    const binned = await createItemWithTags(["only-on-trashed-item"]);
    const filed = await createItemWithTags(["only-on-archived-item"]);

    expect(
      await listed("only-on-trashed-item"),
      "a tag on a live row is not counted, so the absences below say nothing about what a delete or an archive does",
    ).toBe(true);
    expect(
      await listed("only-on-archived-item"),
      "a tag on a live row is not counted, so the archive absence below says nothing about what an archive does",
    ).toBe(true);

    await request(ctx.app, "DELETE", `/items/${binned}`, {
      key: ctx.workingKey,
    });
    const archived = await request(
      ctx.app,
      "POST",
      `/items/${filed}/transition`,
      { key: ctx.workingKey, body: { state: "archived" } },
    );
    expect(
      archived.status,
      "the fixture cannot archive a row, so the second absence below is about a row still in the active state",
    ).toBe(200);

    expect(
      await listed("only-on-trashed-item"),
      "a tag on a row in the bin is still counted, so a deleted row keeps a name in the vocabulary that opens to nothing",
    ).toBe(false);
    expect(
      await listed("only-on-archived-item"),
      "a tag on an archived row is still counted, so the facet and the listing disagree and the count opens to an empty page",
    ).toBe(false);
  });
});

/**
 * The tag in the path is the tag that is removed.
 *
 * Hono decodes a path parameter exactly once. This handler decoded it a
 * second time, which is not defensive: it corrupts a value that was
 * already correct, and it does so differently depending on what the tag
 * holds. A literal percent threw and answered 500. A run of characters
 * that happens to look like an escape decoded into a *different* tag, so
 * the removal named a row nobody has and the response was a cheerful 200
 * with the tag still in place.
 *
 * Both cases go through the encoding a correct client sends — the
 * published parameter description says the segment is URL-encoded and the
 * TypeScript kit encodes it — so this is the door being called properly
 * and answering wrongly.
 */
describe("DELETE /items/{id}/tags/{tag} takes the tag the caller named", () => {
  /** The tags on an item, read back through the API rather than storage. */
  async function tagsOf(id: string): Promise<string[]> {
    const res = await request(ctx.app, "GET", `/items/${id}/metadata`, {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { metadata: { tags: string[] } };
    return body.metadata.tags;
  }

  it("removes a tag holding a literal percent, rather than answering 500", async () => {
    // `50%off` encodes to `50%25off`. The second decode met `%of`, which
    // is not valid hex, and threw out of the handler.
    const id = await createItemWithTags(["50%off", "keep-me"]);
    expect(await tagsOf(id)).toContain("50%off");

    const res = await request(
      ctx.app,
      "DELETE",
      `/items/${id}/tags/${encodeURIComponent("50%off")}`,
      { key: ctx.workingKey },
    );

    expect(res.status).toBe(200);
    expect(await tagsOf(id)).toEqual(["keep-me"]);
  });

  it("removes the tag it names, not the one a second decode produces", async () => {
    // The quiet half. `50%25off` encodes to `50%2525off`; decoded twice it
    // becomes `50%off`, which no row holds — so the removal matched
    // nothing, the response was 200, and the tag stayed.
    const id = await createItemWithTags(["50%25off", "keep-me"]);
    // The pre-state, so a future normalization in the add door cannot
    // make this case pass by removing the tag it is about.
    expect(await tagsOf(id)).toContain("50%25off");

    const res = await request(
      ctx.app,
      "DELETE",
      `/items/${id}/tags/${encodeURIComponent("50%25off")}`,
      { key: ctx.workingKey },
    );

    expect(res.status).toBe(200);
    expect(await tagsOf(id)).toEqual(["keep-me"]);
  });
});
