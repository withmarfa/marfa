/**
 * The capability carrier and the gate that reads it.
 *
 * **The carrier is the half that did not exist.** `hasCapability` has shipped
 * since the grammar landed and no route could call it, because a capability
 * deliberately projects into none of the permission maps: the bearer
 * middleware translated a token's scopes into `type_permissions`,
 * `edge_permissions`, `metadata_permissions` and `profile_permissions` and
 * dropped the rest, so a gate reaching for the helper had no `held` to pass.
 * The wrong repair is to relax one of those projections, which would put
 * administrative authority on the data plane; the right one is to carry the
 * granted scopes onto the request beside them.
 *
 * The two halves are tested together because each is useless alone, and
 * because the failure they guard against is a gate that reads an empty carrier
 * and refuses everybody, or one that reads a missing carrier and admits
 * everybody.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context } from "hono";
import type { ApiKey } from "@withmarfa/shared";
import { MarfaError } from "@withmarfa/shared";
import { authMiddleware, requireCapability, type AppEnv } from "./auth.js";
import {
  createTestContext,
  seedOauthBearer,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

// ---------------------------------------------------------------------------
// The gate

function fakeKey(over: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "k1",
    space_id: "space-1",
    label: "test",
    source: "test",
    role: "space_admin",
    default_tier: "library",
    is_platform: false,
    type_permissions: {},
    extension_permissions: {},
    edge_permissions: {},
    metadata_permissions: {},
    created_at: "2026-01-01T00:00:00.000Z",
    last_used_at: null,
    ...over,
  };
}

/** The three variables the gate reads, and nothing else. */
function fakeContext(vars: {
  apiKey?: ApiKey;
  authType?: "api_key" | "oauth";
  oauthGrant?: { scopes: readonly string[] };
}): Context<AppEnv> {
  return {
    get: (name: string) => (vars as Record<string, unknown>)[name],
  } as unknown as Context<AppEnv>;
}

describe("requireCapability", () => {
  it("lets an API-key caller through, whatever it holds", () => {
    // A capability literal on an API key reaches no permission map and means
    // nothing there: the family exists to name what a person consented to
    // hand an app, and an API key is the person's own credential. Refusing
    // one here would break every self-host in keys mode and the CLI's
    // ordinary admin work, for no security gain.
    expect(() => {
      requireCapability(
        fakeContext({ apiKey: fakeKey(), authType: "api_key" }),
        "capability.keys",
      );
    }).not.toThrow();
  });

  it("refuses an OAuth caller holding no capability, naming the literal", () => {
    let thrown: unknown;
    try {
      requireCapability(
        fakeContext({
          apiKey: fakeKey({ scope_enforced: true }),
          authType: "oauth",
          oauthGrant: { scopes: ["openid", "core.note:read"] },
        }),
        "capability.keys",
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MarfaError);
    const err = thrown as MarfaError;
    expect(err.code).toBe("forbidden");
    // The refusal names what would satisfy it. A generic 403 on an
    // administrative surface sends the reader to the role, which is not what
    // refused them, and the client cannot narrow toward a scope it is not told.
    expect(err.message).toContain("capability.keys");
    expect(err.details).toMatchObject({ required_scope: "capability.keys" });
  });

  it("admits an OAuth caller holding the capability", () => {
    expect(() => {
      requireCapability(
        fakeContext({
          apiKey: fakeKey({ scope_enforced: true }),
          authType: "oauth",
          oauthGrant: { scopes: ["openid", "capability.keys"] },
        }),
        "capability.keys",
      );
    }).not.toThrow();
  });

  it("does not let one capability stand in for another", () => {
    // The family is exact by construction: no wildcard reaches a capability
    // and holding every other member implies nothing about this one.
    expect(() => {
      requireCapability(
        fakeContext({
          apiKey: fakeKey({ scope_enforced: true }),
          authType: "oauth",
          oauthGrant: {
            scopes: ["capability.webhooks", "capability.audit_read"],
          },
        }),
        "capability.keys",
      );
    }).toThrow(MarfaError);
  });

  it("refuses an OAuth caller whose carrier is missing entirely", () => {
    // Fails closed. A carrier that did not get set is a bug in the middleware,
    // and the safe reading of "I cannot tell what was granted" is "nothing was".
    expect(() => {
      requireCapability(
        fakeContext({
          apiKey: fakeKey({ scope_enforced: true }),
          authType: "oauth",
        }),
        "capability.keys",
      );
    }).toThrow(MarfaError);
  });

  it("refuses a caller presenting no credential, bootstrap included", () => {
    // Bootstrap has this exact shape — no `apiKey`, no `authType` — so this
    // helper refuses it, and the mint route's protection is its own
    // `if (!isBootstrap)` block rather than anything here. Pinned so the
    // answer is a decision rather than a surprise at the first call site.
    expect(() => {
      requireCapability(fakeContext({}), "capability.keys");
    }).toThrow(MarfaError);
  });
});

// ---------------------------------------------------------------------------
// The carrier

describe("the bearer middleware carries the grant onto the request", () => {
  let ctx: TestContext;
  let spaceId: string;

  beforeAll(async () => {
    ctx = await createTestContext({ authMode: "hosted" });
    const space = await ctx.storage.spaces!.create("capability-carrier-space");
    spaceId = space.id;
  });
  afterAll(async () => {
    await ctx.cleanup();
  });

  /** A minimal app around the real middleware: the carrier is what is under
   *  test, so nothing else should be able to explain the answer. */
  function probeApp() {
    const app = new Hono<AppEnv>();
    app.use("*", authMiddleware(ctx.storage, TEST_API_KEY_SALT, "hosted"));
    app.get("/probe", (c) =>
      c.json({
        authType: c.get("authType") ?? null,
        grant: c.get("oauthGrant") ?? null,
      }),
    );
    return app;
  }

  it("carries scopes, client id and user id for an OAuth bearer", async () => {
    const seeded = await seedOauthBearer(
      ctx.storage,
      ["openid", "capability.keys", "core.note:read"],
      { userRole: "space_admin", spaceId },
    );
    const res = await probeApp().request("/probe", {
      headers: { Authorization: `Bearer ${seeded.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      authType: string | null;
      grant: {
        scopes: string[];
        clientId: string;
        authUserId: string | null;
      } | null;
    };
    expect(body.authType).toBe("oauth");
    expect(body.grant).not.toBeNull();
    expect(body.grant?.scopes).toContain("capability.keys");
    expect(body.grant?.scopes).toContain("core.note:read");
    expect(body.grant?.clientId).toBe(seeded.clientId);
    expect(body.grant?.authUserId).toBeTruthy();
  });

  it("carries what the projections drop, and does not widen them", async () => {
    // The premise of the whole carrier, asserted rather than assumed: the
    // capability must appear in the grant and in none of the permission maps.
    // If it ever reaches a map, a wildcard on that axis could resolve it and
    // administrative authority would be grantable by breadth — which is the
    // wrong repair `scopes.ts` warns against, and it would be invisible here
    // without this check because the gate would still pass.
    const seeded = await seedOauthBearer(
      ctx.storage,
      ["openid", "capability.keys", "core.note:read"],
      { userRole: "space_admin", spaceId },
    );
    const app = new Hono<AppEnv>();
    app.use("*", authMiddleware(ctx.storage, TEST_API_KEY_SALT, "hosted"));
    app.get("/probe", (c) => {
      const key = c.get("apiKey");
      return c.json({
        grantScopes: c.get("oauthGrant")?.scopes ?? [],
        maps: [
          key?.type_permissions,
          key?.edge_permissions,
          key?.metadata_permissions,
          key?.profile_permissions,
          key?.extension_permissions,
        ],
      });
    });
    const res = await app.request("/probe", {
      headers: { Authorization: `Bearer ${seeded.token}` },
    });
    const body = (await res.json()) as {
      grantScopes: string[];
      maps: (Record<string, string> | undefined)[];
    };
    expect(body.grantScopes).toContain("capability.keys");
    for (const map of body.maps) {
      expect(Object.keys(map ?? {})).not.toContain("capability.keys");
      expect(Object.keys(map ?? {})).not.toContain("capability");
    }
    // And the ordinary literal beside it still projects, so the case is not
    // passing because nothing projected at all.
    expect(Object.keys(body.maps[0] ?? {})).toContain("core.note");
  });

  it("sets no grant for an API-key caller", async () => {
    const res = await probeApp().request("/probe", {
      headers: { Authorization: `Bearer ${ctx.adminKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      authType: string | null;
      grant: unknown;
    };
    expect(body.authType).toBe("api_key");
    expect(body.grant).toBeNull();
  });
});
