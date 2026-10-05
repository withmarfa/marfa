import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

/**
 * Type schemas can mark string fields with `searchable: false` to keep them
 * out of the FTS index: content with the flag set must not surface in search
 * results, even when full-text matches.
 *
 * This is the only place the flag is observable as a black-box test —
 * register a custom type with one searchable and one non-searchable field,
 * write distinctive content into each, and assert the search visibility.
 */

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "fts-searchable"));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("FTS — searchable:false honoring", () => {
  it("matches searchable content and tags without matching an item identifier alone", async () => {
    const body = `searchbody${ctx.runId}`;
    const tag = `searchtag${ctx.runId}`;
    const created = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body },
      tags: [tag],
    });
    expect(created.ok).toBe(true);
    const id = created.data.item.id;
    trackItem(ctx, id);
    for (const query of [body, tag]) {
      const result = await client.search(query, { limit: 50 });
      expect(result.ok).toBe(true);
      expect(result.data.data.map((hit) => hit.item.id)).toContain(id);
    }
    const contentWitness = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: id },
    });
    const tagWitness = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: `tagwitness${ctx.runId}` },
      tags: [id],
    });
    expect(contentWitness.ok).toBe(true);
    expect(tagWitness.ok).toBe(true);
    trackItem(ctx, contentWitness.data.item.id);
    trackItem(ctx, tagWitness.data.item.id);
    const result = await client.search(`"${id}"`, { limit: 50 });
    expect(result.ok).toBe(true);
    expect(result.data.data.map((hit) => hit.item.id)).toEqual(
      expect.arrayContaining([
        contentWitness.data.item.id,
        tagWitness.data.item.id,
      ]),
    );
    expect(result.data.data.map((hit) => hit.item.id)).not.toContain(id);
  });

  it("field with searchable:false is excluded from full-text matches", async () => {
    const typeId = `user.searchable-test-${ctx.runId}`;
    const reg = await client.registerType({
      id: typeId,
      fields: {
        body: { type: "string", searchable: true },
        secret: { type: "string", searchable: false },
      },
    });
    expect(reg.ok).toBe(true);

    // Distinctive tokens unique to this run so we don't collide with
    // anything else searching the index.
    const visibleToken = `fts-visible-${ctx.runId}`;
    const hiddenToken = `fts-hidden-${ctx.runId}`;

    const created = await client.createItem({
      type: typeId,
      source: ctx.source,
      properties: {
        body: `containing ${visibleToken} that should be findable`,
        secret: `containing ${hiddenToken} that should NOT be findable`,
      },
    });
    expect(created.ok).toBe(true);
    trackItem(ctx, created.data.item.id);

    const visibleSearch = await client.search(visibleToken, { limit: 50 });
    expect(visibleSearch.ok).toBe(true);
    await expectMatchesSchema("GET", "/search", 200, visibleSearch.data);
    const visibleHits = visibleSearch.data.data.filter(
      (r) => r.item.id === created.data.item.id,
    );
    expect(visibleHits.length).toBe(1);

    const hiddenSearch = await client.search(hiddenToken, { limit: 50 });
    expect(hiddenSearch.ok).toBe(true);
    const hiddenHits = hiddenSearch.data.data.filter(
      (r) => r.item.id === created.data.item.id,
    );
    expect(hiddenHits.length).toBe(0);
  });

  it("content remains retrievable on the item even when not searchable", async () => {
    const typeId = `user.searchable-getitem-${ctx.runId}`;
    await client.registerType({
      id: typeId,
      fields: {
        secret: { type: "string", searchable: false },
      },
    });

    const phrase = `secret-roundtrip-${ctx.runId}`;
    const created = await client.createItem({
      type: typeId,
      source: ctx.source,
      properties: { secret: phrase },
    });
    expect(created.ok).toBe(true);
    trackItem(ctx, created.data.item.id);

    // The flag is about FTS visibility, not about content access.
    // getItem must still return the field exactly as written.
    const fetched = await client.getItem(created.data.item.id);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.properties.secret).toBe(phrase);
  });

  it("rows already stored follow a change to what their type marks searchable", async () => {
    const typeId = `user.searchable-flip-${ctx.runId}`;
    const reg = await client.registerType({
      id: typeId,
      fields: { blurb: { type: "string" } },
    });
    expect(reg.ok, JSON.stringify(reg.error)).toBe(true);
    const token = `flip-${ctx.runId}`;
    const created = await client.createItem({
      type: typeId,
      source: ctx.source,
      properties: { blurb: `holding ${token} before the change` },
    });
    expect(created.ok).toBe(true);
    const id = created.data.item.id;
    trackItem(ctx, id);
    const matches = async (): Promise<boolean> => {
      const result = await client.search(token, { limit: 50 });
      expect(result.ok).toBe(true);
      return result.data.data.some((hit) => hit.item.id === id);
    };
    // The witness: the row matches before the change.
    expect(await matches()).toBe(true);

    const flip = async (searchable: boolean) => {
      const updated = await client.replaceType(typeId, {
        id: typeId,
        version: 1,
        fields: { blurb: { type: "string", searchable } },
      });
      expect(updated.ok, JSON.stringify(updated.error)).toBe(true);
    };
    await flip(false);
    expect(await matches()).toBe(false);
    await flip(true);
    expect(await matches()).toBe(true);

    const orphaned = await client.deleteType(typeId, true);
    expect(orphaned.ok, JSON.stringify(orphaned.error)).toBe(true);
    expect(await matches()).toBe(false);
    const again = await client.registerType({
      id: typeId,
      fields: { blurb: { type: "string" } },
    });
    expect(again.ok).toBe(true);
    expect(await matches()).toBe(true);
  });
});
