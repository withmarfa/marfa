import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createTestContext,
  inlineOpenApiRefs,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { KeyResponseSchema } from "./_schemas.js";
let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx.cleanup();
});
const storedPermissions = {
  name: "write",
  email: "write",
  old_field: "read",
} as const;
async function storedCreator() {
  const raw = "marfa_k1_stored_profile_creator";
  const row = await ctx.storage.keys.create(
    {
      label: "Stored creator",
      source: "stored-profile-creator",
      permissions: ["keys.mint", "keys.manage"],
      default_tier: "library",
      type_permissions: {},
      extension_permissions: {},
      edge_permissions: {},
      metadata_permissions: {},
      profile_permissions: storedPermissions,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
  );
  return { raw, row };
}
it("honestly describes stored profile grants on current, listing and label update", async () => {
  const { raw, row } = await storedCreator();
  const current = await request(ctx.app, "GET", "/keys/current", { key: raw });
  expect(current.status).toBe(200);
  const body = (await current.json()) as Record<string, unknown>;
  const document = (await (await ctx.app.request("/openapi.json")).json()) as {
    components: {
      schemas: Record<
        string,
        {
          properties?: Record<string, { $ref?: string }>;
          additionalProperties?: { enum?: string[] };
        }
      >;
    };
  };
  expect(
    JSON.stringify(
      document.components.schemas.ApiKey!.properties!.profile_permissions,
    ),
  ).toContain("#/components/schemas/StoredProfilePermissions");
  expect(
    inlineOpenApiRefs(
      document.components.schemas.StoredProfilePermissions!
        .additionalProperties,
      document,
    ),
  ).toMatchObject({ enum: ["read", "write"] });

  expect(body.profile_permissions).toEqual(storedPermissions);
  expect(
    KeyResponseSchema.safeParse({ ...body, key: "plaintext" }).success,
  ).toBe(true);
  const list = await ctx.ownerRequest("/keys");
  const data = (await list.json()) as { data: Record<string, unknown>[] };
  const listed = data.data.find((key) => key.id === row.id)!;
  expect(
    KeyResponseSchema.safeParse({ ...listed, key: "plaintext" }).success,
  ).toBe(true);
  const updated = await ctx.ownerRequest(`/keys/${row.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "Renamed" }),
  });
  expect(updated.status).toBe(200);
  const renamed = (await updated.json()) as Record<string, unknown>;
  expect(renamed.profile_permissions).toEqual(storedPermissions);
  expect(
    KeyResponseSchema.safeParse({ ...renamed, key: "plaintext" }).success,
  ).toBe(true);
});
it("mints only effective delegable profile authority from an old stored creator", async () => {
  const { raw } = await storedCreator();
  const before = (await ctx.storage.keys.list()).length;
  const response = await request(ctx.app, "POST", "/keys", {
    key: raw,
    body: { label: "Inherited", source: "inherited-profile" },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body.profile_permissions).toEqual({ name: "write", email: "read" });
  expect(KeyResponseSchema.safeParse(body).success).toBe(true);
  expect((await ctx.storage.keys.list()).length).toBe(before + 1);
  for (const profile_permissions of [
    { email: "write" },
    { old_field: "read" },
  ]) {
    expect(
      (
        await request(ctx.app, "POST", "/keys", {
          key: raw,
          body: {
            label: "Refused",
            source: "refused-profile",
            profile_permissions,
          },
        })
      ).status,
    ).toBe(400);
    expect((await ctx.storage.keys.list()).length).toBe(before + 1);
  }
});
it("rolls back a mint if its response cannot be validated", async () => {
  const original = ctx.storage.keys.create.bind(ctx.storage.keys);
  vi.spyOn(ctx.storage.keys, "create").mockImplementationOnce(
    async (...args) => ({
      ...(await original(...args)),
      created_at: null as never,
    }),
  );
  const before = (await ctx.storage.keys.list()).length;
  const response = await ctx.ownerRequest("/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      label: "Invalid response",
      source: "invalid-response",
    }),
  });
  expect(response.ok).toBe(false);
  expect((await ctx.storage.keys.list()).length).toBe(before);
});
