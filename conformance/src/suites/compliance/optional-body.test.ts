import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, cleanup, trackItem } from "../../utils/setup.js";

/**
 * No built-in type requires its body. A note can be only a title, an article
 * can be saved before its text is fetched, and a message can be only a photo
 * or a file. What each type still requires is what it means nothing without:
 * an article its title, a message its sender.
 */

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "optional-body"));
});

afterAll(async () => {
  await cleanup(ctx);
});

function fieldsNamed(error: unknown): string[] {
  const details = (
    error as { error?: { details?: { errors?: Array<{ field: string }> } } }
  )?.error?.details;
  return (details?.errors ?? []).map((e) => e.field);
}

describe("a built-in type that has a body", () => {
  it("declares body as optional on core.note, core.media.article and core.message", async () => {
    for (const id of ["core.note", "core.media.article", "core.message"]) {
      const t = await client.getType(id);
      expect(t.ok, id).toBe(true);
      expect(t.data.fields.body, id).toBeDefined();
      expect(t.data.fields.body.required, id).toBeUndefined();
    }
  });

  it("keeps the title of an article and the sender of a message required", async () => {
    const article = await client.getType("core.media.article");
    expect(article.ok).toBe(true);
    expect(article.data.fields.title.required).toBe(true);

    const message = await client.getType("core.message");
    expect(message.ok).toBe(true);
    expect(message.data.fields.from.required).toBe(true);
  });

  it("requires no field of a note", async () => {
    const t = await client.getType("core.note");
    expect(t.ok).toBe(true);
    const required = Object.entries(t.data.fields)
      .filter(([, def]) => def.required === true)
      .map(([name]) => name);
    expect(required).toEqual([]);
  });
});

describe("core.note without a body", () => {
  it("creates with no properties at all", async () => {
    const r = await client.createItem({
      type: "core.note",
      source: ctx.source,
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
  });

  it("creates with only a title, and takes a body later", async () => {
    const created = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { title: "Just a title" },
    });
    expect(created.ok).toBe(true);
    trackItem(ctx, created.data.item.id);
    expect(created.data.item.properties.body).toBeUndefined();

    const updated = await client.updateItem(created.data.item.id, {
      version: created.data.item.version,
      properties: { body: "Now with text." },
    });
    expect(updated.ok).toBe(true);
    expect(updated.data.item.properties.body).toBe("Now with text.");
  });

  it("updates a note that has no body, leaving it without one", async () => {
    const created = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { title: "Before" },
    });
    expect(created.ok).toBe(true);
    trackItem(ctx, created.data.item.id);

    const updated = await client.updateItem(created.data.item.id, {
      version: created.data.item.version,
      properties: { title: "After" },
    });
    expect(updated.ok).toBe(true);
    expect(updated.data.item.properties.title).toBe("After");
    expect(updated.data.item.properties.body).toBeUndefined();
  });

  it("creates through the bulk door", async () => {
    const r = await client.bulkItems([
      {
        type: "core.note",
        source: ctx.source,
        properties: { title: "Bulk, no body" },
      },
    ]);
    expect(r.ok).toBe(true);
    expect(r.data.counts.created).toBe(1);
    for (const row of r.data.results) {
      expect(row.outcome).toBe("created");
      if (row.id) trackItem(ctx, row.id);
    }
  });

  it("still refuses a body of the wrong kind, naming it", async () => {
    // The witness that the door still judges `body`: only its absence is
    // allowed.
    const r = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: 42 },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_properties");
    expect(fieldsNamed(r.error)).toContain("body");
  });
});

describe("core.media.article without a body", () => {
  it("creates with only a title", async () => {
    const r = await client.createItem({
      type: "core.media.article",
      source: ctx.source,
      properties: { title: "Saved before its text was fetched" },
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item.properties.body).toBeUndefined();
  });

  it("still refuses an article with no title, naming it", async () => {
    const r = await client.createItem({
      type: "core.media.article",
      source: ctx.source,
      properties: { body: "Text with no title." },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_properties");
    expect(fieldsNamed(r.error)).toEqual(["title"]);
  });
});

describe("core.message without a body", () => {
  it("creates with only a sender", async () => {
    const r = await client.createItem({
      type: "core.message",
      source: ctx.source,
      properties: { from: "+15550100" },
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item.properties.from).toBe("+15550100");
    expect(r.data.item.properties.body).toBeUndefined();
  });

  it("still refuses a message with no sender, naming it", async () => {
    const r = await client.createItem({
      type: "core.message",
      source: ctx.source,
      properties: { body: "Who sent this?" },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_properties");
    expect(fieldsNamed(r.error)).toEqual(["from"]);
  });
});
