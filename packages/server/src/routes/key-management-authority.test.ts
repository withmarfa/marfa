import { afterEach, describe, expect, it } from "vitest";
import {
  createTestContext,
  seedOauthBearer,
  type TestContext,
} from "../test-utils.js";

let ctx: TestContext | undefined;
afterEach(async () => {
  await ctx?.cleanup();
});
const json = (body: unknown, bearer?: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
  },
  body: JSON.stringify(body),
});
async function mint(
  context: TestContext,
  source: string,
  permissions: string[],
  bearer?: string,
) {
  const init = json({ label: source, source, permissions }, bearer);
  const response = bearer
    ? await context.app.request("/keys", init)
    : await context.ownerRequest("/keys", init);
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json() as Promise<{
    id: string;
    key: string;
    permissions: string[];
    oauth_client_id?: string;
  }>;
}

describe("management key authority", () => {
  it("lets a manager narrow a wider key without granting minting or widening", async () => {
    ctx = await createTestContext();
    const manager = await mint(ctx, "manager", ["keys.manage"]);
    const target = await mint(ctx, "target", ["instance.read", "blobs.manage"]);
    const list = await ctx.app.request("/keys", {
      headers: { authorization: `Bearer ${manager.key}` },
    });
    expect(list.status).toBe(200);
    expect(
      (await list.json()).data.some(
        (key: { id: string }) => key.id === target.id,
      ),
    ).toBe(true);
    const narrowed = await ctx.app.request(`/keys/${target.id}`, {
      ...json({ permissions: ["instance.read"] }, manager.key),
      method: "PATCH",
    });
    expect(narrowed.status).toBe(200);
    const widened = await ctx.app.request(`/keys/${target.id}`, {
      ...json({ permissions: ["instance.read", "blobs.manage"] }, manager.key),
      method: "PATCH",
    });
    expect(widened.status).toBe(403);
    expect(
      (
        await ctx.app.request(
          "/keys",
          json({ label: "extra", source: "extra" }, manager.key),
        )
      ).status,
    ).toBe(403);
  });

  it("keeps app origin through descendants and forbids widening by the owner", async () => {
    ctx = await createTestContext();
    const app = await seedOauthBearer(ctx, ["keys.mint", "instance.read"]);
    const parent = await mint(
      ctx,
      "app-parent",
      ["keys.mint", "instance.read"],
      app.token,
    );
    const child = await mint(
      ctx,
      "app-child",
      ["keys.mint", "instance.read"],
      parent.key,
    );
    const descendant = await mint(
      ctx,
      "app-descendant",
      ["instance.read"],
      child.key,
    );
    for (const key of [parent, child, descendant])
      expect(key.oauth_client_id).toBe(app.clientId);
    const widened = await ctx.ownerRequest(`/keys/${descendant.id}`, {
      ...json({ permissions: ["instance.read", "blobs.manage"] }),
      method: "PATCH",
    });
    expect(widened.status).toBe(403);
    const narrowed = await ctx.ownerRequest(`/keys/${descendant.id}`, {
      ...json({ permissions: [] }),
      method: "PATCH",
    });
    expect(narrowed.status).toBe(200);
    expect((await narrowed.json()).oauth_client_id).toBe(app.clientId);
  });

  it("never combines an app token with an owner cookie", async () => {
    ctx = await createTestContext();
    const app = await seedOauthBearer(ctx, ["instance.read"]);
    const response = await ctx.ownerRequest(
      "/keys",
      json(
        { label: "mixed", source: "mixed", permissions: ["keys.manage"] },
        app.token,
      ),
    );
    expect(response.status).toBe(403);
    const malformed = await ctx.ownerRequest(
      "/keys",
      json({ label: "mixed", source: "mixed" }, "invalid"),
    );
    expect(malformed.status).toBe(401);
  });

  it("requires config.manage for enforcement overrides even with key management", async () => {
    ctx = await createTestContext();
    const manager = await mint(ctx, "manager", ["keys.manage"]);
    const target = await mint(ctx, "target", ["instance.read"]);
    const response = await ctx.app.request(`/keys/${target.id}`, {
      ...json({ enforcement_override: {} }, manager.key),
      method: "PATCH",
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error.details.required_scope).toBe(
      "config.manage",
    );
  });
});
