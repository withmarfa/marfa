import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { TypeSchema } from "@mymehq/shared";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const baseType = {
  version: 1,
  fields: {
    name: { type: "string", required: true },
  },
};

describe("POST /types — metadata.types:write gating", () => {
  it("blocks a non-admin member key without metadata.types:write", async () => {
    // New default: member keys cannot register custom types unless
    // explicitly granted `metadata.types:write`. The previous
    // requireAdmin gate is replaced by an extension-permission-style
    // check; admin keys still bypass.
    const createKeyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: "no-types-key",
        source: "no-types-key-src",
        role: "member",
        type_permissions: { "*": "write" },
        // metadata_permissions intentionally omitted — defaults to {}.
      },
    });
    const { key: rawKey } = (await createKeyRes.json()) as { key: string };

    const res = await request(ctx.app, "POST", "/types", {
      key: rawKey,
      body: {
        ...baseType,
        id: "demo.unauthorized_register",
        label: "Unauthorized",
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("allows a non-admin member key when metadata.types:write is granted", async () => {
    const createKeyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: "types-writer-key",
        source: "types-writer-key-src",
        role: "member",
        type_permissions: { "*": "write" },
        metadata_permissions: { types: "write" },
      },
    });
    const { key: rawKey } = (await createKeyRes.json()) as { key: string };

    const res = await request(ctx.app, "POST", "/types", {
      key: rawKey,
      body: {
        ...baseType,
        id: "demo.member_registered_type",
        label: "Member Registered",
      },
    });
    expect(res.status).toBe(201);
  });
});

describe("POST /types", () => {
  it("rejects type IDs with forward slashes", async () => {
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: { ...baseType, id: "demo/bad-type", label: "Bad Type" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_type");
  });

  it("auto-generates label from type ID when missing", async () => {
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: { ...baseType, id: "test.auto_label" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { type: TypeSchema };
    expect(body.type.label).toBe("Auto Label");
  });

  it("auto-generates label with hyphens", async () => {
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: { ...baseType, id: "test.my-custom-thing" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { type: TypeSchema };
    expect(body.type.label).toBe("My Custom Thing");
  });

  it("preserves explicit label", async () => {
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: { ...baseType, id: "test.explicit_label", label: "My Label" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { type: TypeSchema };
    expect(body.type.label).toBe("My Label");
  });

  it("rejects single-segment type IDs", async () => {
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: { ...baseType, id: "badtype", label: "Bad" },
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /types", () => {
  it("lists all types including core", async () => {
    const res = await request(ctx.app, "GET", "/types", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const types = (await res.json()) as TypeSchema[];
    expect(types.length).toBeGreaterThan(0);
    const noteType = types.find((t) => t.id === "core.note");
    expect(noteType).toBeTruthy();
  });
});

describe("inheritance rule enforcement", () => {
  it("rejects a child type that redefines an ancestor field with INHERITANCE_VIOLATION", async () => {
    // core.bookmark declares `body` (the user's annotation on the bookmark).
    // A child that re-declares `body` violates the inheritance rule.
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: {
        id: "test.bookmark_redef",
        label: "Bookmark Redef",
        version: 1,
        parent: "core.bookmark",
        fields: {
          body: { type: "string" },
        },
      },
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as {
      error: {
        code: string;
        message: string;
        details?: { errors?: { field: string; message: string }[] };
      };
    };
    expect(payload.error.code).toBe("inheritance_violation");
    const errors = payload.error.details?.errors ?? [];
    const collision = errors.find((e) => e.field === "fields.body");
    expect(collision).toBeTruthy();
    expect(collision?.message).toContain("core.bookmark");
  });

  it("allows a child type that adds a new field on top of the parent", async () => {
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: {
        id: "test.bookmark_extra",
        label: "Bookmark Extra",
        version: 1,
        parent: "core.bookmark",
        fields: {
          location: { type: "string" },
        },
      },
    });
    expect(res.status).toBe(201);
  });
});

describe("merge_policy on type schemas", () => {
  it("GET /types/core.note returns the resolved merge_policy", async () => {
    const res = await request(ctx.app, "GET", "/types/core.note", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const schema = (await res.json()) as TypeSchema;
    expect(schema.merge_policy).toBeDefined();
    expect(schema.merge_policy?.fields?.body).toBe("keep_both_copies");
    expect(schema.merge_policy?.fields?.notes).toBe("keep_both_copies");
    expect(schema.merge_policy?.default).toBe("last_writer_wins");
  });

  it("POST /types accepts a custom type with a valid merge_policy", async () => {
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: {
        id: "test.custom_with_policy",
        label: "Custom",
        version: 1,
        fields: {
          body: { type: "string" },
          title: { type: "string" },
        },
        merge_policy: {
          fields: { body: "keep_both_copies" },
          default: "last_writer_wins",
        },
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { type: TypeSchema };
    expect(body.type.merge_policy?.fields?.body).toBe("keep_both_copies");
    expect(body.type.merge_policy?.default).toBe("last_writer_wins");
  });

  it("POST /types rejects a merge_policy with an unknown strategy", async () => {
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: {
        id: "test.bad_strategy",
        label: "Bad",
        version: 1,
        fields: { body: { type: "string" } },
        merge_policy: { fields: { body: "totally_made_up" } },
      },
    });
    expect(res.status).toBe(400);
  });

  it("POST /types rejects a merge_policy referencing an unknown field", async () => {
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: {
        id: "test.unknown_field_policy",
        label: "Bad",
        version: 1,
        fields: { body: { type: "string" } },
        merge_policy: { fields: { ghost: "keep_both_copies" } },
      },
    });
    expect(res.status).toBe(400);
  });

  it("POST /types accepts a child of core.note overriding an inherited field's strategy", async () => {
    // `body` lives on core.note. A child that doesn't redeclare the field
    // but overrides its merge strategy is legitimate.
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: {
        id: "test.note_body_override",
        label: "Note Override",
        version: 1,
        parent: "core.note",
        fields: { extra: { type: "string" } },
        merge_policy: { fields: { body: "last_writer_wins" } },
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { type: TypeSchema };
    expect(body.type.merge_policy?.fields?.body).toBe("last_writer_wins");
  });

  it("POST /types rejects a child of core.note whose merge_policy references a nonexistent field", async () => {
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: {
        id: "test.note_bad_override",
        label: "Bad Override",
        version: 1,
        parent: "core.note",
        fields: { extra: { type: "string" } },
        merge_policy: { fields: { nonexistent: "keep_both_copies" } },
      },
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as {
      error: {
        code: string;
        details?: { errors?: { field: string }[] };
      };
    };
    expect(payload.error.code).toBe("invalid_schema");
    const errors = payload.error.details?.errors ?? [];
    expect(
      errors.some((e) => e.field.startsWith("merge_policy.fields.nonexistent")),
    ).toBe(true);
  });
});

describe("GET /types/:id — inheritance resolution", () => {
  it("returns merged fields for a child of core.note", async () => {
    // Register a custom child that adds one field on top of core.note.
    // GET should return the union of core.note's fields and the child's.
    const postRes = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: {
        id: "test.note_with_tag",
        label: "Note With Tag",
        version: 1,
        parent: "core.note",
        fields: { tag: { type: "string" } },
      },
    });
    expect(postRes.status).toBe(201);

    const getRes = await request(ctx.app, "GET", "/types/test.note_with_tag", {
      key: ctx.adminKey,
    });
    expect(getRes.status).toBe(200);
    const schema = (await getRes.json()) as TypeSchema;

    // Child's own field is present.
    expect(schema.fields.tag).toBeDefined();
    // Inherited fields from core.note are present.
    expect(schema.fields.body).toBeDefined();
    expect(schema.fields.title).toBeDefined();
    expect(schema.fields.notes).toBeDefined();
    expect(schema.fields.language).toBeDefined();
  });

  it("inherits display_hints from the nearest ancestor", async () => {
    const postRes = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: {
        id: "test.note_inherit_hints",
        label: "Note Inheriting Hints",
        version: 1,
        parent: "core.note",
        fields: { extra: { type: "string" } },
      },
    });
    expect(postRes.status).toBe(201);

    const getRes = await request(
      ctx.app,
      "GET",
      "/types/test.note_inherit_hints",
      { key: ctx.adminKey },
    );
    expect(getRes.status).toBe(200);
    const schema = (await getRes.json()) as TypeSchema;

    // core.note declares title_field: "title", body_field: "body".
    expect(schema.display_hints?.title_field).toBe("title");
    expect(schema.display_hints?.body_field).toBe("body");
  });

  it("child display_hints override parent hints (nearest-ancestor-wins)", async () => {
    const postRes = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: {
        id: "test.note_own_hints",
        label: "Note With Own Hints",
        version: 1,
        parent: "core.note",
        fields: { extra: { type: "string" } },
        // Override: point title at the inherited notes field, drop body_field.
        display_hints: { title_field: "notes" },
      },
    });
    expect(postRes.status).toBe(201);

    const getRes = await request(ctx.app, "GET", "/types/test.note_own_hints", {
      key: ctx.adminKey,
    });
    expect(getRes.status).toBe(200);
    const schema = (await getRes.json()) as TypeSchema;
    expect(schema.display_hints?.title_field).toBe("notes");
    // Whole-block replacement: parent's body_field is not inherited when
    // the child declares its own display_hints block.
    expect(schema.display_hints?.body_field).toBeUndefined();
  });

  it("inherits merge_policy from parent when child omits it", async () => {
    const postRes = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: {
        id: "test.note_inherit_policy",
        label: "Note Inheriting Policy",
        version: 1,
        parent: "core.note",
        fields: { extra: { type: "string" } },
      },
    });
    expect(postRes.status).toBe(201);

    const getRes = await request(
      ctx.app,
      "GET",
      "/types/test.note_inherit_policy",
      { key: ctx.adminKey },
    );
    expect(getRes.status).toBe(200);
    const schema = (await getRes.json()) as TypeSchema;
    expect(schema.merge_policy?.fields?.body).toBe("keep_both_copies");
    expect(schema.merge_policy?.fields?.notes).toBe("keep_both_copies");
    expect(schema.merge_policy?.default).toBe("last_writer_wins");
  });

  it("merges version_policy field-by-field across the chain", async () => {
    // Parent sets recent_days + max_versions.
    const parentRes = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: {
        id: "test.vp_parent",
        label: "VP Parent",
        version: 1,
        fields: { body: { type: "string" } },
        version_policy: { recent_days: 7, max_versions: 100 },
      },
    });
    expect(parentRes.status).toBe(201);

    // Child overrides only max_versions.
    const childRes = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: {
        id: "test.vp_child",
        label: "VP Child",
        version: 1,
        parent: "test.vp_parent",
        fields: { extra: { type: "string" } },
        version_policy: { max_versions: 250 },
      },
    });
    expect(childRes.status).toBe(201);

    const getRes = await request(ctx.app, "GET", "/types/test.vp_child", {
      key: ctx.adminKey,
    });
    expect(getRes.status).toBe(200);
    const schema = (await getRes.json()) as TypeSchema;
    // Parent's recent_days is preserved; child's max_versions wins.
    expect(schema.version_policy?.recent_days).toBe(7);
    expect(schema.version_policy?.max_versions).toBe(250);
  });

  it("root type schema is unchanged by resolution (no-op on core.note)", async () => {
    const res = await request(ctx.app, "GET", "/types/core.note", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const schema = (await res.json()) as TypeSchema;
    expect(schema.id).toBe("core.note");
    expect(schema.parent).toBeUndefined();
    // Own fields present, own display_hints preserved, own merge_policy preserved.
    expect(schema.fields.body).toBeDefined();
    expect(schema.display_hints?.title_field).toBe("title");
    expect(schema.merge_policy?.fields?.body).toBe("keep_both_copies");
  });
});
