import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "validation"));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("validation edge cases", () => {
  it("accepts item with minimal valid properties", async () => {
    const note = createNote({
      source: ctx.source,
      properties: { title: "", body: "" },
    });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
  });

  it("rejects core.note with no properties with invalid_properties naming body", async () => {
    // A missing type-declared property is a properties-versus-schema failure,
    // the same code every other schema failure answers with.
    const r = await client.createItem({
      type: "core.note",
      source: ctx.source,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_properties");
    const errors = r.error?.error.details?.errors as
      Array<{ field: string }> | undefined;
    expect(errors?.map((e) => e.field)).toContain("body");
  });

  it("accepts item with empty tags array", async () => {
    const note = createNote({
      source: ctx.source,
      tags: [],
    });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
  });

  it("rejects deep multi-segment type identifiers as unknown", async () => {
    // Well-formed at any depth under a non-reserved root, so the refusal is
    // the registration gate rather than the grammar.
    const r = await client.createItem({
      type: "com.example.app.category.subcategory.item",
      source: ctx.source,
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("unknown_type");
  });

  it("stores a body at the field's length cap intact", async () => {
    // `core.note` declares no `maxLength` on `body`, so the cap is the
    // instance default; a field that declares one raises its own.
    const note = createNote({
      source: ctx.source,
      properties: {
        title: "Large properties test",
        body: "x".repeat(100_000),
      },
    });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    const fetched = await client.getItem(r.data.item.id);
    expect(fetched.ok).toBe(true);
    expect((fetched.data.item.properties.body as string).length).toBe(100_000);
  });

  it("refuses a filter number no double holds, on the listing and the search", async () => {
    const huge = `1${"0".repeat(400)}`;
    // The witness: the same expression with a number a double holds.
    expect((await client.listItems({ filter: "properties.n gt 1" })).ok).toBe(
      true,
    );
    expect(
      (await client.search("note", { filter: "properties.n gt 1" })).ok,
    ).toBe(true);
    for (const filter of [
      `properties.n gt ${huge}`,
      `properties.n gt -${huge}`,
    ]) {
      for (const refused of [
        await client.listItems({ filter }),
        await client.search("note", { filter }),
      ]) {
        expect(refused.status).toBe(400);
        expect(refused.error?.error.code).toBe("validation_error");
      }
    }
  });

  it("refuses an edge shorthand value carrying a backslash, and still takes a quote", async () => {
    // The witness: a value the shorthand quotes without trouble.
    const quoted = await client.listItems({ edge: { about: 'a"b' } });
    expect(quoted.status).toBe(200);
    expect(quoted.data.data).toEqual([]);

    // The first value's backslash would swallow its closing quote, so the
    // second clause's opening quote would end the string and the second
    // value would be read as filter syntax.
    const refused = await client.listItems({
      edge: { about: "x\\", mentions: " OR state exists OR type eq " },
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
  });

  it("accepts quotes, ampersands and parentheses in a search query", async () => {
    const r = await client.search('hello "world" & (test)');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.data.data)).toBe(true);
  });
});

describe("type identifier validation", () => {
  it("rejects type identifier with fewer than 2 segments", async () => {
    const r = await client.createItem({
      type: "note",
      source: ctx.source,
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("validation_error");
    // The field is the witness. `validation_error` is the code every other
    // shape failure on this door answers with, so the code alone would still
    // pass if the grammar gate went and the body were refused elsewhere.
    const errors = r.error?.error.details?.errors as
      { path: string }[] | undefined;
    expect(errors?.[0]?.path).toBe("type");
  });

  it("accepts type identifier with exactly 2 segments", async () => {
    // Asserts the grammar accepts a well-formed 2-segment identifier. Supply
    // the required body so the create exercises the grammar path and isn't
    // rejected on a missing required field.
    const r = await client.createItem(createNote({ source: ctx.source }));
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
  });

  it("rejects type identifier exceeding 128 characters", async () => {
    const segment = "a".repeat(64); // 64 * 2 + 1 dot = 129 chars
    const longType = `${segment}.${segment}`;
    expect(longType.length).toBeGreaterThan(128);

    const r = await client.createItem({
      type: longType,
      source: ctx.source,
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("validation_error");
    const errors = r.error?.error.details?.errors as
      { path: string }[] | undefined;
    expect(errors?.[0]?.path).toBe("type");
  });

  it("accepts type identifier at exactly 128 characters (grammar boundary)", async () => {
    // The grammar permits identifiers up to 128 chars. This well-formed but
    // unregistered 128-char identifier clears the grammar gate, so the create
    // fails at the registration gate with `unknown_type` rather than the
    // generic `validation_error` a 129-char identifier gets. The
    // `unknown_type` code is the positive signal that the grammar accepted it.
    const typeId = `${"a".repeat(63)}.${"b".repeat(64)}`;
    expect(typeId.length).toBe(128);

    const r = await client.createItem({
      type: typeId,
      source: ctx.source,
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("unknown_type");
  });

  it("accepts hyphens in type identifier segments (grammar boundary)", async () => {
    // Hyphens are valid within a segment. `core.my-notes` clears the grammar
    // gate (no `validation_error`); being unregistered, it stops at the
    // registration gate with `unknown_type` — confirming the hyphen was
    // grammatically accepted.
    const r = await client.createItem({
      type: "core.my-notes",
      source: ctx.source,
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("unknown_type");
  });

  it("orders properties by the type's fields, then by the order they were sent", async () => {
    // Every client that renders an item as a document reads the key order,
    // because a file's frontmatter has one and JSON's insertion order is
    // where it comes from. `core.note` declares body, title, language and
    // notes in that order; this write sends three of them backwards and an
    // undeclared one in the middle, so a server that echoed the request
    // would fail here and one that sorted alphabetically would too.
    const r = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: {
        notes: "declared last",
        courier: "undeclared, sent first of its kind",
        title: "declared second",
        anchor: "undeclared, sent second of its kind",
        body: "declared first",
      },
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    const declaredThenSent = ["body", "title", "notes", "courier", "anchor"];
    expect(Object.keys(r.data.item.properties)).toEqual(declaredThenSent);

    // Read back by id, because the create's answer is built on the write
    // path and the read is built on the row.
    const read = await client.getItem(r.data.item.id);
    expect(read.ok).toBe(true);
    expect(Object.keys(read.data.item.properties)).toEqual(declaredThenSent);

    // And stable across a patch: a merge that appended the merged keys
    // would move `title` to the end and reorder the person's document.
    const patched = await client.updateItem(r.data.item.id, {
      properties: { title: "still declared second" },
      version: r.data.item.version,
    });
    expect(patched.ok).toBe(true);
    expect(Object.keys(patched.data.item.properties)).toEqual(declaredThenSent);
  });

  it("puts no property ahead of the type's own that a read of the type does not list", async () => {
    // `links` and `attachments` are validated on every type, and `GET
    // /types/core.note` lists neither, so neither is a field the type
    // declares: each takes its place among the rest, in the order sent.
    const listed = await client.getType("core.note");
    expect(listed.ok).toBe(true);
    const declared = Object.keys(listed.data.fields);
    expect(declared).not.toContain("links");
    expect(declared).not.toContain("attachments");
    const r = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: {
        courier: "sent first of the rest",
        title: "declared second",
        links: ["https://example.com/one"],
        attachments: [],
        body: "declared first",
      },
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    const answered = ["body", "title", "courier", "links", "attachments"];
    expect(Object.keys(r.data.item.properties)).toEqual(answered);
    const read = await client.getItem(r.data.item.id);
    expect(read.ok).toBe(true);
    expect(Object.keys(read.data.item.properties)).toEqual(answered);
  });

  it("keeps the order a whole edit behind the row finds, as a merge does", async () => {
    const r = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "declared first", courier: "undeclared" },
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    const moved = await client.updateItem(r.data.item.id, {
      properties: { anchor: "added elsewhere" },
      version: r.data.item.version,
    });
    expect(moved.ok).toBe(true);
    expect(Object.keys(moved.data.item.properties)).toEqual([
      "body",
      "courier",
      "anchor",
    ]);
    // Sent on the version before that write, it is merged: the properties
    // the row holds keep their places, and the one it adds goes after them.
    const behind = await client.updateItem(r.data.item.id, {
      properties: { zz: "added here", courier: "changed here", body: "kept" },
      properties_mode: "replace",
      version: r.data.item.version,
    });
    expect(behind.ok, JSON.stringify(behind.error)).toBe(true);
    expect(Object.keys(behind.data.item.properties)).toEqual([
      "body",
      "courier",
      "anchor",
      "zz",
    ]);
  });

  it("puts a property named by an array index first, in numeric order", async () => {
    const r = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: {
        zz: "sent first",
        body: "declared",
        "10": "ten",
        "2": "two",
      },
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    // `01` and `-1` are not array indices, so they keep the order sent.
    const merged = await client.updateItem(r.data.item.id, {
      properties: { "01": "padded", "7": "seven", "-1": "negative" },
      version: r.data.item.version,
    });
    expect(merged.ok).toBe(true);
    const order = ["2", "7", "10", "body", "zz", "01", "-1"];
    expect(Object.keys(merged.data.item.properties)).toEqual(order);
    const read = await client.getItem(r.data.item.id);
    expect(read.ok).toBe(true);
    expect(Object.keys(read.data.item.properties)).toEqual(order);
  });

  it("keeps the order a merge finds and adds after it, and takes the order a whole edit sends", async () => {
    const r = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { courier: "undeclared", body: "declared first" },
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(Object.keys(r.data.item.properties)).toEqual(["body", "courier"]);

    // A merge moves no key the row holds, so a declared field it adds goes
    // after them, as an undeclared one does, in the order it was sent.
    const merged = await client.updateItem(r.data.item.id, {
      properties: { anchor: "added first", title: "declared, added second" },
      version: r.data.item.version,
    });
    expect(merged.ok).toBe(true);
    expect(Object.keys(merged.data.item.properties)).toEqual([
      "body",
      "courier",
      "anchor",
      "title",
    ]);

    // A whole edit is the row's properties as sent, in the order sent.
    const replaced = await client.updateItem(r.data.item.id, {
      properties: { anchor: "first", title: "second", body: "third" },
      properties_mode: "replace",
      version: merged.data.item.version,
    });
    expect(replaced.ok).toBe(true);
    const sent = ["anchor", "title", "body"];
    expect(Object.keys(replaced.data.item.properties)).toEqual(sent);
    const read = await client.getItem(r.data.item.id);
    expect(read.ok).toBe(true);
    expect(Object.keys(read.data.item.properties)).toEqual(sent);
  });
});
