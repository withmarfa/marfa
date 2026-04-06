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
  states: ["new", "active", "archived", "trashed"],
  default_state: "new",
  transitions: {
    new: ["active", "archived", "trashed"],
    active: ["archived", "trashed"],
    archived: ["active", "trashed"],
    trashed: ["active"],
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
