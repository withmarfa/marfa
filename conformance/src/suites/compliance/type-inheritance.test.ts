import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "type-inheritance"));
});

// `createTestContext` wraps `registerType` so a successful registration is
// tracked on the context, and `cleanup` owns removing it. A second delete loop
// here would be a second owner for the same row: it deletes the type, then
// cleanup's delete answers not-found and reports a fixture it did not leak.
afterAll(async () => {
  await cleanup(ctx);
});

describe("type inheritance rule", () => {
  it("accepts a child type that adds a field not present on the parent", async () => {
    const parentId = `user.inherit-add-parent-${ctx.runId}`;
    const childId = `${parentId}.child`;

    const pr = await client.registerType({
      id: parentId,
      fields: { url: { type: "string" } },
    });
    expect(pr.ok).toBe(true);

    const cr = await client.registerType({
      id: childId,
      parent: parentId,
      fields: { supplemental: { type: "string" } },
    });
    expect(cr.ok).toBe(true);

    const read = await client.getType(childId);
    expect(read.ok).toBe(true);
    expect(Object.keys(read.data.fields ?? {}).sort()).toEqual([
      "supplemental",
      "url",
    ]);
  });

  // A child may sharpen an inherited field's description or tighten it to
  // required, but may not change what the field is. The server returns 400
  // `inheritance_violation` when a child registered with an explicit `parent`
  // changes an ancestor field's *shape*. Dotted ids alone do not imply
  // inheritance — `parent` must be set.
  //
  // Both halves of the boundary are pinned below, because an assertion in one
  // direction alone cannot tell "the rule works" from "the rule never fires".
  it("rejects a child type that changes an inherited field shape (inheritance_violation)", async () => {
    const parentId = `user.inherit-collide-parent-${ctx.runId}`;
    const childId = `${parentId}.child`;

    const pr = await client.registerType({
      id: parentId,
      fields: { url: { type: "string" } },
    });
    expect(pr.ok).toBe(true);

    const cr = await client.registerType({
      id: childId,
      parent: parentId,
      fields: { url: { type: "integer" } }, // changes the inherited shape
    });
    expect(cr.ok).toBe(false);
    expect(cr.status).toBe(400);
    expect(cr.error?.error.code).toBe("inheritance_violation");
  });

  it("accepts a child that redeclares an inherited field without changing it", async () => {
    const parentId = `user.inherit-same-parent-${ctx.runId}`;
    const childId = `${parentId}.child`;

    const pr = await client.registerType({
      id: parentId,
      fields: { url: { type: "string" } },
    });
    expect(pr.ok).toBe(true);

    // Same shape, sharpened description — the documented legal move. If this
    // ever starts rejecting, the rule above has grown teeth it should not have.
    const cr = await client.registerType({
      id: childId,
      parent: parentId,
      fields: { url: { type: "string", description: "The canonical link." } },
    });
    expect(cr.ok).toBe(true);
  });

  it("a child reads back with the parent's fields merged beside its own", async () => {
    const parentId = `user.inherit-merge-parent-${ctx.runId}`;
    const childId = `${parentId}.child`;

    const pr = await client.registerType({
      id: parentId,
      fields: { url: { type: "string" } },
    });
    expect(pr.ok).toBe(true);

    const cr = await client.registerType({
      id: childId,
      parent: parentId,
      fields: { supplemental: { type: "string" } },
    });
    expect(cr.ok).toBe(true);
    expect(cr.data.type.fields).toEqual({ supplemental: { type: "string" } });

    const fetched = await client.getType(childId);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.parent).toBe(parentId);
    expect(fetched.data.fields).toEqual({
      url: { type: "string" },
      supplemental: { type: "string" },
    });

    const item = await client.createItem({
      type: childId,
      source: ctx.source,
      properties: {
        url: "https://example.com/inherited",
        supplemental: "own field",
      },
    });
    expect(item.ok).toBe(true);
    trackItem(ctx, item.data.item.id);
    expect(item.data.item.properties.url).toBe("https://example.com/inherited");
    expect(item.data.item.properties.supplemental).toBe("own field");
  });

  it("core entity/file/media subtypes resolve", async () => {
    const r = await client.listTypes();
    expect(r.ok).toBe(true);
    const ids = new Set(r.data.map((t) => t.id));

    // The subtypes that have to resolve for inheritance-aware behavior.
    const expected = [
      "core.entity.person",
      "core.entity.place",
      "core.file.image",
      "core.media.book",
      "core.media.article",
    ];
    for (const id of expected) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("accepts compatible_with: core.note when fields satisfy the structural superset", async () => {
    const id = `user.compat-with-superset-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const r = await client.registerType({
      id,
      label: "Compat",
      version: 1,
      fields: {
        body: { type: "string", required: true },
        extra: { type: "string" },
      },
      compatible_with: "core.note",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects compatible_with target that does not exist", async () => {
    const id = `user.compat-with-missing-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const r = await client.registerType({
      id,
      label: "Compat-missing",
      version: 1,
      fields: { body: { type: "string", required: true } },
      compatible_with: "no.such-type-exists",
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(422);
    expect(r.error?.error.code).toBe("compatible_with_violation");
  });

  it("rejects compatible_with when a required ancestor field is missing", async () => {
    const id = `user.compat-with-missing-field-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const r = await client.registerType({
      id,
      label: "Compat-missing-field",
      version: 1,
      // core.note requires `body`; this declaration omits it.
      fields: { extra: { type: "string" } },
      compatible_with: "core.note",
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(422);
    expect(r.error?.error.code).toBe("compatible_with_violation");
  });
});
