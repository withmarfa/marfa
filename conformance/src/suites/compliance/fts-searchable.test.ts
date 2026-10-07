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

  /** Whether a search for `token` answers the row `id`. */
  async function matches(token: string, id: string): Promise<boolean> {
    const result = await client.search(token, { limit: 50 });
    expect(result.status, JSON.stringify(result.error)).toBe(200);
    return result.data.data.some((hit) => hit.item.id === id);
  }

  async function seed(
    type: string,
    properties: Record<string, unknown>,
    tags?: string[],
  ): Promise<string> {
    const created = await client.createItem({
      type,
      source: ctx.source,
      properties,
      ...(tags !== undefined && { tags }),
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    trackItem(ctx, created.data.item.id);
    return created.data.item.id;
  }

  it("does not hold a value that is not a string, though the same text is found in a string", async () => {
    const typeId = `user.nonstring-${ctx.runId}`;
    const registered = await client.registerType({
      id: typeId,
      fields: {
        title: { type: "number" },
        description: { type: "array", items_type: "string" },
        body: { type: "string" },
      },
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    // Fourteen digits no other file holds, and a number a double keeps whole.
    const digits = String(Date.now() * 10 + 7);
    const word = `marmoset${ctx.runId.replace(/\W/g, "")}`;

    const numeric = await seed(typeId, { title: Number(digits) });
    const listed = await seed(typeId, { description: [word] });
    // The witness: the same text in the string field is found.
    const asString = await seed(typeId, {
      body: `${digits} ${word}`,
    });

    for (const token of [digits, word]) {
      expect(await matches(token, asString), `${token} as a string`).toBe(true);
    }
    expect(await matches(digits, numeric)).toBe(false);
    expect(await matches(word, listed)).toBe(false);
  });

  it("keeps the four core properties and the tags of a row whose type was removed with force", async () => {
    const typeId = `user.orphan-core-${ctx.runId}`;
    const registered = await client.registerType({
      id: typeId,
      fields: { blurb: { type: "string" } },
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    const run = ctx.runId.replace(/\W/g, "");
    const words = {
      title: `orphantitle${run}`,
      body: `orphanbody${run}`,
      description: `orphandescription${run}`,
      name: `orphanname${run}`,
      tag: `orphantag${run}`,
      blurb: `orphanblurb${run}`,
    };
    const id = await seed(
      typeId,
      {
        title: words.title,
        body: words.body,
        description: words.description,
        name: words.name,
        blurb: words.blurb,
      },
      [words.tag],
    );
    // The witness: every word matches while the type is registered.
    for (const word of Object.values(words)) {
      expect(await matches(word, id), `${word} before`).toBe(true);
    }

    const removed = await client.deleteType(typeId, true);
    expect(removed.ok, JSON.stringify(removed.error)).toBe(true);
    for (const word of [
      words.title,
      words.body,
      words.description,
      words.name,
      words.tag,
    ]) {
      expect(await matches(word, id), `${word} after`).toBe(true);
    }
    expect(await matches(words.blurb, id), "the declared extra field").toBe(
      false,
    );
  });

  it("indexes the rows of a type that inherits again when its parent changes what it marks searchable", async () => {
    const parent = `user.inherit-index-${ctx.runId}`;
    const child = `${parent}.child`;
    const registered = await client.registerType({
      id: parent,
      fields: { blurb: { type: "string" } },
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    const sub = await client.registerType({ id: child, parent, fields: {} });
    expect(sub.ok, JSON.stringify(sub.error)).toBe(true);
    const token = `inherited${ctx.runId.replace(/\W/g, "")}`;
    const id = await seed(child, { blurb: token });
    // The witness: the child's row matches under what it inherits.
    expect(await matches(token, id)).toBe(true);

    const flip = async (searchable: boolean, version: number) => {
      const updated = await client.replaceType(parent, {
        id: parent,
        version,
        fields: { blurb: { type: "string", searchable } },
      });
      expect(updated.ok, JSON.stringify(updated.error)).toBe(true);
    };
    await flip(false, 1);
    expect(await matches(token, id)).toBe(false);
    await flip(true, 2);
    expect(await matches(token, id)).toBe(true);
  });
});
