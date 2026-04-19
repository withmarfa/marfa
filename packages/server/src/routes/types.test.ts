import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { TypeSchema } from "@mymehq/shared";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  ctx.cleanup();
});

const baseType = {
  version: 1,
  fields: {
    name: { type: "string", required: true },
  },
};

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
