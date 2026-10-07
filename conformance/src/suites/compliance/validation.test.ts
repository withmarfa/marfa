import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote, generateId } from "../../generators/items.js";

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

  it("refuses a client-minted id that is not a lowercase UUIDv7", async () => {
    const lowercase = generateId();
    const refusals = [
      ["a UUIDv4", "9b2e4f64-5c1d-4e8a-9f3b-2d7c6a1e0b55"],
      ["an uppercase UUIDv7", lowercase.toUpperCase()],
    ] as const;
    for (const [label, id] of refusals) {
      const sourceId = `bad-id-${generateId()}`;
      const refused = await client.createItem(
        createNote({ id, source: ctx.source, source_id: sourceId }),
      );
      expect(
        [refused.status, refused.error?.error.code],
        `${label} was not refused`,
      ).toEqual([400, "invalid_id"]);
      // Nothing was written: the natural key it named is still free, so a
      // create naming it lands as a new row rather than an upsert.
      const free = await client.createItem(
        createNote({ source: ctx.source, source_id: sourceId }),
      );
      expect(free.status, `${label} left a row behind`).toBe(201);
      trackItem(ctx, free.data.item.id);
    }

    // The witness: the lowercase UUIDv7 is taken as the row's id.
    const accepted = await client.createItem(
      createNote({ id: lowercase, source: ctx.source }),
    );
    expect(accepted.status, JSON.stringify(accepted.error)).toBe(201);
    trackItem(ctx, accepted.data.item.id);
    expect(accepted.data.item.id).toBe(lowercase);
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

  it("refuses a string one unit over the default length cap, naming the field", async () => {
    const over = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { body: "x".repeat(100_001) },
      }),
    );
    expect(over.status).toBe(400);
    expect(over.error?.error.code).toBe("invalid_properties");
    const errors = over.error?.error.details?.errors as
      Array<{ field: string }> | undefined;
    expect(errors?.map((e) => e.field)).toContain("body");

    // The witness: one unit fewer is accepted.
    const edge = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { body: "x".repeat(100_000) },
      }),
    );
    expect(edge.status, JSON.stringify(edge.error)).toBe(201);
    trackItem(ctx, edge.data.item.id);
  });

  it("refuses a NUL in a string property, naming the field", async () => {
    const refused = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { body: "before\u0000after" },
      }),
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    const errors = refused.error?.error.details?.errors as
      Array<{ field: string }> | undefined;
    expect(errors?.map((e) => e.field)).toContain("body");

    // The witness: the same text without the NUL is accepted.
    const accepted = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { body: "beforeafter" },
      }),
    );
    expect(accepted.status, JSON.stringify(accepted.error)).toBe(201);
    trackItem(ctx, accepted.data.item.id);
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

  it("takes a filter of 2,048 characters and refuses one of 2,049, on the listing and the search", async () => {
    const withLength = (length: number): string => {
      const head = 'properties.body eq "';
      return `${head}${"x".repeat(length - head.length - 1)}"`;
    };
    expect(withLength(2048)).toHaveLength(2048);
    for (const door of ["/items?", "/search?q=note&"]) {
      const largest = await client.rawRequest<unknown>(
        `${door}filter=${encodeURIComponent(withLength(2048))}`,
      );
      expect(largest.status, `${door} 2048`).toBe(200);
      const smallest = await client.rawRequest<unknown>(
        `${door}filter=${encodeURIComponent(withLength(2049))}`,
      );
      expect(smallest.status, `${door} 2049`).toBe(400);
      expect(smallest.error?.error.code).toBe("validation_error");
    }
  });

  it("takes a filter of 10 conditions and refuses one of 11, on the listing and the search", async () => {
    const note = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { title: "ten", body: `tenconditions${ctx.runId}` },
      }),
    );
    expect(note.status, JSON.stringify(note.error)).toBe(201);
    trackItem(ctx, note.data.item.id);
    const joined = (count: number, logical: "AND" | "OR"): string =>
      Array.from({ length: count }, () => `source eq "${ctx.source}"`).join(
        ` ${logical} `,
      );
    for (const logical of ["AND", "OR"] as const) {
      for (const door of ["/items?", `/search?q=tenconditions${ctx.runId}&`]) {
        const largest = await client.rawRequest<{
          data: ({ id: string } | { item: { id: string } })[];
        }>(`${door}filter=${encodeURIComponent(joined(10, logical))}`);
        expect(largest.status, `${door} ${logical} 10`).toBe(200);
        // The witness that the ten were read and not skipped: the row is
        // answered under them.
        expect(
          largest.data.data.map((r) => ("item" in r ? r.item.id : r.id)),
        ).toContain(note.data.item.id);

        const smallest = await client.rawRequest<unknown>(
          `${door}filter=${encodeURIComponent(joined(11, logical))}`,
        );
        expect(smallest.status, `${door} ${logical} 11`).toBe(400);
        expect(smallest.error?.error.code).toBe("validation_error");
      }
    }
  });

  it("refuses a filter that mixes AND with OR, on the listing and the search", async () => {
    const only = (logical: "AND" | "OR") =>
      `type eq "core.note" ${logical} state eq "active" ${logical} source eq "${ctx.source}"`;
    const mixed = `type eq "core.note" AND state eq "active" OR source eq "${ctx.source}"`;
    for (const door of ["/items?", "/search?q=note&"]) {
      // The witness: each logical operator on its own is taken.
      for (const logical of ["AND", "OR"] as const) {
        const taken = await client.rawRequest<unknown>(
          `${door}filter=${encodeURIComponent(only(logical))}`,
        );
        expect(taken.status, `${door} ${logical}`).toBe(200);
      }
      const refused = await client.rawRequest<unknown>(
        `${door}filter=${encodeURIComponent(mixed)}`,
      );
      expect(refused.status, door).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
    }
  });

  it("refuses a filter that uses OR beside an edge shorthand, which joins it with AND", async () => {
    const target = generateId();
    const shorthand = `edge[about]=${target}`;
    const or = `type eq "core.note" OR type eq "core.bookmark"`;
    const and = `type eq "core.note" AND state eq "active"`;
    // The witness: an OR filter alone and an AND filter with the shorthand
    // are both taken, so the refusal is the pair's.
    const alone = await client.rawRequest<unknown>(
      `/items?filter=${encodeURIComponent(or)}`,
    );
    expect(alone.status).toBe(200);
    const withAnd = await client.rawRequest<unknown>(
      `/items?${shorthand}&filter=${encodeURIComponent(and)}`,
    );
    expect(withAnd.status, JSON.stringify(withAnd.error)).toBe(200);

    const refused = await client.rawRequest<unknown>(
      `/items?${shorthand}&filter=${encodeURIComponent(or)}`,
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
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

  it("clears nothing with a null under a merge, declared or not", async () => {
    const r = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "b", notes: "declared", courier: "undeclared" },
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    const merged = await client.updateItem(r.data.item.id, {
      properties: { notes: null, courier: null, title: "changed" },
      version: r.data.item.version,
    });
    expect(merged.ok, JSON.stringify(merged.error)).toBe(true);
    expect(merged.data.item.properties).toEqual({
      body: "b",
      notes: "declared",
      courier: "undeclared",
      title: "changed",
    });
    // The witness: a whole edit that leaves them out clears both.
    const replaced = await client.updateItem(r.data.item.id, {
      properties: { body: "b", title: "changed" },
      properties_mode: "replace",
      version: merged.data.item.version,
    });
    expect(replaced.ok).toBe(true);
    expect(replaced.data.item.properties).toEqual({
      body: "b",
      title: "changed",
    });
  });

  it("refuses a null on a field the type requires under a merge", async () => {
    const created = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { body: "required", title: "kept" },
      }),
    );
    expect(created.ok).toBe(true);
    trackItem(ctx, created.data.item.id);
    const id = created.data.item.id;

    const refused = await client.updateItem(id, {
      properties: { body: null },
      version: created.data.item.version,
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    const errors = refused.error?.error.details?.errors as
      Array<{ field: string }> | undefined;
    expect(errors?.map((e) => e.field)).toContain("body");

    const read = await client.getItem(id);
    expect(read.data.item.version).toBe(created.data.item.version);
    expect(read.data.item.properties).toEqual({
      body: "required",
      title: "kept",
    });

    // The witness: the same merge naming a value for the field lands.
    const merged = await client.updateItem(id, {
      properties: { body: "changed" },
      version: created.data.item.version,
    });
    expect(merged.ok, JSON.stringify(merged.error)).toBe(true);
    expect(merged.data.item.properties.body).toBe("changed");
  });

  it("leaves out a create's null on a declared optional field, and keeps one on an undeclared property", async () => {
    const r = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: {
        body: "b",
        title: null,
        links: null,
        attachments: null,
        courier: null,
      },
    });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item.properties).toEqual({ body: "b", courier: null });
    const read = await client.getItem(r.data.item.id);
    expect(read.ok).toBe(true);
    expect(read.data.item.properties).toEqual({ body: "b", courier: null });
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
