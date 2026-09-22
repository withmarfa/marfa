import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import type { TypeSchema } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "types"));
});

// `createTestContext` wraps `registerType` so a successful registration is
// tracked on the context, and `cleanup` owns removing it. A second delete loop
// here would be a second owner for the same row: it deletes the type, then
// cleanup's delete answers not-found and reports a fixture it did not leak.
afterAll(async () => {
  await cleanup(ctx);
});

describe("type registration and listing", () => {
  it("registers a custom type", async () => {
    const customType: TypeSchema = {
      id: `user.evaluator-custom-${ctx.runId}`,
      fields: {
        name: { type: "string", required: true, searchable: true },
        count: { type: "number" },
      },
    };

    const r = await client.registerType(customType);
    expect(r.ok).toBe(true);
    expect(r.data.type.id).toBe(customType.id);
  });

  it("lists registered types", async () => {
    const r = await client.listTypes();
    expect(r.ok).toBe(true);
    expect(r.data.length).toBeGreaterThanOrEqual(1);

    const typeIds = r.data.map((t) => t.id);
    expect(typeIds).toContain("core.note");
    expect(typeIds).toContain("core.bookmark");
  });

  it("lists every shipped type the suite writes against", async () => {
    // A fixture elsewhere names each of these, so a registry that stopped
    // shipping one would take that fixture down with a refusal nothing here
    // explains. Pinning the set makes the registry answer for it directly.
    const shipped = [
      "core.bookmark",
      "core.entity",
      "core.entity.person",
      "core.entity.place",
      "core.event",
      "core.file.image",
      "core.highlight",
      "core.media.article",
      "core.media.book",
      "core.message",
      "core.note",
      "core.task",
    ];

    const r = await client.listTypes();
    expect(r.ok).toBe(true);
    const byId = new Map(r.data.map((t) => [t.id, t]));

    for (const id of shipped) {
      const entry = byId.get(id);
      expect(entry, `${id} is not in GET /types`).toBeDefined();
      expect(Object.keys(entry!.fields).length).toBeGreaterThan(0);
    }
  });

  it("items of a custom type follow the universal lifecycle", async () => {
    // Lifecycle is metadata-layer and universal (active | archived | trashed).
    // Custom types inherit the same states; a schema declares none of its own.
    const typeName = `user.evaluator-lifecycle-${ctx.runId}`;
    await client.registerType({
      id: typeName,
      fields: { name: { type: "string", required: true } },
    });

    const r = await client.createItem({
      type: typeName,
      properties: { name: "Test item" },
      source: ctx.source,
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item.state).toBe("active");

    const archived = await client.transitionItem(r.data.item.id, "archived");
    expect(archived.ok).toBe(true);
    expect(archived.data.item.state).toBe("archived");

    const invalid = await client.transitionItem(r.data.item.id, "nonexistent");
    expect(invalid.status).toBe(400);
    expect(invalid.error?.error.code).toBe("validation_error");
  });

  it("rejects type registration with invalid type identifier", async () => {
    const r = await client.registerType({
      id: "invalid",
      fields: {},
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("validation_error");
    // The field is the witness. `validation_error` is the code every other
    // shape failure on this door answers with, so the code alone would still
    // pass if the grammar gate went and the body were refused elsewhere.
    const errors = r.error?.error.details?.errors as
      { path: string }[] | undefined;
    expect(errors?.[0]?.path).toBe("id");
  });

  it("rejects type registration without fields", async () => {
    const r = await client.registerType({
      id: "user.evaluator-nofields",
      fields: undefined as unknown as Record<string, never>,
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("missing_required_field");
  });

  // Custom-type schemas may not declare property names that collide with
  // first-class Item wire fields (`source_id`, `occurred_at`,
  // `version`, `schema_version`, `tier`, `state`, `capture_latitude`,
  // `capture_longitude`, plus the structural keys). Letting a property
  // shadow a first-class field name produces ambiguous data: two values
  // under the same key, with nothing telling downstream consumers which is
  // authoritative. The server returns 400 `property_shadows_field`.
  it("rejects type registration whose property name shadows a first-class Item field", async () => {
    const id = `user.shadow-capture-${ctx.runId}`;
    const r = await client.registerType({
      id,
      fields: {
        capture_latitude: { type: "number" },
      },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("property_shadows_field");
  });
});

// Per-type merge policy drives client-side conflict resolution.
describe("type merge_policy", () => {
  it("GET /types/core.note returns the artifact-declared merge_policy", async () => {
    const r = await client.getType("core.note");
    expect(r.ok).toBe(true);
    expect(r.data.merge_policy).toBeDefined();
    expect(r.data.merge_policy?.default).toBe("last_writer_wins");
    expect(r.data.merge_policy?.fields?.body).toBe("keep_both_copies");
    expect(r.data.merge_policy?.fields?.notes).toBe("keep_both_copies");
    // Last-writer-wins fields must NOT appear under `fields` — they fall
    // through to the `default` strategy. The artifact's principle is that
    // only deviations from the default are listed.
    expect(r.data.merge_policy?.fields?.title).toBeUndefined();
    expect(r.data.merge_policy?.fields?.language).toBeUndefined();
  });

  it("POST /types accepts a custom type with a valid merge_policy", async () => {
    const typeId = `user.evaluator-mp-valid-${ctx.runId}`;
    const r = await client.registerType({
      id: typeId,
      fields: {
        title: { type: "string" },
        body: { type: "string" },
      },
      merge_policy: {
        fields: { body: "keep_both_copies" },
        default: "last_writer_wins",
      },
    } as TypeSchema);
    expect(r.ok).toBe(true);

    const fetched = await client.getType(typeId);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.merge_policy?.fields?.body).toBe("keep_both_copies");
    expect(fetched.data.merge_policy?.default).toBe("last_writer_wins");
  });

  it("POST /types rejects a merge_policy referencing an unknown field", async () => {
    const typeId = `user.evaluator-mp-unknown-field-${ctx.runId}`;
    const r = await client.registerType({
      id: typeId,
      fields: { body: { type: "string" } },
      merge_policy: {
        fields: { does_not_exist: "keep_both_copies" },
      },
    } as TypeSchema);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    // The code, not only the status. `invalid_schema` is what the validator
    // answers when nothing more specific applies, and a 400 alone cannot
    // tell it from the shape refusals the route's own body schema answers.
    expect(r.error?.error.code).toBe("invalid_schema");
  });

  it("POST /types rejects a merge_policy with an unknown strategy", async () => {
    const typeId = `user.evaluator-mp-bad-strategy-${ctx.runId}`;
    const r = await client.registerType({
      id: typeId,
      fields: { body: { type: "string" } },
      // Cast through unknown — the client typings forbid this exact malformation,
      // which is the contract we're asserting the server enforces.
      merge_policy: {
        fields: { body: "made_up_strategy" as unknown as "keep_both_copies" },
      },
    } as TypeSchema);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_schema");
  });

  it("a core child type exposes the parent's resolved merge_policy on GET", async () => {
    // core.entity.person extends core.entity; the parent declares only
    // `default: last_writer_wins` and no per-field overrides, and that is what
    // the resolved policy must expose on the child.
    const fetched = await client.getType("core.entity.person");
    expect(fetched.ok).toBe(true);
    expect(fetched.data.merge_policy).toBeDefined();
    expect(fetched.data.merge_policy?.default).toBe("last_writer_wins");
    // No keep-both fields on the entity branch.
    expect(fetched.data.merge_policy?.fields ?? {}).toEqual({});
  });

  it("a runtime-registered custom child type inherits the parent's resolved merge_policy on GET", async () => {
    // A runtime-registered child of `core.note` without its own declaration
    // inherits the parent's resolved policy: `body` and `notes` keep-both, default
    // last-writer-wins. The inheritance is honored both at request time
    // (this test) and at conflict time (covered in
    // correctness/merge-policy.test.ts).
    //
    // The child is registered under `user.*`: inheriting from a core parent is
    // the thing under test, and the child's own id has to sit outside the
    // reserved namespaces because nothing registers a `core.*` type over
    // HTTP.
    const childId = `user.note-evaluator-inherit-${ctx.runId}`;
    const cr = await client.registerType({
      id: childId,
      parent: "core.note",
      fields: { extra: { type: "string" } },
    });
    expect(cr.ok).toBe(true);

    const fetched = await client.getType(childId);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.merge_policy).toBeDefined();
    expect(fetched.data.merge_policy?.default).toBe("last_writer_wins");
    expect(fetched.data.merge_policy?.fields?.body).toBe("keep_both_copies");
    expect(fetched.data.merge_policy?.fields?.notes).toBe("keep_both_copies");
  });

  it("answers 404 for a type that is not registered", async () => {
    const r = await client.getType(`user.absent-${ctx.runId}`);
    expect(r.status).toBe(404);
    expect(r.error?.error.code).toBe("type_not_found");
  });
});
