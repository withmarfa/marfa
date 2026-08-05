import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { TypeSchema } from "@withmarfa/shared";

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

// The shipped set spans three families and all three are equally immutable:
// they come from codegen, so a space editing one would change what the
// identifier means for every other space and for items already written
// against it. Naming a representative of each family here is what stops the
// guard being narrowed back to the core family without a test noticing.
describe("PUT / DELETE /types/:id — platform-shipped types are immutable", () => {
  const SHIPPED = [
    ["core", "core.note"],
    ["integration", "todoist.task"],
    ["integration", "google.calendar.event"],
    ["system", "system.connection"],
  ] as const;

  for (const [family, id] of SHIPPED) {
    it(`refuses to update the ${family} type ${id}`, async () => {
      const res = await request(ctx.app, "PUT", `/types/${id}`, {
        key: ctx.adminKey,
        body: { ...baseType, version: 2 },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("core_type_immutable");
    });

    it(`refuses to delete the ${family} type ${id}`, async () => {
      const res = await request(ctx.app, "DELETE", `/types/${id}`, {
        key: ctx.adminKey,
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("core_type_immutable");
    });
  }
});

describe("inheritance rule enforcement", () => {
  it("rejects a child type that reshapes an ancestor field with INHERITANCE_VIOLATION", async () => {
    // core.bookmark declares `body` as a string. A child that redeclares it
    // as something else leaves two incompatible readings of one property
    // name on items a bookmark-aware reader expects to understand.
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: {
        id: "test.bookmark_redef",
        label: "Bookmark Redef",
        version: 1,
        parent: "core.bookmark",
        fields: {
          body: { type: "integer" },
        },
      },
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as {
      error: {
        code: string;
        message: string;
        details?: {
          errors?: {
            field: string;
            message: string;
            expected?: string;
            actual?: string;
            hint?: string;
          }[];
        };
      };
    };
    expect(payload.error.code).toBe("inheritance_violation");
    const errors = payload.error.details?.errors ?? [];
    const collision = errors.find((e) => e.field === "fields.body.type");
    expect(collision).toBeTruthy();
    expect(collision?.message).toContain("core.bookmark");
    // The API surfaces the structured halves too, so a client can render the
    // failure without parsing prose.
    expect(collision?.expected).toBeTruthy();
    expect(collision?.actual).toBeTruthy();
    expect(collision?.hint).toBeTruthy();
  });

  it("allows a child type that sharpens an inherited field's description", async () => {
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: {
        id: "test.bookmark_refine",
        label: "Bookmark Refine",
        version: 1,
        parent: "core.bookmark",
        fields: {
          body: { type: "string", description: "Why this link was saved" },
        },
      },
    });
    expect(res.status).toBe(201);
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

describe("first-class field shadow rejection", () => {
  // Authoritative list from RESERVED_ITEM_FIELDS in type-registry.ts.
  // Skip identifiers that fail upstream gates (e.g. `properties` is rejected
  // by the route's body-shape check before validateTypeSchema runs).
  const SHADOWED_FIELD_NAMES = [
    "id",
    "type",
    "state",
    "tier",
    "space_id",
    "created_at",
    "updated_at",
    "timestamp",
    "source",
    "source_id",
    "version",
    "schema_version",
    "device",
    "capture_latitude",
    "capture_longitude",
  ] as const;

  for (const name of SHADOWED_FIELD_NAMES) {
    it(`rejects a schema declaring fields.${name} with PROPERTY_SHADOWS_FIELD`, async () => {
      const res = await request(ctx.app, "POST", "/types", {
        key: ctx.adminKey,
        body: {
          id: `test.shadow_${name}`,
          label: `Shadow ${name}`,
          version: 1,
          fields: {
            [name]: { type: "string" },
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
      expect(payload.error.code).toBe("property_shadows_field");
      const errors = payload.error.details?.errors ?? [];
      const collision = errors.find((e) => e.field === `fields.${name}`);
      expect(collision).toBeTruthy();
      expect(collision?.message).toContain("first-class Item field");
    });
  }

  it("accepts a schema whose fields don't shadow any first-class Item field", async () => {
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: {
        id: "test.shadow_clean",
        label: "Shadow Clean",
        version: 1,
        fields: {
          input_device: { type: "string" },
          duration_seconds: { type: "number" },
        },
      },
    });
    expect(res.status).toBe(201);
  });

  it("reports every shadowing field at once, not just the first", async () => {
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: {
        id: "test.shadow_many",
        label: "Shadow Many",
        version: 1,
        fields: {
          device: { type: "string" },
          source_id: { type: "string" },
          timestamp: { type: "datetime" },
        },
      },
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as {
      error: {
        code: string;
        details?: { errors?: { field: string }[] };
      };
    };
    expect(payload.error.code).toBe("property_shadows_field");
    const fields = (payload.error.details?.errors ?? []).map((e) => e.field);
    expect(fields).toContain("fields.device");
    expect(fields).toContain("fields.source_id");
    expect(fields).toContain("fields.timestamp");
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

describe("compatible_with at the gate and on the wire", () => {
  it("rejects a false claim with 422 compatible_with_violation", async () => {
    // core.note requires body; a claim that omits it does not hold, and the
    // refusal names the mechanism so a client can act on it.
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: {
        id: "demo.hollow_note",
        version: 1,
        compatible_with: ["core.note"],
        fields: { week_of: { type: "date" } },
      },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("compatible_with_violation");
  });

  it("registers a holding claim and serves it on every read surface", async () => {
    const created = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: {
        id: "demo.meal_plan",
        version: 1,
        compatible_with: ["core.note"],
        fields: {
          body: { type: "string", required: true },
          week_of: { type: "date" },
        },
      },
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { type: TypeSchema };
    expect(createdBody.type.compatible_with).toEqual(["core.note"]);

    const single = await request(ctx.app, "GET", "/types/demo.meal_plan", {
      key: ctx.adminKey,
    });
    const singleBody = (await single.json()) as TypeSchema;
    expect(singleBody.compatible_with).toEqual(["core.note"]);

    const list = await request(ctx.app, "GET", "/types", {
      key: ctx.adminKey,
    });
    const listBody = (await list.json()) as TypeSchema[];
    const fromList = listBody.find((t) => t.id === "demo.meal_plan");
    expect(fromList?.compatible_with).toEqual(["core.note"]);
  });

  it("keeps compatible items out of target-type queries", async () => {
    // Compatibility is a read-as promise for consumers, not query membership:
    // a filter for the target returns only the target and its descendants.
    // Exercised through a member credential so the resolution path a
    // non-admin caller takes is the one under test.
    const keyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: "compat-member",
        source: "compat-member-src",
        role: "member",
        type_permissions: { "*": "write" },
      },
    });
    const { key: memberKey } = (await keyRes.json()) as { key: string };

    const item = await request(ctx.app, "POST", "/items", {
      key: memberKey,
      body: {
        type: "demo.meal_plan",
        properties: { body: "greens", week_of: "2026-08-10" },
      },
    });
    expect(item.status).toBe(201);
    const itemBody = (await item.json()) as { item: { id: string } };

    const asTarget = await request(ctx.app, "GET", "/items?type=core.note", {
      key: memberKey,
    });
    const targetList = (await asTarget.json()) as { data: { id: string }[] };
    expect(targetList.data.some((i) => i.id === itemBody.item.id)).toBe(false);

    const asSelf = await request(ctx.app, "GET", "/items?type=demo.meal_plan", {
      key: memberKey,
    });
    const selfList = (await asSelf.json()) as { data: { id: string }[] };
    expect(selfList.data.some((i) => i.id === itemBody.item.id)).toBe(true);
  });
});
