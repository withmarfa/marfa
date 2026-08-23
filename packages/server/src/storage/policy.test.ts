import { describe, expect, it } from "vitest";
import { TYPE_REGISTRY, typeHasRole } from "@withmarfa/shared";
import type { TypeSchema } from "@withmarfa/shared";
import { resolveMergePolicy, resolveTypeSchema } from "./policy.js";
import type { TypeResolver } from "./policy.js";

// The core registry resolves types globally; wrap it as a resolver function.
const coreResolver: TypeResolver = (id) => TYPE_REGISTRY.get(id);

function makeResolver(schemas: TypeSchema[]): TypeResolver {
  const m = new Map<string, TypeSchema>();
  for (const s of schemas) m.set(s.id, s);
  return (id) => m.get(id);
}

describe("resolveMergePolicy", () => {
  it("returns an empty policy for unknown types", () => {
    const result = resolveMergePolicy("missing.type", coreResolver);
    expect(result).toEqual({});
  });

  it("returns the type's own policy when no parent", () => {
    const result = resolveMergePolicy("core.note", coreResolver);
    expect(result.fields?.body).toBe("keep_both_copies");
    expect(result.fields?.notes).toBe("keep_both_copies");
    expect(result.default).toBe("last_writer_wins");
  });

  it("inherits keep-both fields from parent (core.media.book)", () => {
    const result = resolveMergePolicy("core.media.book", coreResolver);
    expect(result.fields?.body).toBe("keep_both_copies");
    expect(result.fields?.notes).toBe("keep_both_copies");
    expect(result.default).toBe("last_writer_wins");
  });

  it("entity.person inherits parent's empty keep-both policy", () => {
    const result = resolveMergePolicy("core.entity.person", coreResolver);
    expect(result.fields ?? {}).toEqual({});
    expect(result.default).toBe("last_writer_wins");
  });

  it("child overrides one parent field per-key", () => {
    const parent: TypeSchema = {
      id: "test.parent",
      version: 1,
      fields: { body: { type: "string" }, notes: { type: "string" } },
      merge_policy: {
        fields: { body: "keep_both_copies", notes: "keep_both_copies" },
        default: "last_writer_wins",
      },
    };
    const child: TypeSchema = {
      id: "test.child",
      parent: "test.parent",
      version: 1,
      fields: { body: { type: "string" }, notes: { type: "string" } },
      merge_policy: {
        fields: { body: "last_writer_wins" },
      },
    };
    const result = resolveMergePolicy(
      "test.child",
      makeResolver([parent, child]),
    );
    expect(result.fields?.body).toBe("last_writer_wins");
    expect(result.fields?.notes).toBe("keep_both_copies");
    expect(result.default).toBe("last_writer_wins");
  });

  it("child with empty fields does not erase parent entries", () => {
    const parent: TypeSchema = {
      id: "test.parent2",
      version: 1,
      fields: { body: { type: "string" } },
      merge_policy: {
        fields: { body: "keep_both_copies" },
        default: "last_writer_wins",
      },
    };
    const child: TypeSchema = {
      id: "test.child2",
      parent: "test.parent2",
      version: 1,
      fields: { body: { type: "string" } },
      merge_policy: { fields: {} },
    };
    const result = resolveMergePolicy(
      "test.child2",
      makeResolver([parent, child]),
    );
    expect(result.fields?.body).toBe("keep_both_copies");
  });

  it("child default replaces parent default", () => {
    const parent: TypeSchema = {
      id: "test.parent3",
      version: 1,
      fields: { body: { type: "string" } },
      merge_policy: { default: "last_writer_wins" },
    };
    const child: TypeSchema = {
      id: "test.child3",
      parent: "test.parent3",
      version: 1,
      fields: { body: { type: "string" } },
      merge_policy: { default: "keep_both_copies" },
    };
    const result = resolveMergePolicy(
      "test.child3",
      makeResolver([parent, child]),
    );
    expect(result.default).toBe("keep_both_copies");
  });

  it("walks a multi-level chain (grandparent → parent → child)", () => {
    const grandparent: TypeSchema = {
      id: "test.gp",
      version: 1,
      fields: { a: { type: "string" }, b: { type: "string" } },
      merge_policy: {
        fields: { a: "keep_both_copies" },
        default: "last_writer_wins",
      },
    };
    const parent: TypeSchema = {
      id: "test.gp.p",
      parent: "test.gp",
      version: 1,
      fields: { a: { type: "string" }, b: { type: "string" } },
      merge_policy: { fields: { b: "keep_both_copies" } },
    };
    const child: TypeSchema = {
      id: "test.gp.p.c",
      parent: "test.gp.p",
      version: 1,
      fields: { a: { type: "string" }, b: { type: "string" } },
    };
    const result = resolveMergePolicy(
      "test.gp.p.c",
      makeResolver([grandparent, parent, child]),
    );
    expect(result.fields?.a).toBe("keep_both_copies");
    expect(result.fields?.b).toBe("keep_both_copies");
    expect(result.default).toBe("last_writer_wins");
  });
});

// Property-based agreement test: every type in the live registry should resolve
// identically through the codegen-time inheritance (already baked into ALL_TYPES
// / TYPE_REGISTRY) and the runtime resolveMergePolicy. This guards against the
// "two implementations diverge" risk in the rollout plan.
describe("resolveMergePolicy — agreement with codegen-time resolution", () => {
  it("matches the inlined merge_policy on every core type", () => {
    for (const [typeId, schema] of TYPE_REGISTRY.entries()) {
      const resolved = resolveMergePolicy(typeId, coreResolver);
      const baked = schema.merge_policy ?? {};
      const expectedFields = baked.fields ?? {};
      const actualFields = resolved.fields ?? {};
      expect(actualFields, `fields disagree for ${typeId}`).toEqual(
        expectedFields,
      );
      expect(resolved.default, `default disagrees for ${typeId}`).toBe(
        baked.default,
      );
    }
  });
});

/**
 * The read surface has to agree with the rule it describes.
 *
 * `in-collection` constrains its target on `role:container`, and `typeHasRole`
 * answers that by walking the parent chain, so a subtype of a container is
 * already an acceptable target. The type read used to project `roles` away
 * entirely: every type reported none, including the three that declare it, so
 * a client had no way to build the list except by hardcoding names or
 * attempting a write to find out. A generated kit surfaced the field as always
 * empty, which reads as a definite "declares no roles" rather than as missing.
 */
describe("resolveTypeSchema roles", () => {
  it("returns the role for a type that declares it", () => {
    for (const id of ["core.media.series", "core.media.album"]) {
      expect(resolveTypeSchema(id, coreResolver)?.roles).toEqual(["container"]);
    }
  });

  it("omits the field entirely for a type with no roles", () => {
    const resolved = resolveTypeSchema("core.bookmark", coreResolver);
    expect(resolved).toBeDefined();
    // Absent, not empty. A client cannot tell `[]` from "declares none", and
    // an always-empty array in a generated kit is worse than no field at all.
    expect(resolved && "roles" in resolved).toBe(false);
  });

  it("inherits a role from an ancestor, because the rule does", () => {
    const resolver = makeResolver([
      { id: "acme.shelf", version: 1, fields: {}, roles: ["container"] },
      { id: "acme.shelf.rare", version: 1, fields: {}, parent: "acme.shelf" },
    ]);
    expect(resolveTypeSchema("acme.shelf.rare", resolver)?.roles).toEqual([
      "container",
    ]);
  });

  it("agrees with the check the edge constraint actually runs", () => {
    // The property that matters. If these two ever disagree, the API says a
    // type is not a container while the write path accepts it as one.
    for (const id of [
      "core.media.series",
      "core.media.album",
      "core.bookmark",
      "core.note",
      "core.media",
    ]) {
      const projected =
        resolveTypeSchema(id, coreResolver)?.roles?.includes("container") ??
        false;
      expect(projected, id).toBe(typeHasRole(id, "container"));
    }
  });

  it("does not invent a role on the parent of a container", () => {
    // `core.media.series` declares it; `core.media`, its parent, does not.
    // Roles travel down the chain, never up.
    expect(
      resolveTypeSchema("core.media", coreResolver)?.roles,
    ).toBeUndefined();
  });

  it("merges roles declared at more than one level, without duplicating", () => {
    const resolver = makeResolver([
      { id: "acme.base", version: 1, fields: {}, roles: ["container"] },
      {
        id: "acme.mid",
        version: 1,
        fields: {},
        parent: "acme.base",
        roles: ["container"],
      },
    ]);
    expect(resolveTypeSchema("acme.mid", resolver)?.roles).toEqual([
      "container",
    ]);
  });
});
