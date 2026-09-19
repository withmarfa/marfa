import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { TypeSchema } from "@withmarfa/shared";
import {
  MAX_RESOLUTION_DEPTH,
  registerTypeSchema,
  unregisterTypeSchema,
} from "@withmarfa/shared";

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
  it("blocks a key without metadata.types:write", async () => {
    // Registering a custom type is gated on the metadata map alone, and no
    // credential is exempt from it. `space_permissions` is named because
    // omitting it mints a copy of the caller's set, which here is all eleven.
    const createKeyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.spaceKey,
      body: {
        label: "no-types-key",
        source: "no-types-key-src",
        space_permissions: [],
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

  it("allows a key when metadata.types:write is granted", async () => {
    const createKeyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.spaceKey,
      body: {
        label: "types-writer-key",
        source: "types-writer-key-src",
        space_permissions: [],
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
      key: ctx.spaceKey,
      body: { ...baseType, id: "demo/bad-type", label: "Bad Type" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_type");
  });

  it("auto-generates label from type ID when missing", async () => {
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.spaceKey,
      body: { ...baseType, id: "test.auto_label" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { type: TypeSchema };
    expect(body.type.label).toBe("Auto Label");
  });

  it("auto-generates label with hyphens", async () => {
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.spaceKey,
      body: { ...baseType, id: "test.my-custom-thing" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { type: TypeSchema };
    expect(body.type.label).toBe("My Custom Thing");
  });

  it("preserves explicit label", async () => {
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.spaceKey,
      body: { ...baseType, id: "test.explicit_label", label: "My Label" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { type: TypeSchema };
    expect(body.type.label).toBe("My Label");
  });

  it("rejects single-segment type IDs", async () => {
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.spaceKey,
      body: { ...baseType, id: "badtype", label: "Bad" },
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /types", () => {
  it("lists all types including core", async () => {
    const res = await request(ctx.app, "GET", "/types", {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(200);
    const types = (await res.json()) as TypeSchema[];
    expect(types.length).toBeGreaterThan(0);
    const noteType = types.find((t) => t.id === "core.note");
    expect(noteType).toBeTruthy();
  });

  // On the wire, not in a resolver. Nothing asserted the field survives the
  // response at all, and it is the field a client reads this endpoint for:
  // "which of these can hold a collection" is a question about the list.
  it("carries roles for the types that have them, and omits them otherwise", async () => {
    const res = await request(ctx.app, "GET", "/types", { key: ctx.spaceKey });
    const types = (await res.json()) as TypeSchema[];

    const containers = types
      .filter((t) => t.roles?.includes("container"))
      .map((t) => t.id)
      .sort();
    expect(containers).toEqual([
      "core.media.album",
      "core.media.series",
      "marfa.podcast.show",
    ]);

    const note = types.find((t) => t.id === "core.note");
    expect(note && "roles" in note).toBe(false);
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
        key: ctx.spaceKey,
        body: { ...baseType, version: 2 },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("core_type_immutable");
    });

    it(`refuses to delete the ${family} type ${id}`, async () => {
      const res = await request(ctx.app, "DELETE", `/types/${id}`, {
        key: ctx.spaceKey,
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("core_type_immutable");
    });
  }
});

describe("inheritance rule enforcement", () => {
  it("names the parent it could not resolve", async () => {
    // The walk is shared with the archive restore, and each door supplies its
    // own phrasing. Nothing else asserts what this door actually says, so a
    // transposed interpolation would read as the other door's message.
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.spaceKey,
      body: {
        id: "test.orphan_child",
        label: "Orphan Child",
        version: 1,
        parent: "test.no_such_parent",
        fields: {},
      },
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: { message: string } };
    expect(payload.error.message).toBe(
      'Parent type "test.no_such_parent" not found',
    );
  });

  it("rejects a child type that reshapes an ancestor field with INHERITANCE_VIOLATION", async () => {
    // core.bookmark declares `body` as a string. A child that redeclares it
    // as something else leaves two incompatible readings of one property
    // name on items a bookmark-aware reader expects to understand.
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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
    "created_at",
    "updated_at",
    "occurred_at",
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
        key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
      body: {
        id: "test.shadow_many",
        label: "Shadow Many",
        version: 1,
        fields: {
          device: { type: "string" },
          source_id: { type: "string" },
          occurred_at: { type: "datetime" },
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
    expect(fields).toContain("fields.occurred_at");
  });
});

describe("merge_policy on type schemas", () => {
  it("GET /types/core.note returns the resolved merge_policy", async () => {
    const res = await request(ctx.app, "GET", "/types/core.note", {
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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
      { key: ctx.spaceKey },
    );
    expect(getRes.status).toBe(200);
    const schema = (await getRes.json()) as TypeSchema;

    // core.note declares title_field: "title", body_field: "body".
    expect(schema.display_hints?.title_field).toBe("title");
    expect(schema.display_hints?.body_field).toBe("body");
  });

  it("child display_hints override parent hints (nearest-ancestor-wins)", async () => {
    const postRes = await request(ctx.app, "POST", "/types", {
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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
      { key: ctx.spaceKey },
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
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
    });
    expect(getRes.status).toBe(200);
    const schema = (await getRes.json()) as TypeSchema;
    // Parent's recent_days is preserved; child's max_versions wins.
    expect(schema.version_policy?.recent_days).toBe(7);
    expect(schema.version_policy?.max_versions).toBe(250);
  });

  it("root type schema is unchanged by resolution (no-op on core.note)", async () => {
    const res = await request(ctx.app, "GET", "/types/core.note", {
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
    });
    const singleBody = (await single.json()) as TypeSchema;
    expect(singleBody.compatible_with).toEqual(["core.note"]);

    const list = await request(ctx.app, "GET", "/types", {
      key: ctx.spaceKey,
    });
    const listBody = (await list.json()) as TypeSchema[];
    const fromList = listBody.find((t) => t.id === "demo.meal_plan");
    expect(fromList?.compatible_with).toEqual(["core.note"]);
  });

  it("keeps compatible items out of target-type queries", async () => {
    // Compatibility is a read-as promise for consumers, not query membership:
    // a filter for the target returns only the target and its descendants.
    // Exercised through a credential narrowed by its type map, so the
    // resolution path a filtered caller takes is the one under test.
    const keyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.spaceKey,
      body: {
        label: "compat-member",
        source: "compat-member-src",
        space_permissions: [],
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

describe("POST /types — reserved namespaces are not authored at runtime", () => {
  // The platform-shipped set is compiled in from JSON in the type package.
  // Nothing legitimate mints one over HTTP: the only two callers of
  // `storage.types.create` are this route and the archive-restore replay,
  // and the replay refuses reserved namespaces before it reaches it.
  for (const tier of ["core", "system", "marfa"] as const) {
    it(`refuses a ${tier}.* registration from the operator key`, async () => {
      const res = await request(ctx.app, "POST", "/types", {
        key: ctx.spaceKey, // the bootstrap credential: is_operator, no space
        body: { id: `${tier}.runtime-authored-probe`, ...baseType },
      });
      // Previously 201: the gate admitted the operator key, which put
      // registration and archive restore in disagreement. An archive
      // carrying such a type is refused whatever credential restores it,
      // so the row could only ever have made that space's exports
      // un-restorable.
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("platform-shipped");
    });
  }

  it("still admits an ordinary namespace from the same credential", async () => {
    const res = await request(ctx.app, "POST", "/types", {
      key: ctx.spaceKey,
      body: { id: "user.runtime-authored-probe", ...baseType },
    });
    expect(res.status).toBe(201);
  });
});

/**
 * Deleting a type used to ask only whether items of it existed. A type that
 * another type inherited from went quietly: the parent left the registry, the
 * child kept a `parent` pointing at nothing, and every later read of the child
 * returned fewer fields than the day before. Nothing threw, because the
 * upward walk stops at an ancestor that does not resolve rather than
 * erroring, so the only visible event was a successful delete.
 */
describe("DELETE /types/:id — a type another type inherits from", () => {
  // Each case builds its own pair under its own ids. Sharing one across the
  // block would make every case after the first depend on the refusal in the
  // one before it, so running any of them alone, or reordering them, would
  // fail on the fixture rather than on the thing it pins.
  async function pair(
    suffix: string,
  ): Promise<{ parent: string; child: string }> {
    const parent = `acme.del_parent_${suffix}`;
    const child = `acme.del_child_${suffix}`;
    await request(ctx.app, "POST", "/types", {
      key: ctx.spaceKey,
      body: { id: parent, ...baseType },
    });
    await request(ctx.app, "POST", "/types", {
      key: ctx.spaceKey,
      body: {
        id: child,
        version: 1,
        parent,
        fields: { extra: { type: "string" } },
      },
    });
    return { parent, child };
  }

  async function resolvedFieldNames(id: string): Promise<string[]> {
    const res = await request(ctx.app, "GET", `/types/${id}`, {
      key: ctx.spaceKey,
    });
    const body = (await res.json()) as { fields?: Record<string, unknown> };
    return Object.keys(body.fields ?? {}).sort();
  }

  it("refuses, names the subtype, and leaves the subtype resolving as before", async () => {
    const { parent, child } = await pair("plain");
    const before = await resolvedFieldNames(child);
    expect(before).toContain("name");

    const res = await request(ctx.app, "DELETE", `/types/${parent}`, {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
        details?: { subtype_ids?: string[] };
      };
    };
    expect(body.error.code).toBe("type_has_subtypes");
    expect(body.error.details?.subtype_ids).toEqual([child]);

    // The message has to carry the way out, not only the obstruction.
    expect(body.error.message).toContain(child);
    expect(body.error.message).toContain("PUT /types/{id}");

    // The whole point of the refusal: nothing about the child moved.
    expect(await resolvedFieldNames(child)).toEqual(before);
  });

  it("is not what force covers, and says so", async () => {
    const { parent } = await pair("forced");
    const res = await request(
      ctx.app,
      "DELETE",
      `/types/${parent}?force=true`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("type_has_subtypes");
  });

  // Ordering matters: the items refusal can be forced past and this one
  // cannot, so reporting the forcible one first costs a round trip.
  it("is reported ahead of the items refusal when both apply", async () => {
    const { parent } = await pair("both");
    await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: parent, properties: { name: "an item" } },
    });
    const res = await request(ctx.app, "DELETE", `/types/${parent}`, {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("type_has_subtypes");
  });

  // The remedy the message actually advertises: a different parent, not none.
  it("goes through once the subtype is given a different parent", async () => {
    const { parent, child } = await pair("repointed");
    await request(ctx.app, "POST", "/types", {
      key: ctx.spaceKey,
      body: { id: "acme.del_new_parent", ...baseType },
    });

    const repoint = await request(ctx.app, "PUT", `/types/${child}`, {
      key: ctx.spaceKey,
      body: {
        version: 2,
        parent: "acme.del_new_parent",
        fields: { extra: { type: "string" } },
      },
    });
    expect(repoint.status).toBe(200);

    const res = await request(ctx.app, "DELETE", `/types/${parent}`, {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(200);

    const gone = await request(ctx.app, "GET", `/types/${parent}`, {
      key: ctx.spaceKey,
    });
    expect(gone.status).toBe(404);

    // The child followed its new parent rather than being left behind.
    const moved = await request(ctx.app, "GET", `/types/${child}`, {
      key: ctx.spaceKey,
    });
    const body = (await moved.json()) as { parent?: string };
    expect(body.parent).toBe("acme.del_new_parent");
  });

  // A grandchild's own chain survives its grandparent, so it is the child
  // that blocks the delete and only the child that gets named.
  it("names the immediate subtype and not the one below it", async () => {
    const { parent, child } = await pair("deep");
    await request(ctx.app, "POST", "/types", {
      key: ctx.spaceKey,
      body: {
        id: "acme.del_grandchild",
        version: 1,
        parent: child,
        fields: {},
      },
    });

    const res = await request(ctx.app, "DELETE", `/types/${parent}`, {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { details?: { subtype_ids?: string[] } };
    };
    expect(body.error.details?.subtype_ids).toEqual([child]);
  });

  it("deletes a leaf type with no subtypes", async () => {
    await request(ctx.app, "POST", "/types", {
      key: ctx.spaceKey,
      body: { id: "acme.del_leaf", ...baseType },
    });
    const res = await request(ctx.app, "DELETE", "/types/acme.del_leaf", {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(200);
  });
});

/**
 * A compiled Zod schema is built from a type's RESOLVED fields, so a change
 * to a parent invalidates every descendant's compiled schema as well as its
 * own. Nothing evicted those, and a stale one goes on validating writes
 * against a shape the type no longer has. Reached here through the write
 * path, which is what compiles and caches them.
 */
describe("a parent's change reaches its descendants' validation", () => {
  it("stops accepting a write the parent no longer allows", async () => {
    await request(ctx.app, "POST", "/types", {
      key: ctx.spaceKey,
      body: { id: "acme.cache_parent", version: 1, fields: {} },
    });
    await request(ctx.app, "POST", "/types", {
      key: ctx.spaceKey,
      body: {
        id: "acme.cache_child",
        version: 1,
        parent: "acme.cache_parent",
        fields: {},
      },
    });

    // Compiles and caches the child's schema, inherited fields and all.
    const first = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "acme.cache_child", properties: {} },
    });
    expect(first.status).toBe(201);

    // The parent gains a required field. The child inherits it, so a write
    // omitting it must now be refused rather than served from the schema
    // compiled a moment ago.
    const update = await request(ctx.app, "PUT", "/types/acme.cache_parent", {
      key: ctx.spaceKey,
      body: {
        version: 2,
        fields: { mandatory: { type: "string", required: true } },
      },
    });
    expect(update.status).toBe(200);

    const second = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "acme.cache_child", properties: {} },
    });
    expect(second.status).toBe(400);
  });
});

/**
 * The registration cap bounds the chain ABOVE the type being written, which
 * is the right thing for it to bound and is not a bound on the chain the
 * write produces. Moving a type that has subtypes under a new parent
 * lengthens every one of their chains without any of them being submitted,
 * so a sequence of individually legal updates could take a chain past the cap
 * that would have refused building it directly.
 */
describe("PUT /types/:id — re-parenting counts what hangs below", () => {
  async function makeType(id: string, parent?: string): Promise<Response> {
    return request(ctx.app, "POST", "/types", {
      key: ctx.spaceKey,
      body: { id, version: 1, fields: {}, ...(parent ? { parent } : {}) },
    });
  }

  // `rp.a` carries two levels below it, so it may sit under eight ancestors
  // and no more: eight above plus the two below is the cap exactly. The
  // boundary is asserted on both sides, because an off-by-one here either
  // refuses a legal move or admits the thing being closed.
  const chainLength = 10;

  beforeAll(async () => {
    await makeType("rp.c0");
    for (let n = 1; n < chainLength; n += 1) {
      await makeType(`rp.c${String(n)}`, `rp.c${String(n - 1)}`);
    }
    await makeType("rp.a");
    await makeType("rp.b", "rp.a");
    await makeType("rp.c", "rp.b");
  });

  async function reparent(parent: string, version: number): Promise<Response> {
    return request(ctx.app, "PUT", "/types/rp.a", {
      key: ctx.spaceKey,
      body: { version, parent, fields: {} },
    });
  }

  it("accepts a move whose resulting chain sits on the cap", async () => {
    expect((await reparent("rp.c7", 2)).status).toBe(200);
  });

  it("refuses the move one level deeper, and says which half ran out", async () => {
    const res = await reparent("rp.c8", 3);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    // The submitted chain is well inside the cap. A message naming only the
    // depth would state a fact the caller can see is not the whole reason.
    expect(body.error.message).toContain("subtypes");
  });

  it("still accepts the same move for a type carrying nothing", async () => {
    await makeType("rp.leaf");
    const res = await request(ctx.app, "PUT", "/types/rp.leaf", {
      key: ctx.spaceKey,
      body: { version: 2, parent: "rp.c8", fields: {} },
    });
    expect(res.status).toBe(200);
  });
});

/**
 * A type whose stored chain is past the backstop answered 500 to everything,
 * including the read a caller needs to correct it. The state is built here
 * through the registry directly, because every write path now refuses to
 * produce it.
 */
describe("a type whose stored chain cannot be resolved", () => {
  const link = (n: number): string => `broken.n${String(n)}`;
  const LENGTH = MAX_RESOLUTION_DEPTH + 3;

  beforeAll(async () => {
    await request(ctx.app, "POST", "/types", {
      key: ctx.spaceKey,
      body: { id: "broken.victim", version: 1, fields: {} },
    });
    // Into the caller's own space, because that is the overlay its lookups
    // read. Registered space-less, the broken chain sits in a bucket the
    // credential never resolves and the route answers about the sound row it
    // registered a moment ago.
    registerTypeSchema({ id: link(0), version: 1, fields: {} });
    for (let n = 1; n < LENGTH; n += 1) {
      registerTypeSchema({
        id: link(n),
        version: 1,
        parent: link(n - 1),
        fields: {},
      });
    }
    registerTypeSchema({
      id: "broken.victim",
      version: 1,
      parent: link(LENGTH - 1),
      fields: {},
    });
  });

  afterAll(() => {
    for (let n = LENGTH - 1; n >= 0; n -= 1) unregisterTypeSchema(link(n));
  });

  it("answers a coded refusal rather than a server fault", async () => {
    const res = await request(ctx.app, "GET", "/types/broken.victim", {
      key: ctx.spaceKey,
    });
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("type_chain_unresolvable");
  });

  it("can still be corrected, which is the way back", async () => {
    const fixed = await request(ctx.app, "PUT", "/types/broken.victim", {
      key: ctx.spaceKey,
      body: { version: 2, fields: {} },
    });
    expect(fixed.status).toBe(200);

    const res = await request(ctx.app, "GET", "/types/broken.victim", {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(200);
  });
});
