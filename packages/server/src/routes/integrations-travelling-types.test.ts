/**
 * Types that travel with a manifest, and the target type that resolves
 * nowhere.
 *
 * Both halves are refusals a person only meets if something checks at
 * registration. Before this, a manifest could name a target type nothing
 * had registered, install cleanly, mint a credential granting write on a
 * type that did not exist, and fail on its first item write with an error
 * naming the type rather than the manifest that declared it.
 *
 * The ownership half matters more. An integration declaring its own schemas
 * is a package registering types, and a package able to declare outside the
 * namespace its identifier names would walk straight around the rule that
 * stops one package registering into another's namespace. The gate reads
 * that first segment, not the `publisher` field, which answers a different
 * question and routinely differs.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request, type TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

function manifest(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "acme/travelling",
    version: "1.0.0",
    publisher: "Acme",
    description: "Ships its own types",
    direction: "read",
    triggers: [{ type: "manual" }],
    target_types: ["core.note"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "state-trashed",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "2.0.0",
    ...overrides,
  };
}

function schema(id: string): Record<string, unknown> {
  return {
    id,
    label: "Travelling type",
    description: "Declared by the manifest that needs it.",
    version: 1,
    fields: { title: { type: "string", description: "A title." } },
  };
}

async function register(body: Record<string, unknown>): Promise<Response> {
  return request(ctx.app, "POST", "/integrations", {
    key: ctx.adminKey,
    body: { manifest: body },
  });
}

describe("a manifest declaring its own type schemas", () => {
  it("registers a type inside its identifier's namespace", async () => {
    const res = await register(
      manifest({
        name: "acme/travelling",
        version: "1.0.0",
        type_schemas: [schema("acme.travelling_note")],
        target_types: ["acme.travelling_note"],
      }),
    );
    expect(res.status).toBe(201);

    // The type is registered and resolvable, not merely recorded on the row.
    const typeRes = await request(
      ctx.app,
      "GET",
      "/types/acme.travelling_note",
      {
        key: ctx.adminKey,
      },
    );
    expect(typeRes.status).toBe(200);
  });

  it("refuses a type outside its identifier's namespace", async () => {
    const res = await register(
      manifest({
        name: "acme/outsider",
        version: "1.0.0",
        type_schemas: [schema("notacme.smuggled")],
        target_types: ["core.note"],
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("acme.*");
    expect(body.error.message).toContain("notacme.smuggled");
  });

  it("refuses a reserved root, which is seeded rather than registered", async () => {
    const res = await register(
      manifest({
        name: "core/impostor",
        version: "1.0.0",
        type_schemas: [schema("core.smuggled")],
        target_types: ["core.note"],
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("platform-shipped");
  });
});

describe("a target type that resolves nowhere", () => {
  it("is refused at registration, naming the entry", async () => {
    const res = await register(
      manifest({
        name: "acme/unresolvable",
        version: "1.0.0",
        target_types: ["acme.type_nobody_registered"],
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; details?: { unresolvable?: string[] } };
    };
    expect(body.error.message).toContain("acme.type_nobody_registered");
  });

  it("counts a type the same manifest declares as resolvable", async () => {
    const res = await register(
      manifest({
        name: "acme/self-satisfying",
        version: "1.0.0",
        type_schemas: [schema("acme.self_declared")],
        target_types: ["acme.self_declared"],
      }),
    );
    expect(res.status).toBe(201);
  });

  it("still accepts a target type the platform ships", async () => {
    const res = await register(
      manifest({ name: "acme/plain", version: "1.0.0" }),
    );
    expect(res.status).toBe(201);
  });
});
