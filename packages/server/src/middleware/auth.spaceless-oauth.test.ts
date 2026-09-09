/**
 * Bearer middleware: an OAuth token that resolves to no space is refused in
 * hosted mode.
 *
 * Token space binding is written at issuance (`postLogin.consentReferenceId`
 * → `auth_oauth_access_token.reference_id`). When that column is NULL — an
 * unmapped auth_user, a provisioning gap, a space deleted after issuance —
 * the synthetic principal used to carry `space_id: undefined`, and the
 * storage layer treats an absent space id as "no space clause": the
 * operator-key shape, reached by accident. Such a token did not see
 * nothing; it saw every space, bounded only by its granted scopes.
 *
 * Hosted mode refuses these tokens outright. Keys mode is untouched: there,
 * credentials are space-less by design and the single-space deployment is
 * the boundary.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { request, createTestContext, seedOauthBearer } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext({ authMode: "hosted" });
});

afterEach(async () => {
  await ctx.cleanup();
});

function spaces() {
  if (!ctx.storage.spaces) {
    throw new Error("hosted-mode storage missing space store");
  }
  return ctx.storage.spaces;
}

describe("space-less OAuth tokens (hosted mode)", () => {
  it("refuses a token whose reference resolves to no space", async () => {
    // A real space with a real item — the data a space-less token must not
    // be able to reach.
    const space = await spaces().create("victim-space");
    await ctx.storage.items.create(
      {
        type: "core.note",
        tier: "library",
        state: "active",
        properties: { title: "private note", body: "not for cross-space eyes" },
        source: "test/spaceless-oauth",
      },
      space.id,
    );

    // No spaceId → the token row's reference_id is NULL.
    const { token } = await seedOauthBearer(ctx.storage, ["core.note:read"]);

    const res = await request(ctx.app, "GET", "/items", { key: token });
    expect(res.status).toBe(401);
  });

  it("still serves a properly space-bound token", async () => {
    const space = await spaces().create("bound-space");
    await ctx.storage.items.create(
      {
        type: "core.note",
        tier: "library",
        state: "active",
        properties: { title: "own note", body: "visible to its own space" },
        source: "test/spaceless-oauth",
      },
      space.id,
    );

    const { token } = await seedOauthBearer(ctx.storage, ["core.note:read"], {
      spaceId: space.id,
    });

    const res = await request(ctx.app, "GET", "/items", { key: token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { properties: { title: string } }[];
    };
    expect(body.data.some((i) => i.properties.title === "own note")).toBe(true);
  });
});
