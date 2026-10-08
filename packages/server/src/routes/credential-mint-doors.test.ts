/**
 * Every way of asking for a credential, pinned together.
 *
 * Two privilege escalations landed on the same endpoint within six
 * weeks. Both fixes were correct and each closed one specific way of
 * asking — and in both cases an existing test asserted the permissive
 * behavior, which is why both passed review. Testing a mint path on its
 * own cannot catch the next one: the property worth asserting is the
 * ceiling itself, across every door, in the shape
 * `routes/item-write-doors.test.ts` established for item writes.
 *
 * The invariant is stated in `auth/mint-ceiling.ts`: no minting path may
 * issue a credential whose authority exceeds, on any axis, the authority
 * of the principal or governing declaration that authorized the mint —
 * the permissions it holds and the breadth of its
 * content maps. Quoted from that file rather than
 * paraphrased, because this comment named a role lattice long after the
 * lattice had gone and the file it cites had stopped listing one. Each door
 * below asserts one over-ceiling ask refused AND one at-ceiling mint
 * permitted, because a gate that refuses everyone is as wrong as one that
 * refuses no one.
 *
 * The coverage check at the bottom has three legs, because the surface
 * is only half route-table: the published OpenAPI document is reflected
 * for operations whose success response carries secret material, the two
 * doors the provider plugin serves outside the spec (registration and the
 * device grant) are pinned against the discovery document, and the
 * discovery document's grant list is pinned exactly — a plugin upgrade
 * that starts advertising a new grant type fails the pin and forces a
 * door row or a named exclusion.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  inlineOpenApiRefs,
  request,
  seedOauthBearer,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { PERMISSIONS } from "@withmarfa/shared";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({});
});

afterAll(async () => {
  await ctx.cleanup();
});

const ORIGIN = "http://localhost:0";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function mintFullWorkingKey(): Promise<string> {
  const raw = `marfa_k1_minttest_${Math.random().toString(36).slice(2, 14)}`;
  await ctx.storage.keys.create(
    {
      label: "mint-door-working-key",
      source: `mint-door-${Math.random().toString(36).slice(2, 10)}`,
      permissions: PERMISSIONS.filter(
        (permission) => permission !== "config.manage",
      ),
      type_permissions: { "*": "write" },
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
  );
  return raw;
}

// ---------------------------------------------------------------------------
// The doors
// ---------------------------------------------------------------------------

interface MintDoor {
  name: string;
  /** OpenAPI path form (`{id}`) for spec-visible doors, matched by the
   *  coverage reflection below. `null` for doors outside the spec —
   *  those are pinned in PINNED_HONO_MINT_ROUTES instead. */
  specRoute: string | null;
  ceiling: () => Promise<void>;
  /**
   * The door refuses a `source` naming a connection's own credential.
   *
   * A second axis, because the census had the right scope and exercised
   * the wrong one. Every row asserted the role ceiling and the platform
   * flag; none asserted `source`, so a door writing its label verbatim
   * into the column sat inside an enumerated door and read as covered.
   *
   * `source` is not a description. It is read as an assertion about who
   * the caller is, and a door that writes a caller-supplied label straight
   * into the column lets the caller make that assertion about itself.
   *
   * `undefined` where a door takes no caller-supplied source at all, and
   * that has to be stated rather than left off — an absent hook and a
   * deliberate exemption must not look the same.
   */
  forgedSource?: () => Promise<void>;
}

/** Doors that never take a caller-supplied `source`, with the reason. */
const NO_CALLER_SOURCE: Record<string, string> = {
  "POST /auth/oauth2/register — the ceiling is the allowlist and nothing outside it":
    "registers a client, mints no credential row and takes no source",
  "POST /auth/oauth2/token (device grant) — nothing mints without an approved code":
    "issues against an approved device code; the source is the grant's",
};

const DOORS: MintDoor[] = [
  {
    name: "POST /keys — a mint is clamped to the creator",
    specRoute: "post /keys",
    forgedSource: async () => {
      const caller = await mintFullWorkingKey();
      const res = await request(ctx.app, "POST", "/keys", {
        key: caller,
        body: {
          label: "forged",
          source: `oauth:${"c".repeat(8)}`,
        },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    },
    ceiling: async () => {
      const workingKey = await mintFullWorkingKey();

      // A named permission the caller does not hold cannot be delegated.
      const platform = await request(ctx.app, "POST", "/keys", {
        key: workingKey,
        body: {
          label: "over-ceiling",
          source: "over-ceiling",
          permissions: ["config.manage"],
        },
      });
      expect(platform.status).toBe(403);

      // At the ceiling: a mint narrower than the creator works.
      const member = await request(ctx.app, "POST", "/keys", {
        key: workingKey,
        body: {
          label: "down",
          source: "mint-down",
          permissions: ["webhooks.manage"],
        },
      });
      expect(member.status).toBe(201);
    },
  },
  {
    // The same spec route as the row above, and a second row rather than a
    // longer one: this is a different principal reaching the same door, and it
    // carries its permissions as scope literals rather than as stored maps.
    // `specRoute` repeats
    // deliberately — the coverage check reads a Set, so a door reachable two
    // ways is named twice and counted once.
    //
    // The axis is new. Until this shipped, `POST /keys` refused an OAuth caller
    // outright, and that refusal was the whole ceiling. Now a session may mint,
    // so the ceiling has to be stated: never past the reach the grant covers,
    // on any of the families or on the permissions.
    name: "POST /keys — a session mints no wider than its own grant",
    specRoute: "post /keys",
    forgedSource: async () => {
      const { token } = await seedOauthBearer(ctx, ["openid", "keys.mint"], {});
      const res = await request(ctx.app, "POST", "/keys", {
        key: token,
        body: {
          label: "forged",
          source: `oauth:${"c".repeat(8)}`,
        },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    },
    ceiling: async () => {
      const scopes = ["openid", "keys.mint", "core.note:read"];

      // Over the ceiling: no permission, so the door does not open at
      // all.
      const ungranted = await seedOauthBearer(ctx, ["openid"], {});
      const refused = await request(ctx.app, "POST", "/keys", {
        key: ungranted.token,
        body: { label: "no cap", source: "oauth-no-cap" },
      });
      expect(refused.status).toBe(403);

      // Over the ceiling: reach the grant does not cover. `core.note:read`
      // does not cover `core.note:write` — the verb ranks.
      const granted = await seedOauthBearer(ctx, scopes, {});
      const wider = await request(ctx.app, "POST", "/keys", {
        key: granted.token,
        body: {
          label: "wider",
          source: "oauth-wider",
          type_permissions: { "core.note": "write" },
        },
      });
      expect(wider.status).toBe(403);

      // Over the ceiling on the permission axis: a permission the
      // grant does not carry, which is the axis a content clamp cannot see.
      const beyond = await request(ctx.app, "POST", "/keys", {
        key: granted.token,
        body: {
          label: "beyond",
          source: "oauth-beyond",
          permissions: ["config.manage"],
        },
      });
      expect(beyond.status).toBe(403);

      // At the ceiling: a key like the session, held to the same maps — without
      // which the clamp above lasts until first use.
      const at = await request(ctx.app, "POST", "/keys", {
        key: granted.token,
        body: { label: "like me", source: "oauth-like-me" },
      });
      expect(at.status).toBe(201);
      const body = (await at.json()) as { id: string };
      const stored = await ctx.storage.keys.get(body.id);
      expect(stored).not.toHaveProperty("is_operator");
      expect(stored?.type_permissions["core.note"]).toBe("read");
      expect(stored?.permissions).toEqual(["keys.mint"]);
    },
  },
  {
    name: "POST /auth/oauth2/register — the ceiling is the allowlist and nothing outside it",
    // Spec-visible since the plugin's registration issues a `client_secret`
    // to a confidential client, so leg 1 reflects it.
    specRoute: "post /auth/oauth2/register",
    ceiling: async () => {
      // Over the ceiling: a scope the server does not have is refused, so no
      // client is ever registered for reach the allowlist never granted.
      const over = await request(ctx.app, "POST", "/auth/oauth2/register", {
        body: {
          application_type: "native",
          token_endpoint_auth_method: "none",
          redirect_uris: ["http://localhost/cb"],
          grant_types: ["authorization_code"],
          client_name: "mint-door-dcr-over",
          scope: "core.note:read not.a.type:write",
        },
      });
      expect(over.status).toBe(400);

      // At the ceiling: a scope-less registration is given the allowlist the
      // server advertises, and nothing beyond it. The plugin's registration
      // stores that one ceiling for every client, so the consent screen is
      // the narrowing; `oauth-mint-ceilings.test.ts` pins the rule.
      const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
        body: {
          application_type: "native",
          token_endpoint_auth_method: "none",
          redirect_uris: ["http://localhost/cb"],
          grant_types: ["authorization_code"],
          client_name: "mint-door-dcr",
        },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { scope: string };
      const discovery = await request(
        ctx.app,
        "GET",
        "/.well-known/oauth-authorization-server/auth",
        {},
      );
      const advertised = new Set(
        ((await discovery.json()) as { scopes_supported?: string[] })
          .scopes_supported ?? [],
      );
      for (const scope of body.scope.split(" ").filter(Boolean)) {
        expect(advertised.has(scope), `${scope} is not advertised`).toBe(true);
      }

      // The one grant with no user in it is not a grant this server has, so
      // no client registers for it and there is no mint door to bound. A
      // machine acting on this server is an API key, which the keys doors
      // above already cover.
      const m2m = await request(ctx.app, "POST", "/auth/oauth2/register", {
        body: {
          grant_types: ["client_credentials"],
          client_name: "mint-door-m2m",
        },
      });
      expect(m2m.status).toBe(400);
    },
  },
  {
    name: "POST /auth/oauth2/token (device grant) — nothing mints without an approved code",
    specRoute: null,
    ceiling: async () => {
      // The approved-scope ceiling (token scopes = the literals the user
      // ticked) is pinned end-to-end in device-grant.test.ts; this row
      // pins the door itself: a code nobody issued mints nothing.
      const res = await ctx.app.fetch(
        new Request(`${ORIGIN}/auth/oauth2/token`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: ORIGIN,
          },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: "marfa_dc_never_issued",
            client_id: "nobody",
          }).toString(),
        }),
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeTruthy();
    },
  },
];

describe("the source axis is asserted or exempted, never merely absent", () => {
  it("gives every door a forged-source case or a stated reason", () => {
    // An optional hook makes a door added without one indistinguishable
    // from a deliberate exemption, which is exactly how the console form
    // sat inside an enumerated door reading as covered.
    for (const door of DOORS) {
      if (door.name in NO_CALLER_SOURCE) {
        expect(
          door.forgedSource,
          `${door.name}: exempt, so it must not also carry a case`,
        ).toBeUndefined();
        continue;
      }
      expect(
        door.forgedSource,
        `${door.name}: needs a forgedSource case, or a reason in NO_CALLER_SOURCE`,
      ).toBeDefined();
    }
  });

  it("names only doors that exist", () => {
    const names = new Set(DOORS.map((d) => d.name));
    for (const name of Object.keys(NO_CALLER_SOURCE)) {
      expect(names.has(name), `stale exemption: ${name}`).toBe(true);
    }
  });
});

describe.each(DOORS)("$name", (door) => {
  it("holds its ceiling in both directions", async () => {
    await door.ceiling();
  });

  it.skipIf(door.name in NO_CALLER_SOURCE)(
    "refuses a source naming a connection's own credential",
    async () => {
      const forged = door.forgedSource;
      /* v8 ignore next */
      if (!forged) throw new Error("guarded by skipIf");
      await forged();
    },
  );
});

// ---------------------------------------------------------------------------
// Coverage: a new way of asking must land here
// ---------------------------------------------------------------------------

/**
 * Spec-visible operations whose success response carries secret material
 * but that are NOT credential mints, each with the reason it is excluded.
 * Keys are `<method> <path>` in OpenAPI form.
 *
 * Minting paths with no HTTP surface are invisible to every leg in this
 * file by construction. Those live in `auth/non-http-mint-ceilings.test.ts`,
 * which pins the in-process call sites and holds them to the same
 * two-directional shape; extend there, not here, when a mint has no route.
 */
const NOT_A_MINT_DOOR: Record<string, string> = {};

/** Secret-bearing property names a mint's success response carries. A
 *  route that mints a bearer cannot hide it from its own response
 *  schema: a generated client reads it from there. */
const SECRET_PROPERTIES = new Set([
  "key",
  "api_key",
  "access_token",
  "lease_token",
  "client_secret",
]);

/** Mint doors invisible to the OpenAPI reflection, served by the provider
 *  plugin and advertised in its discovery document. A brand-new door on
 *  that side escapes leg 1 by construction — this list plus the grant pin
 *  below are the fences there, and the honest limit is that a new door
 *  needs a reviewer to add it here. Each entry is checked against the
 *  advertised endpoint so a moved door fails as stale rather than
 *  silently unpinning. */
const PINNED_ADVERTISED_DOORS: Record<string, RegExp> = {
  device_authorization_endpoint: /\/auth\/device\/code$/,
};

describe("every way of asking for a credential is accounted for", () => {
  it("spec-visible secret-bearing operations each have a door row or a stated reason", async () => {
    const res = await request(ctx.app, "GET", "/openapi.json", {});
    expect(res.status).toBe(200);
    // Resolved, because a response body carrying a secret reaches the
    // document as a reference to a registered component: read unresolved,
    // every operation looks as though it declares no properties at all and
    // the sweep below finds nothing to classify.
    const served = (await res.json()) as Record<string, unknown>;
    const spec = inlineOpenApiRefs(served, served) as {
      paths: Record<
        string,
        Record<
          string,
          {
            responses?: Record<
              string,
              {
                content?: Record<
                  string,
                  { schema?: { properties?: Record<string, unknown> } }
                >;
              }
            >;
          }
        >
      >;
    };

    const covered = new Set(
      DOORS.map((d) => d.specRoute).filter((r): r is string => r !== null),
    );
    const unclassified: string[] = [];
    const secretBearing = new Set<string>();

    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        const route = `${method} ${path}`;
        const success = Object.entries(op.responses ?? {}).filter(([code]) =>
          code.startsWith("2"),
        );
        const carriesSecret = success.some(([, resp]) =>
          Object.values(resp.content ?? {}).some((c) =>
            Object.keys(c.schema?.properties ?? {}).some((p) =>
              SECRET_PROPERTIES.has(p),
            ),
          ),
        );
        if (!carriesSecret) continue;
        secretBearing.add(route);
        if (covered.has(route)) continue;
        if (route in NOT_A_MINT_DOOR) continue;
        unclassified.push(route);
      }
    }
    expect(unclassified).toEqual([]);

    // Staleness, both directions: an excused or covered route that no
    // longer carries a secret (renamed, reshaped) must not keep its row.
    for (const route of Object.keys(NOT_A_MINT_DOOR)) {
      expect(secretBearing.has(route), `stale exclusion: ${route}`).toBe(true);
    }
    for (const route of covered) {
      expect(secretBearing.has(route), `stale door: ${route}`).toBe(true);
    }
  });

  it("the plugin-served doors are still advertised under their pinned paths", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/.well-known/oauth-authorization-server/auth",
      {},
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    for (const [field, path] of Object.entries(PINNED_ADVERTISED_DOORS)) {
      expect(body[field], `stale pin: ${field}`).toMatch(path);
    }
  });

  it("the token endpoint advertises exactly the grants with door coverage", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/.well-known/oauth-authorization-server/auth",
      {},
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grant_types_supported?: string[] };
    // A plugin upgrade that starts advertising a new grant type is a new
    // way of asking for a credential: it fails this pin and forces a
    // door row or a named exclusion, not a silent widening.
    //
    // `client_credentials` is absent because the server does not have it.
    // The plugin advertises it unconditionally and the discovery document is
    // filtered, so this pin is also what would notice the filter being lost.
    expect([...(body.grant_types_supported ?? [])].sort()).toEqual(
      [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:device_code",
      ].sort(),
    );
  });
});
