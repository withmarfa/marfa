import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, seedOauthBearer } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { sameScopeSet } from "./consent-scopes.js";

/**
 * `OauthProviderStore.setConsentScopes` — the checked write behind the
 * silent re-authorization path's restoration of a standing grant.
 *
 * The caller reads the standing scopes, hands the request to the OAuth
 * Provider plugin (which rewrites the row to whatever the client asked
 * for), then writes the read-back set again. That value is stale by
 * construction, so the write carries the value it expects to find. If the
 * grant moved on in the meantime — narrowed on the consent screen,
 * revoked from `/auth/security`, or rewritten by another server process
 * — the restoration is declined rather than applied over the top.
 *
 * `scopes` is a JSON text column, and the guard has to hold on it.
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

describe("sameScopeSet", () => {
  it("compares membership, not order or repetition", () => {
    expect(sameScopeSet(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameScopeSet(["a", "a", "b"], ["a", "b"])).toBe(true);
    expect(sameScopeSet(["a", "b"], ["a"])).toBe(false);
    expect(sameScopeSet([], [])).toBe(true);
  });
});

describe("OauthProviderStore.setConsentScopes", () => {
  it("writes when the row still holds the expected scopes", async () => {
    ctx = await createTestContext();
    const store = ctx.storage.oauthProvider!;
    const { clientId } = await seedOauthBearer(ctx, ["openid"]);
    const wrote = await store.setConsentScopes(
      clientId,
      ctx.owner.id,
      ["openid", "core.note:read"],
      ["openid"],
    );
    expect(wrote).toBe(true);
    expect(
      [...(await store.getPriorConsent(clientId, ctx.owner.id))!].sort(),
    ).toEqual(["core.note:read", "openid"]);
  });

  it("declines when the grant was narrowed after the caller read it", async () => {
    ctx = await createTestContext();
    const store = ctx.storage.oauthProvider!;
    const { clientId } = await seedOauthBearer(ctx, [
      "openid",
      "core.note:read",
    ]);
    const wrote = await store.setConsentScopes(
      clientId,
      ctx.owner.id,
      ["openid", "core.note:read", "core.task:read"],
      ["openid"],
    );
    expect(wrote).toBe(false);
    expect(await store.getPriorConsent(clientId, ctx.owner.id)).not.toContain(
      "core.task:read",
    );
  });

  it("declines when the grant was revoked after the caller read it", async () => {
    ctx = await createTestContext();
    const store = ctx.storage.oauthProvider!;
    const { clientId, grantId } = await seedOauthBearer(ctx, ["openid"]);
    expect(
      (await ctx.ownerRequest(`/auth/grants/${grantId}`, { method: "DELETE" }))
        .status,
    ).toBe(204);
    const wrote = await store.setConsentScopes(
      clientId,
      ctx.owner.id,
      ["openid", "core.note:read"],
      ["openid"],
    );
    expect(wrote).toBe(false);
    expect(await store.getPriorConsent(clientId, ctx.owner.id)).toBeUndefined();
  });

  it("scopes the guard to the client and owner pair", async () => {
    ctx = await createTestContext();
    const store = ctx.storage.oauthProvider!;
    const first = await seedOauthBearer(ctx, ["openid"]);
    const second = await seedOauthBearer(ctx, ["core.note:read"]);
    expect(
      await store.setConsentScopes(
        second.clientId,
        ctx.owner.id,
        ["core.note:read", "core.task:read"],
        ["openid"],
      ),
    ).toBe(false);
    expect(await store.getPriorConsent(second.clientId, ctx.owner.id)).toEqual([
      "core.note:read",
    ]);
    expect(
      await store.setConsentScopes(
        first.clientId,
        "unknown-account",
        ["core.note:read"],
        ["openid"],
      ),
    ).toBe(false);
    expect(await store.getPriorConsent(first.clientId, ctx.owner.id)).toEqual([
      "openid",
    ]);
  });
});
