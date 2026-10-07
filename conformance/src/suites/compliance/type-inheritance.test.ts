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

  // The witness is the registration beside it: the same child under a parent
  // that resolves is accepted, so the refusal is the parent's and nothing else.
  it("refuses a parent nothing registered, and accepts the same child under one that is", async () => {
    const parentId = `user.inherit-absent-parent-${ctx.runId}`;
    const childId = `${parentId}.child`;

    const refused = await client.registerType({
      id: childId,
      parent: parentId,
      fields: { extra: { type: "string" } },
    });
    expect(refused.ok).toBe(false);
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect((await client.getType(childId)).status).toBe(404);

    const pr = await client.registerType({
      id: parentId,
      fields: { url: { type: "string" } },
    });
    expect(pr.ok).toBe(true);
    const cr = await client.registerType({
      id: childId,
      parent: parentId,
      fields: { extra: { type: "string" } },
    });
    expect(cr.ok).toBe(true);
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

  it("lets a child tighten an inherited field to required, and refuses one that loosens it", async () => {
    const looseParent = `user.inherit-tighten-parent-${ctx.runId}`;
    expect(
      (
        await client.registerType({
          id: looseParent,
          fields: { url: { type: "string" } },
        })
      ).status,
    ).toBe(201);
    const tightened = await client.registerType({
      id: `${looseParent}.child`,
      parent: looseParent,
      fields: { url: { type: "string", required: true } },
    });
    expect(tightened.status, JSON.stringify(tightened.error)).toBe(201);
    // Tightening binds the child's items and leaves the parent's alone.
    const bare = (type: string) =>
      client.createItem({ type, properties: {}, source: ctx.source });
    const refused = await bare(`${looseParent}.child`);
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    const parentItem = await bare(looseParent);
    expect(parentItem.status).toBe(201);
    trackItem(ctx, parentItem.data.item.id);

    const strictParent = `user.inherit-loosen-parent-${ctx.runId}`;
    expect(
      (
        await client.registerType({
          id: strictParent,
          fields: { url: { type: "string", required: true } },
        })
      ).status,
    ).toBe(201);
    // The witness: the same redeclaration keeping `required` is accepted.
    const kept = await client.registerType({
      id: `${strictParent}.kept`,
      parent: strictParent,
      fields: { url: { type: "string", required: true } },
    });
    expect(kept.status, JSON.stringify(kept.error)).toBe(201);

    const loosened = await client.registerType({
      id: `${strictParent}.loosened`,
      parent: strictParent,
      fields: { url: { type: "string", required: false } },
    });
    expect(loosened.status).toBe(400);
    expect(loosened.error?.error.code).toBe("inheritance_violation");
    expect(
      (loosened.error?.error.details?.errors as { field: string }[]).map(
        (e) => e.field,
      ),
    ).toContain("fields.url.required");
    expect((await client.getType(`${strictParent}.loosened`)).status).toBe(404);
  });

  it("refuses a replacement of a child that changes an inherited field's shape", async () => {
    const parentId = `user.inherit-put-parent-${ctx.runId}`;
    const childId = `${parentId}.child`;
    expect(
      (
        await client.registerType({
          id: parentId,
          fields: { url: { type: "string" } },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await client.registerType({
          id: childId,
          parent: parentId,
          fields: { extra: { type: "string" } },
        })
      ).status,
    ).toBe(201);

    const refused = await client.replaceType(childId, {
      parent: parentId,
      fields: { url: { type: "integer" } },
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("inheritance_violation");
    expect(
      (refused.error?.error.details?.errors as { field: string }[]).map(
        (e) => e.field,
      ),
    ).toContain("fields.url.type");
    // The refusal changed nothing.
    expect(Object.keys((await client.getType(childId)).data.fields)).toEqual([
      "url",
      "extra",
    ]);

    // The witness: the replacement keeping the shape is taken.
    const kept = await client.replaceType(childId, {
      parent: parentId,
      fields: {
        url: { type: "string", description: "The canonical link." },
      },
    });
    expect(kept.status, JSON.stringify(kept.error)).toBe(200);
  });

  it("refuses a parent chain deeper than ten, and a circular one", async () => {
    // A type's ancestors above it are what the cap counts: the eleventh
    // ancestor is refused and the tenth is not.
    const chain = (i: number) => `user.chain-${ctx.runId}-${String(i)}`;
    expect(
      (await client.registerType({ id: chain(0), fields: {} })).status,
    ).toBe(201);
    for (let i = 1; i <= 10; i++) {
      const r = await client.registerType({
        id: chain(i),
        parent: chain(i - 1),
        fields: {},
      });
      expect(r.status, `${String(i)} ancestors`).toBe(201);
    }
    const tooDeep = await client.registerType({
      id: chain(11),
      parent: chain(10),
      fields: {},
    });
    expect(tooDeep.status).toBe(400);
    expect(tooDeep.error?.error.code).toBe("validation_error");
    expect(tooDeep.error?.error.message).toContain("maximum depth of 10");
    expect((await client.getType(chain(11))).status).toBe(404);

    // A replacement that makes a type its own ancestor, and its own parent.
    const loop = await client.replaceType(chain(9), {
      parent: chain(10),
      fields: {},
    });
    expect(loop.status).toBe(400);
    expect(loop.error?.error.code).toBe("validation_error");
    expect(loop.error?.error.message).toContain("Circular");
    const self = await client.replaceType(chain(5), {
      parent: chain(5),
      fields: {},
    });
    expect(self.status).toBe(400);
    expect(self.error?.error.code).toBe("validation_error");
    expect(self.error?.error.message).toContain("Circular");
    expect((await client.getType(chain(9))).data.parent).toBe(chain(8));
    expect((await client.getType(chain(5))).data.parent).toBe(chain(4));

    // The subtypes below a type count with the ancestors above it: a root
    // with two levels beneath it takes a parent eight deep, and not nine.
    const low = (i: number) => `user.low-${ctx.runId}-${String(i)}`;
    expect((await client.registerType({ id: low(0), fields: {} })).status).toBe(
      201,
    );
    for (let i = 1; i <= 2; i++) {
      expect(
        (
          await client.registerType({
            id: low(i),
            parent: low(i - 1),
            fields: {},
          })
        ).status,
      ).toBe(201);
    }
    const tooLow = await client.replaceType(low(0), {
      parent: chain(8),
      fields: {},
    });
    expect(tooLow.status).toBe(400);
    expect(tooLow.error?.error.code).toBe("validation_error");
    expect(tooLow.error?.error.message).toContain("subtypes");
    const fits = await client.replaceType(low(0), {
      parent: chain(7),
      fields: {},
    });
    expect(fits.status, JSON.stringify(fits.error)).toBe(200);
  });

  it("rejects a parent gaining a field whose shape differs from one its child declares", async () => {
    const parentId = `user.inherit-late-parent-${ctx.runId}`;
    const childId = `${parentId}.child`;
    expect(
      (
        await client.registerType({
          id: parentId,
          fields: { name: { type: "string" } },
        })
      ).ok,
    ).toBe(true);
    const cr = await client.registerType({
      id: childId,
      parent: parentId,
      fields: { count: { type: "string" } },
    });
    expect(cr.ok, JSON.stringify(cr.error)).toBe(true);

    const changed = await client.replaceType(parentId, {
      id: parentId,
      version: 2,
      fields: { name: { type: "string" }, count: { type: "integer" } },
    });
    expect(
      changed.status,
      "a parent gained a field its child already declares with another shape, so the child's items are read by one and validated by the other",
    ).toBe(400);
    expect(
      changed.error?.error.code,
      "the update door answered the inheritance rule with another code than the registration door does",
    ).toBe("inheritance_violation");
    const errors = changed.error?.error.details?.errors as
      Array<{ field: string; code?: string }> | undefined;
    expect(errors?.map((error) => [error.field, error.code])).toContainEqual([
      "fields.count.type",
      "inheritance_violation",
    ]);
    // The witness: the parent gaining the field as its child declares it is
    // taken.
    const same = await client.replaceType(parentId, {
      id: parentId,
      version: 2,
      fields: { name: { type: "string" }, count: { type: "string" } },
    });
    expect(same.ok, JSON.stringify(same.error)).toBe(true);
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
    const ids = new Set(r.data.data.map((t) => t.id));

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

  it("refuses a compatible_with claim whose target field the type declares in another shape, or optional where the target requires it", async () => {
    const target = `user.compat-target-${ctx.runId}`;
    expect(
      (
        await client.registerType({
          id: target,
          fields: {
            title: { type: "string", required: true },
            count: { type: "number" },
          },
        })
      ).status,
    ).toBe(201);
    const claim = (
      name: string,
      fields: Record<string, { type: "string" | "number"; required?: boolean }>,
    ) =>
      client.registerType({
        id: `user.compat-${name}-${ctx.runId}`,
        fields,
        compatible_with: target,
      });

    // The witness: the shapes as the target declares them satisfy the claim.
    const sound = await claim("sound", {
      title: { type: "string", required: true },
      count: { type: "number" },
    });
    expect(sound.status, JSON.stringify(sound.error)).toBe(201);

    const requiredShape = await claim("required-shape", {
      title: { type: "number", required: true },
    });
    expect(requiredShape.status).toBe(422);
    expect(requiredShape.error?.error.code).toBe("compatible_with_violation");

    const optionalShape = await claim("optional-shape", {
      title: { type: "string", required: true },
      count: { type: "string" },
    });
    expect(optionalShape.status).toBe(422);
    expect(optionalShape.error?.error.code).toBe("compatible_with_violation");

    const optional = await claim("optional", {
      title: { type: "string" },
    });
    expect(optional.status).toBe(422);
    expect(optional.error?.error.code).toBe("compatible_with_violation");
    expect(
      (await client.getType(`user.compat-optional-${ctx.runId}`)).status,
    ).toBe(404);
  });
});
