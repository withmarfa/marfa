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
 * role lattice, platform flag, space binding, scope or permission
 * breadth. Each door below asserts one over-ceiling ask refused AND one
 * at-ceiling mint permitted, because a gate that refuses everyone is as
 * wrong as one that refuses no one.
 *
 * The coverage check at the bottom has three legs, because the surface
 * is only half route-table: the published OpenAPI document is reflected
 * for operations whose success response carries secret material, the
 * plain-Hono mint routes (HTML form, device token, DCR) are pinned
 * against the live route table, and the discovery document's grant list
 * is pinned exactly — a plugin upgrade that starts advertising a new
 * grant type fails the pin and forces a door row or a named exclusion.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  markEmailVerified,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  // Hosted: space binding and the auth surfaces only exist there.
  ctx = await createTestContext({ authMode: "hosted", authAllowSignup: true });
});

afterAll(async () => {
  await ctx.cleanup();
});

const ORIGIN = "http://localhost:0";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function mintSpaceAdmin(spaceId: string): Promise<string> {
  const raw = `marfa_k1_minttest_${Math.random().toString(36).slice(2, 14)}`;
  await ctx.storage.keys.create(
    {
      label: "mint-door-space-admin",
      source: `mint-door-${Math.random().toString(36).slice(2, 10)}`,
      role: "space_admin",
      type_permissions: { "*": "write" },
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    spaceId,
  );
  return raw;
}

/** Sign up + verify + sign in; returns the session cookie. Hosted
 *  sign-up provisions the account as space_admin, which is exactly the
 *  rank the console door's ceiling has to hold at. */
async function signInAndCookie(email: string): Promise<string> {
  const password = "correct horse battery";
  await request(ctx.app, "POST", "/auth/sign-up/email", {
    body: { email, password, name: "Mint Door" },
    headers: { origin: ORIGIN },
  });
  await markEmailVerified(ctx.storage, email);
  const signIn = await request(ctx.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  expect(signIn.status).toBe(200);
  const setCookie = signIn.headers.get("set-cookie") ?? "";
  const cookie = setCookie
    .split(/,\s*(?=[a-zA-Z0-9_-]+=)/)
    .map((chunk) => chunk.split(";")[0])
    .find((head) => head?.includes("session_token"));
  expect(cookie).toBeTruthy();
  return cookie ?? "";
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
   * flag; none asserted `source`, so `POST /auth/keys` writing its label
   * verbatim into the column sat inside an enumerated door and read as
   * covered.
   *
   * `source` is not a description. `oauth:<connection-id>` is read as
   * proof that a caller IS that connection, by the connection proxy and
   * by the inbound-webhook routes, both as an alternative to
   * space-admin rank. A member who could name one was handed the
   * connection's upstream token and its webhook secrets.
   *
   * `undefined` where a door takes no caller-supplied source at all, and
   * that has to be stated rather than left off — an absent hook and a
   * deliberate exemption must not look the same.
   */
  forgedSource?: () => Promise<void>;
}

/** Doors that never take a caller-supplied `source`, with the reason. */
const NO_CALLER_SOURCE: Record<string, string> = {
  "POST /connections/{id}/lease-tokens — claims are bounded in shape":
    "mints a lease token against a connection it resolves, taking no source",
  "POST /auth/oauth2/register — an omitted scope is not the allowlist":
    "registers a client, mints no credential row and takes no source",
  "POST /auth/device/token — nothing mints without an approved grant":
    "issues against an approved device grant; the source is the grant's",
};

const DOORS: MintDoor[] = [
  {
    name: "POST /keys — role travels down the lattice, space is inherited",
    specRoute: "post /keys",
    forgedSource: async () => {
      const spaceId = `t-forge-${Math.random().toString(36).slice(2, 10)}`;
      const caller = await mintSpaceAdmin(spaceId);
      const res = await request(ctx.app, "POST", "/keys", {
        key: caller,
        body: {
          label: "forged",
          source: `oauth:${"c".repeat(8)}`,
          role: "member",
        },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    },
    ceiling: async () => {
      const spaceId = `t-mint-${Math.random().toString(36).slice(2, 10)}`;
      const spaceAdmin = await mintSpaceAdmin(spaceId);

      // Over the ceiling: a space_admin asking for admin rank.
      const escalate = await request(ctx.app, "POST", "/keys", {
        key: spaceAdmin,
        body: { label: "up", source: "mint-up", role: "instance_admin" },
      });
      expect(escalate.status).toBeGreaterThanOrEqual(400);

      // Over the ceiling: naming a space — binding is inherited, never chosen.
      const crossSpace = await request(ctx.app, "POST", "/keys", {
        key: spaceAdmin,
        body: {
          label: "aim",
          source: "mint-aim",
          role: "member",
          space_id: "some-other-space",
        },
      });
      expect(crossSpace.status).toBeGreaterThanOrEqual(400);

      // Over the ceiling: claiming the platform flag without holding it.
      const platform = await request(ctx.app, "POST", "/keys", {
        key: spaceAdmin,
        body: {
          label: "flag",
          source: "mint-flag",
          role: "member",
          is_platform: true,
        },
      });
      expect(platform.status).toBe(201);
      const platformBody = (await platform.json()) as {
        is_platform?: boolean;
      };
      expect(platformBody.is_platform ?? false).toBe(false);

      // At the ceiling: sideways-or-down mints work.
      const member = await request(ctx.app, "POST", "/keys", {
        key: spaceAdmin,
        body: { label: "down", source: "mint-down", role: "member" },
      });
      expect(member.status).toBe(201);
    },
  },
  {
    name: "POST /admin/spaces/{id}/keys — platform mints space-confined authority",
    specRoute: "post /admin/spaces/{id}/keys",
    forgedSource: async () => {
      const created = await request(ctx.app, "POST", "/admin/spaces", {
        key: ctx.adminKey,
        body: { name: `forged-${Math.random().toString(36).slice(2, 8)}` },
      });
      expect(created.status).toBe(201);
      const spaceId = ((await created.json()) as { id: string }).id;
      const res = await request(
        ctx.app,
        "POST",
        `/admin/spaces/${spaceId}/keys`,
        {
          key: ctx.adminKey,
          body: {
            label: "forged",
            source: `integration:${"c".repeat(8)}`,
            role: "member",
          },
        },
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
    },
    ceiling: async () => {
      const created = await request(ctx.app, "POST", "/admin/spaces", {
        key: ctx.adminKey,
        body: { name: "mint-door-space" },
      });
      expect(created.status).toBe(201);
      const spaceId = ((await created.json()) as { id: string }).id;
      const res = await request(
        ctx.app,
        "POST",
        `/admin/spaces/${spaceId}/keys`,
        {
          key: ctx.adminKey,
          body: {
            label: "space-scoped",
            source: `mint-adm-${Math.random().toString(36).slice(2, 8)}`,
            role: "instance_admin",
            is_platform: true,
          },
        },
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { is_platform?: boolean };
      // The platform flag never rides through this door: a space-bound
      // admin is deliberately less than the platform tier.
      expect(body.is_platform ?? false).toBe(false);
    },
  },
  {
    name: "POST /connections/{id}/lease-tokens — claims are bounded in shape",
    specRoute: "post /connections/{id}/lease-tokens",
    ceiling: async () => {
      // Shape bound only: a lease grants no Marfa data-plane authority
      // (its scopes are claims relayed to the introspecting upstream),
      // so the ceiling here is that introspection cannot become an
      // unbounded storage channel. Semantic depth lives in
      // oauth-mint-ceilings.test.ts and the lease suite.
      const res = await request(
        ctx.app,
        "POST",
        "/connections/nonexistent/lease-tokens",
        {
          key: ctx.adminKey,
          body: {
            capability_id: "cap",
            scopes: Array.from({ length: 33 }, (_, i) => `c-${String(i)}`),
          },
        },
      );
      expect(res.status).toBe(400);
    },
  },
  {
    name: "POST /auth/keys — the console form mints at the owner's rank, never platform",
    specRoute: null,
    forgedSource: async () => {
      // The console form writes its label into `source`, so the label is
      // where a connection identity would be forged. It answers 200 with
      // an error page rather than a status, so the row is the assertion:
      // nothing may be minted carrying a reserved source.
      const email = `mint-forge-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const cookie = await signInAndCookie(email);
      const label = `oauth:${"c".repeat(8)}`;
      await ctx.app.fetch(
        new Request(`${ORIGIN}/auth/keys`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: ORIGIN,
            cookie,
          },
          body: new URLSearchParams({ label, full_access: "on" }).toString(),
        }),
      );
      const rows = await ctx.storage.keys.list();
      expect(rows.some((k) => k.source === label)).toBe(false);
      expect(rows.some((k) => k.label === label)).toBe(false);
    },
    ceiling: async () => {
      const email = `mint-door-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const cookie = await signInAndCookie(email);
      const label = `console-${Math.random().toString(36).slice(2, 8)}`;
      const res = await ctx.app.fetch(
        new Request(`${ORIGIN}/auth/keys`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: ORIGIN,
            cookie,
          },
          body: new URLSearchParams({ label, full_access: "on" }).toString(),
        }),
      );
      expect(res.status).toBe(200);

      // Resolve the stored key by its label and assert the ceiling on
      // the row itself — the response is HTML.
      const rows = await ctx.storage.keys.list();
      const stored = rows.find((k) => k.label === label);
      expect(stored).toBeDefined();
      expect(stored?.is_platform ?? false).toBe(false);
      // Hosted sign-up provisions space_admin; full access mints at that
      // rank and no higher.
      expect(stored?.role).toBe("space_admin");
      expect(stored?.space_id).toBeTruthy();
    },
  },
  {
    name: "POST /auth/oauth2/register — an omitted scope is not the allowlist",
    specRoute: null,
    ceiling: async () => {
      const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
        body: {
          redirect_uris: ["http://localhost/cb"],
          grant_types: ["authorization_code"],
          client_name: "mint-door-dcr",
        },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { scope: string };
      // Exact literals — `user.*:write` legitimately rides in the bundle
      // default and contains "*:write" as a substring.
      const registered = new Set(body.scope.split(" "));
      expect(registered.has("*:write")).toBe(false);
      expect(registered.has("*:read")).toBe(false);

      // The one grant with no user in it cannot be registered without
      // authenticating — the fence in front of client_credentials.
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
    name: "POST /auth/device/token — nothing mints without an approved grant",
    specRoute: null,
    ceiling: async () => {
      // The approved-scope ceiling (token scopes = the literals the user
      // approved) is pinned end-to-end in device-grant.test.ts; this row
      // pins the door itself: an unapproved ask mints nothing.
      const res = await ctx.app.fetch(
        new Request(`${ORIGIN}/auth/device/token`, {
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
 *  schema — the SDK reads it from there. */
const SECRET_PROPERTIES = new Set([
  "key",
  "api_key",
  "access_token",
  "lease_token",
  "client_secret",
]);

/** Plain-Hono mint doors invisible to the OpenAPI reflection. A brand-new
 *  plain-Hono mint route escapes leg 1 by construction — this list plus
 *  the discovery-document pin below are the fences on that side, and the
 *  honest limit is that a new HTML-form mint needs a reviewer to add it
 *  here. Each entry is checked against the live route table so a renamed
 *  route fails as stale rather than silently unpinning. */
const PINNED_HONO_MINT_ROUTES = [
  "POST /auth/keys",
  "POST /auth/device/token",
  "POST /auth/oauth2/register",
];

describe("every way of asking for a credential is accounted for", () => {
  it("spec-visible secret-bearing operations each have a door row or a stated reason", async () => {
    const res = await request(ctx.app, "GET", "/openapi.json", {});
    expect(res.status).toBe(200);
    const spec = (await res.json()) as {
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

  it("the plain-Hono mint routes still exist under their pinned paths", () => {
    const registered = new Set(
      ctx.app.routes.map((r) => `${r.method} ${r.path}`),
    );
    for (const route of PINNED_HONO_MINT_ROUTES) {
      expect(registered.has(route), `stale pin: ${route}`).toBe(true);
    }
  });

  it("the token endpoint advertises exactly the grants with door coverage", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/.well-known/oauth-authorization-server",
      {},
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grant_types_supported?: string[] };
    // A plugin upgrade that starts advertising a new grant type is a new
    // way of asking for a credential: it fails this pin and forces a
    // door row or a named exclusion, not a silent widening.
    expect([...(body.grant_types_supported ?? [])].sort()).toEqual(
      [
        "authorization_code",
        "client_credentials",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:device_code",
      ].sort(),
    );
  });
});

describe("the console form mints no key it would describe wrongly", () => {
  /** Post the key form as a browser would, and hand back the stored row. */
  async function mintThroughForm(
    cookie: string,
    label: string,
    fields: Record<string, string>[],
  ): Promise<{ status: number }> {
    const body = new URLSearchParams();
    body.set("label", label);
    for (const field of fields) {
      for (const [k, v] of Object.entries(field)) body.append(k, v);
    }
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/keys`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
          cookie,
        },
        body: body.toString(),
      }),
    );
    return { status: res.status };
  }

  it("drops a hand-crafted content-category literal instead of minting on it", async () => {
    // The form's picker emits `<type>:<verb>` only, so this shape takes a
    // hand-crafted post — and it stopped being refused by the scope grammar
    // the day the category began parsing. Admitting one mints a key whose own
    // summary is wrong in the widest possible direction: the category
    // projects the global wildcard, so the key writes every non-system type
    // in the space, while the level the form reads back off the ticked type
    // scopes is null, so the owner is told it reaches none of their content
    // and it is minted with no edge permissions at all.
    const email = `mint-content-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const cookie = await signInAndCookie(email);
    const label = `content-only-${Math.random().toString(36).slice(2, 8)}`;

    const res = await mintThroughForm(cookie, label, [
      { scopes: "content:write" },
    ]);
    expect(res.status).toBe(200);

    // The row is the assertion: the form answers 200 with an error page
    // rather than a status, and the "pick at least one" guard is what the
    // drop leaves the request standing in front of.
    const rows = await ctx.storage.keys.list();
    expect(rows.some((k) => k.label === label)).toBe(false);
  });

  it("still mints on the type scopes the picker does emit", async () => {
    // A gate that refuses everyone is as wrong as one that refuses no one,
    // and the drop is one clause away from taking the ordinary case with it.
    const email = `mint-typed-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const cookie = await signInAndCookie(email);
    const label = `typed-${Math.random().toString(36).slice(2, 8)}`;

    const res = await mintThroughForm(cookie, label, [
      { scopes: "core.note:write" },
    ]);
    expect(res.status).toBe(200);

    const rows = await ctx.storage.keys.list();
    const stored = rows.find((k) => k.label === label);
    expect(stored).toBeDefined();
    expect(stored?.type_permissions).toEqual({ "core.note": "write" });
  });

  it("mints on the ticked type scopes alone when a content literal rides along", async () => {
    // The drop takes the literal, not the request. A post naming both leaves
    // a key scoped to what the picker could actually have offered — which is
    // the difference between dropping a scope and refusing a submission.
    const email = `mint-mixed-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const cookie = await signInAndCookie(email);
    const label = `mixed-${Math.random().toString(36).slice(2, 8)}`;

    const res = await mintThroughForm(cookie, label, [
      { scopes: "core.note:read" },
      { scopes: "content:write" },
    ]);
    expect(res.status).toBe(200);

    const rows = await ctx.storage.keys.list();
    const stored = rows.find((k) => k.label === label);
    expect(stored).toBeDefined();
    // No global wildcard, and no `none` entries: the projection the category
    // would have produced left no trace on the row.
    expect(stored?.type_permissions).toEqual({ "core.note": "read" });
  });
});
