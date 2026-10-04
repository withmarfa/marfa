/**
 * Full-text search over the FTS5 virtual table (`items_fts`), populated at
 * write time from the shared `extractSearchableText` helper, which decides
 * what text contributes to FTS for an item.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { shippedPlatformTypes } from "@withmarfa/shared";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await ctx.cleanup();
});

interface SearchHit {
  item: { id: string; type: string };
  relevance_score: number;
}

async function search(query: string): Promise<SearchHit[]> {
  const res = await request(
    ctx.app,
    "GET",
    `/search?q=${encodeURIComponent(query)}`,
    { key: ctx.workingKey },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: SearchHit[] };
  return body.data;
}

describe("what reaches the full-text index", () => {
  it("indexes the four core fields end-to-end", async () => {
    const { item: a } = (await (
      await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: {
          type: "core.note",
          properties: {
            title: "Pelican",
            body: "Brown bird that fishes for breakfast.",
          },
        },
      })
    ).json()) as { item: { id: string } };
    const { item: b } = (await (
      await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: {
          type: "core.note",
          properties: {
            title: "Albatross",
            body: "Wingspan greater than three meters.",
          },
        },
      })
    ).json()) as { item: { id: string } };

    // title hit
    const hitsTitle = await search("pelican");
    const titleIds = hitsTitle.map((h) => h.item.id);
    expect(titleIds).toContain(a.id);
    expect(titleIds).not.toContain(b.id);

    // body hit
    const hitsBody = await search("wingspan");
    const bodyIds = hitsBody.map((h) => h.item.id);
    expect(bodyIds).toContain(b.id);
    expect(bodyIds).not.toContain(a.id);
  });

  it("respects per-type searchable: false on string fields (custom type, long-tail field)", async () => {
    // Register a custom type with one searchable string field and one
    // explicitly-non-searchable string field. The non-searchable
    // content must NOT surface in search results.
    const reg = await request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: {
        id: "demo.t015_optout",
        version: 1,
        fields: {
          public_blurb: { type: "string", description: "Visible in search" },
          internal_secret: {
            type: "string",
            description: "Should NOT surface in search",
            searchable: false,
          },
        },
      },
    });
    expect(reg.status).toBe(201);

    const { item: secretItem } = (await (
      await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: {
          type: "demo.t015_optout",
          properties: {
            public_blurb: "Aardvark gardener",
            internal_secret: "Quagga forensics",
          },
        },
      })
    ).json()) as { item: { id: string } };

    // public_blurb hits
    const publicHits = await search("aardvark");
    expect(publicHits.map((h) => h.item.id)).toContain(secretItem.id);

    // internal_secret content should NOT match — the field is
    // searchable: false, so it must not be indexed at write time.
    const secretHits = await search("quagga");
    expect(secretHits.map((h) => h.item.id)).not.toContain(secretItem.id);
  });

  it("respects searchable: false on a core field (title) for a custom type that opts out", async () => {
    // Custom type that overrides the core `title` field with
    // searchable: false. Demonstrates the opt-out works for the four
    // core fields too — `getSearchableStringFields` skips them
    // because they're core, but the indexer consults
    // `isFieldSearchableExcluded` for the same opt-out shape.
    const reg = await request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: {
        id: "demo.t015_title_optout",
        version: 1,
        fields: {
          title: { type: "string", searchable: false },
          body: { type: "string" },
        },
      },
    });
    expect(reg.status).toBe(201);

    const { item: created } = (await (
      await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: {
          type: "demo.t015_title_optout",
          properties: {
            title: "Narwhal",
            body: "Marine mammal with a long tusk.",
          },
        },
      })
    ).json()) as { item: { id: string } };

    // title is opted out → search on title content misses
    const titleHits = await search("narwhal");
    expect(titleHits.map((h) => h.item.id)).not.toContain(created.id);

    // body is still indexed — happy path still works
    const bodyHits = await search("tusk");
    expect(bodyHits.map((h) => h.item.id)).toContain(created.id);
  });

  it("re-indexes on update — the FTS row reflects the latest state", async () => {
    const { item } = (await (
      await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: {
          type: "core.note",
          properties: { title: "Initial", body: "first" },
        },
      })
    ).json()) as { item: { id: string; version: number } };

    // Initial title hits
    expect((await search("initial")).map((h) => h.item.id)).toContain(item.id);

    // Update the title — the new title should hit, the old shouldn't.
    const upd = await request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: ctx.workingKey,
      body: {
        properties: { title: "Updated", body: "second" },
        version: item.version,
      },
    });
    expect(upd.status).toBe(200);

    expect((await search("updated")).map((h) => h.item.id)).toContain(item.id);
    expect((await search("initial")).map((h) => h.item.id)).not.toContain(
      item.id,
    );
  });

  it("removes from index on hard delete", async () => {
    const { item } = (await (
      await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: {
          type: "core.note",
          properties: { title: "Ephemeral", body: "doomed" },
        },
      })
    ).json()) as { item: { id: string } };

    expect((await search("ephemeral")).map((h) => h.item.id)).toContain(
      item.id,
    );

    // Trash → purge (hard delete). Search must no longer match.
    const trash = await request(ctx.app, "DELETE", `/items/${item.id}`, {
      key: ctx.workingKey,
    });
    expect(trash.status).toBe(200);
    const purge = await request(ctx.app, "DELETE", `/items/${item.id}/purge`, {
      key: ctx.workingKey,
    });
    expect(purge.status).toBe(200);

    expect((await search("ephemeral")).map((h) => h.item.id)).not.toContain(
      item.id,
    );
  });
});

describe("what a change to a type does to rows already stored", () => {
  async function registerType(
    id: string,
    fields: Record<string, unknown>,
    parent?: string,
  ): Promise<void> {
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: { id, version: 1, fields, ...(parent ? { parent } : {}) },
    });
    expect(res.status).toBe(201);
  }

  async function replaceType(
    id: string,
    fields: Record<string, unknown>,
    parent?: string,
  ): Promise<void> {
    const res = await request(ctx.app, "PUT", `/types/${id}`, {
      key: ctx.workingKey,
      body: { id, version: 2, fields, ...(parent ? { parent } : {}) },
    });
    expect(res.status).toBe(200);
  }

  async function create(
    type: string,
    properties: Record<string, unknown>,
  ): Promise<string> {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type, properties },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { item: { id: string } }).item.id;
  }

  async function found(query: string): Promise<string[]> {
    return (await search(query)).map((hit) => hit.item.id);
  }

  it("stops matching a field a type now marks searchable: false, and matches it again once it is not", async () => {
    await registerType("demo.flip", { blurb: { type: "string" } });
    const id = await create("demo.flip", { blurb: "Quokka sanctuary" });
    // The witness: the row was matchable by the field before the change.
    expect(await found("quokka")).toContain(id);

    await replaceType("demo.flip", {
      blurb: { type: "string", searchable: false },
    });
    expect(await found("quokka")).not.toContain(id);

    await replaceType("demo.flip", { blurb: { type: "string" } });
    expect(await found("quokka")).toContain(id);
  });

  it("matches a core field a type opts out of no longer, and again when it opts back in", async () => {
    await registerType("demo.flip_core", { title: { type: "string" } });
    const id = await create("demo.flip_core", { title: "Wombat burrow" });
    expect(await found("wombat")).toContain(id);

    await replaceType("demo.flip_core", {
      title: { type: "string", searchable: false },
    });
    expect(await found("wombat")).not.toContain(id);

    await replaceType("demo.flip_core", { title: { type: "string" } });
    expect(await found("wombat")).toContain(id);
  });

  it("matches a field the type gains, for rows that already held a value in it", async () => {
    await registerType("demo.gain", { note: { type: "string" } });
    const id = await create("demo.gain", {
      note: "present",
      tagline: "Numbat termites",
    });
    expect(await found("numbat")).not.toContain(id);

    await replaceType("demo.gain", {
      note: { type: "string" },
      tagline: { type: "string" },
    });
    expect(await found("numbat")).toContain(id);
  });

  it("stops matching a field the type drops", async () => {
    await registerType("demo.drop", {
      note: { type: "string" },
      tagline: { type: "string" },
    });
    const id = await create("demo.drop", {
      note: "present",
      tagline: "Bilby burrow",
    });
    expect(await found("bilby")).toContain(id);

    await replaceType("demo.drop", { note: { type: "string" } });
    expect(await found("bilby")).not.toContain(id);
  });

  it("re-indexes the rows of a subtype when its parent changes a field it inherits", async () => {
    await registerType("demo.parent", { blurb: { type: "string" } });
    await registerType(
      "demo.child",
      { other: { type: "string" } },
      "demo.parent",
    );
    const id = await create("demo.child", { blurb: "Dingo pack" });
    expect(await found("dingo")).toContain(id);

    await replaceType("demo.parent", {
      blurb: { type: "string", searchable: false },
    });
    expect(await found("dingo")).not.toContain(id);
  });

  it("re-indexes a row left by a forced delete under the fields nobody declares, and again on re-registration", async () => {
    await registerType("demo.orphaned", {
      blurb: { type: "string" },
      title: { type: "string" },
    });
    const id = await create("demo.orphaned", {
      title: "Kakapo",
      blurb: "Takahe wetland",
    });
    expect(await found("takahe")).toContain(id);

    const removed = await request(
      ctx.app,
      "DELETE",
      "/types/demo.orphaned?force=true",
      { key: ctx.workingKey },
    );
    expect(removed.status).toBe(200);
    expect(await found("takahe")).not.toContain(id);
    // The row is still held and still matched by what a type-less row
    // contributes: a core field.
    expect(await found("kakapo")).toContain(id);

    await registerType("demo.orphaned", { blurb: { type: "string" } });
    expect(await found("takahe")).toContain(id);
  });

  it("leaves a trashed row out of the index when its type changes", async () => {
    await registerType("demo.binned", { blurb: { type: "string" } });
    const id = await create("demo.binned", { blurb: "Echidna spines" });
    // The witness: the row is matchable before it is trashed.
    expect(await found("echidna")).toContain(id);
    const trashed = await request(ctx.app, "DELETE", `/items/${id}`, {
      key: ctx.workingKey,
    });
    expect(trashed.status).toBe(200);

    await replaceType("demo.binned", {
      blurb: { type: "string" },
      extra: { type: "string" },
    });
    const all = await request(ctx.app, "GET", "/search?q=echidna&state=any", {
      key: ctx.workingKey,
    });
    expect(all.status).toBe(200);
    expect(((await all.json()) as { data: unknown[] }).data).toEqual([]);
  });

  /** A word nothing wrote, put into a row's index text directly, so it
   *  survives exactly as long as the row is not indexed again. */
  async function markIndexed(id: string, word: string): Promise<void> {
    const run = (
      ctx.storage as unknown as {
        __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
      }
    ).__sqliteRun;
    await run(
      "UPDATE items_fts SET extra = ? WHERE rowid = (SELECT seq FROM item_search_keys WHERE item_id = ?)",
      [word, id],
    );
  }

  it("leaves the rows of a type as they are when a change does not touch what it contributes", async () => {
    await registerType("demo.shape", { blurb: { type: "string" } });
    const id = await create("demo.shape", { blurb: "Cassowary" });
    await markIndexed(id, "markerzero");
    expect(await found("markerzero")).toContain(id);

    // A label and a description change what no row contributes.
    const labelled = await request(ctx.app, "PUT", "/types/demo.shape", {
      key: ctx.workingKey,
      body: {
        id: "demo.shape",
        version: 2,
        label: "A shape",
        description: "Changed",
        fields: { blurb: { type: "string", description: "A blurb" } },
      },
    });
    expect(labelled.status).toBe(200);
    expect(await found("markerzero")).toContain(id);

    // The witness: a change to what it contributes indexes the row again.
    await replaceType("demo.shape", {
      blurb: { type: "string" },
      extra: { type: "string" },
    });
    expect(await found("markerzero")).not.toContain(id);
    expect(await found("cassowary")).toContain(id);
  });

  it("indexes rows again when a build ships a changed schema for their platform type", async () => {
    const note = shippedPlatformTypes().find(
      (entry) => entry.schema.id === "core.note",
    );
    if (!note) throw new Error("core.note is not shipped");
    const id = await create("core.note", {
      title: "Plain",
      body: "Wallaroo grassland",
    });
    expect(await found("wallaroo")).toContain(id);

    const optedOut = {
      ...note,
      schema: {
        ...note.schema,
        fields: {
          ...note.schema.fields,
          body: {
            ...note.schema.fields.body,
            type: "string",
            searchable: false,
          },
        },
      },
    };
    await ctx.storage.types.seedPlatformTypes([optedOut as typeof note]);
    expect(await found("wallaroo")).not.toContain(id);
    expect(await found("plain")).toContain(id);

    await ctx.storage.types.seedPlatformTypes([note]);
    expect(await found("wallaroo")).toContain(id);
  });

  it("indexes the tags and the extra fields in one order, whatever order they were written in", async () => {
    await registerType("demo.order", {
      zeta: { type: "string" },
      alpha: { type: "string" },
    });
    const made = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "demo.order",
        properties: { zeta: "zetaword", alpha: "alphaword" },
        tags: ["zulutag", "alphatag"],
      },
    });
    expect(made.status).toBe(201);
    const id = ((await made.json()) as { item: { id: string } }).item.id;
    for (const [query, matches] of [
      ['"alphaword zetaword"', true],
      ['"zetaword alphaword"', false],
      ['"alphatag zulutag"', true],
      ['"zulutag alphatag"', false],
    ] as const)
      expect((await found(query)).includes(id), query).toBe(matches);

    // A tag written after the row is held in the same order.
    const tagged = await request(ctx.app, "POST", `/items/${id}/tags`, {
      key: ctx.workingKey,
      body: { tags: ["mikotag"] },
    });
    expect(tagged.status).toBe(200);
    expect(await found('"alphatag mikotag zulutag"')).toContain(id);
  });
});
