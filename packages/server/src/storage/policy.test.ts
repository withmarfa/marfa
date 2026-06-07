import { describe, expect, it } from "vitest";
import { TYPE_REGISTRY } from "@withmarfa/shared";
import type { TypeSchema } from "@withmarfa/shared";
import { resolveMergePolicy } from "./policy.js";
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
