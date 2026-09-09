/**
 * Bearer middleware: an OAuth token that resolves to no space is refused, in
 * either mode.
 *
 * Token space binding is written at issuance (`postLogin.consentReferenceId`
 * → `auth_oauth_access_token.reference_id`). When that column is NULL — an
 * unmapped auth_user, a provisioning gap, a space deleted after issuance —
 * the synthetic principal used to carry `space_id: undefined`, and the
 * storage layer treats an absent space id as "no space clause": the
 * operator-key shape, reached by accident. Such a token did not see
 * nothing; it saw every space, bounded only by its granted scopes.
 *
 * **Keys mode used to be exempt, and that exemption became a hole.** It was
 * written when a self-host bound nothing to a space, so a space-less bearer
 * there was the only shape there was. Keys mode has a space now, issuance
 * binds to it, and the exemption would have admitted exactly the principal
 * the row constraint exists to make unwritable — reached through the one path
 * that builds a credential in memory rather than reading a row.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { request, createTestContext, seedOauthBearer } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { resolveSpaceIdForAuthUser } from "../auth/oauth-provider.js";

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

describe("space-less OAuth tokens", () => {
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

    // `null` → the token row's reference_id is NULL, deliberately.
    const { token } = await seedOauthBearer(ctx.storage, ["core.note:read"], {
      spaceId: null,
    });

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

describe("space-less OAuth tokens in keys mode", () => {
  // The exemption's own deployment shape. `resolveSpaceIdForAuthUser` answers
  // from the instance's one space where there is no user store, so a token
  // issued here is bound; and a token that somehow is not is refused rather
  // than admitted, which is what the exemption used to do.
  let keysCtx: TestContext;

  afterEach(async () => {
    await keysCtx.cleanup();
  });

  it("refuses a token that carries no space", async () => {
    keysCtx = await createTestContext();
    if (!keysCtx.storage.spaces) throw new Error("space store expected");
    const space = await keysCtx.storage.spaces.create("the-one-space");
    await keysCtx.storage.items.create(
      {
        type: "core.note",
        tier: "library",
        state: "active",
        properties: { title: "private note", body: "not for a stray token" },
        source: "test/spaceless-oauth-keys",
      },
      space.id,
    );

    const { token } = await seedOauthBearer(
      keysCtx.storage,
      ["core.note:read"],
      { spaceId: null },
    );

    const res = await request(keysCtx.app, "GET", "/items", { key: token });
    expect(res.status).toBe(401);
  });

  it("binds issuance to the instance's one space where there is no user store", async () => {
    keysCtx = await createTestContext();
    if (!keysCtx.storage.spaces) throw new Error("space store expected");
    expect(keysCtx.storage.users).toBeUndefined();
    const [only] = await keysCtx.storage.spaces.list();
    expect(only).toBeDefined();

    const resolved = await resolveSpaceIdForAuthUser(
      keysCtx.storage,
      "auth-user-with-no-row",
    );
    expect(resolved).toBe(only!.id);
  });

  it("resolves nothing where the instance has more than one space", async () => {
    // Two is a state nothing here can choose between, and binding a token to
    // a guess would be worse than refusing it: the token would work, against
    // whichever space the store happened to return first.
    keysCtx = await createTestContext();
    if (!keysCtx.storage.spaces) throw new Error("space store expected");
    await keysCtx.storage.spaces.create("a-second-space");
    expect((await keysCtx.storage.spaces.list()).length).toBeGreaterThan(1);

    const resolved = await resolveSpaceIdForAuthUser(
      keysCtx.storage,
      "auth-user-with-no-row",
    );
    expect(resolved).toBeUndefined();
  });
});
