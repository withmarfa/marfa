import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupTestContext,
  createTestContext,
  mintWorkingKey,
  request,
  type TestContext,
} from "../test-utils.js";
import { scopeOfRefusal } from "./step-up.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await cleanupTestContext(ctx);
});

const typeGrant = (name: string) => ({ kind: "type", name, level: "write" });

describe("scopeOfRefusal", () => {
  it("names a scope an app can be granted, and nothing for a misspelled name", () => {
    expect(scopeOfRefusal({ grant: typeGrant("core.note") })).toBe(
      "core.note:write",
    );
    expect(scopeOfRefusal({ grant: typeGrant("core.notez") })).toBeUndefined();
    expect(
      scopeOfRefusal({
        grant: { kind: "edge_type", name: "attached-to", level: "write" },
      }),
    ).toBe("edge.attached-to:write");
    expect(
      scopeOfRefusal({
        grant: { kind: "edge_type", name: "attached-too", level: "write" },
      }),
    ).toBeUndefined();
  });

  it("prefers the required scope a refusal names over its grant", () => {
    expect(
      scopeOfRefusal({
        required_scope: "user.*:write",
        grant: typeGrant("user.recipe"),
      }),
    ).toBe("user.*:write");
  });

  it("names no scope the instance would not grant, however well formed", () => {
    expect(
      scopeOfRefusal({ required_scope: "unheard.*:write" }),
    ).toBeUndefined();
  });
});

describe("a registration door asks for the namespace that covers a new name", () => {
  async function narrowKey(): Promise<string> {
    return mintWorkingKey(ctx, {
      permissions: [],
      type_permissions: { "core.note": "write" },
      edge_permissions: { "attached-to": "write" },
      metadata_permissions: { types: "write", edge_types: "write" },
    });
  }

  it("names the type namespace wildcard when the key cannot register a new type", async () => {
    const res = await request(ctx.app, "POST", "/types", {
      key: await narrowKey(),
      body: {
        id: "user.recipe",
        label: "Recipe",
        version: 1,
        fields: { name: { type: "string", required: true } },
      },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: {
        code: "type_not_permitted",
        details: {
          required_scope: "user.*:write",
          grant: typeGrant("user.recipe"),
        },
      },
    });
  });

  it("names the edge namespace wildcard when the key cannot register a new edge type", async () => {
    const res = await request(ctx.app, "POST", "/edge-types", {
      key: await narrowKey(),
      body: {
        id: "user.cites",
        label: "Cites",
        cardinality: "many-to-many",
        cascade_on_delete: "orphan",
      },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: {
        code: "edge_permission_denied",
        details: { required_scope: "edge.user.*:write" },
      },
    });
  });

  it("names no wildcard for a name the instance would not grant one for", async () => {
    const res = await request(ctx.app, "POST", "/types", {
      key: await narrowKey(),
      body: {
        id: "unheard.recipe",
        label: "Recipe",
        version: 1,
        fields: { name: { type: "string", required: true } },
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { details: Record<string, unknown> };
    };
    expect(body.error.details.required_scope).toBeUndefined();
  });
});
