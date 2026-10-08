import { describe, it, expect, afterEach } from "vitest";
import { itemWrites } from "../storage/item-writes.js";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * Smoke tests for the better-auth handler mounted at /auth/*.
 *
 * Coverage:
 *   - sign-up is refused; accounts come from the programmatic seam
 *   - sign-in with email + password
 *   - session cookie is HttpOnly + Secure + SameSite=Lax + path=/auth
 *   - session cookie does NOT authenticate API calls (the data plane
 *     remains bearer-only — `/items` returns 401 with only the cookie)
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

// Better-auth performs an Origin / trustedOrigins check on every request.
// In-process tests don't supply a real Origin, so we set one matching the
// test config's authBaseUrl.
const ORIGIN = "http://localhost:0";

async function signIn(
  c: TestContext,
  email: string,
  password: string,
): Promise<Response> {
  return request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
}

describe("better-auth /auth/* surface", () => {
  it("rejects email + password sign-up", async () => {
    // There is no self-service sign-up on any instance; accounts come
    // from the programmatic seam.
    ctx = await createTestContext({});
    const res = await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "bob@example.com",
        password: "correct horse battery",
        name: "Bob",
      },
      headers: { origin: ORIGIN },
    });
    // better-auth returns 403 when sign-up is disabled.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("authenticates an existing user via sign-in/email", async () => {
    ctx = await createTestContext(
      {},
      { email: "carol@example.com", password: "correct horse battery" },
    );

    const res = await signIn(ctx, "carol@example.com", "correct horse battery");
    if (res.status !== 200) {
      // Surface body to diagnose if this regresses.
      const text = await res.text();
      throw new Error(
        `sign-in/email returned ${String(res.status)}: ${text.slice(0, 400)}`,
      );
    }
    const cookieHeader = res.headers.get("set-cookie");
    expect(cookieHeader).toBeTruthy();
    expect(cookieHeader).toMatch(/HttpOnly/i);
    expect(cookieHeader).toMatch(/SameSite=Lax/i);
    // Test config uses http://localhost:0 — Secure must be OFF on HTTP
    // baseURL or Chrome silently drops the cookie (regression guard).
    expect(cookieHeader).not.toMatch(/Secure/i);
  });

  it("session cookie includes Secure when baseURL is HTTPS", async () => {
    // Regression guard: under an HTTPS baseURL, the cookie attributes
    // MUST include Secure so the cookie isn't sent over HTTP.
    const HTTPS_ORIGIN = "https://example.test";
    ctx = await createTestContext(
      {
        authBaseUrl: HTTPS_ORIGIN,
      },
      {
        email: "secure-cookie-test@example.com",
        password: "correct horse battery",
        name: "Test",
      },
    );
    // Use the matching origin since baseURL drives trustedOrigins.

    const res = await request(ctx.app, "POST", "/auth/sign-in/email", {
      body: {
        email: "secure-cookie-test@example.com",
        password: "correct horse battery",
      },
      headers: { origin: HTTPS_ORIGIN },
    });
    if (res.status !== 200) {
      const text = await res.text();
      throw new Error(
        `sign-in/email returned ${String(res.status)}: ${text.slice(0, 400)}`,
      );
    }
    const cookieHeader = res.headers.get("set-cookie");
    expect(cookieHeader).toBeTruthy();
    expect(cookieHeader).toMatch(/Secure/i);
    expect(cookieHeader).toMatch(/HttpOnly/i);
    expect(cookieHeader).toMatch(/SameSite=Lax/i);
  });

  it("rejects a wrong password with 4xx", async () => {
    ctx = await createTestContext(
      {},
      { email: "dave@example.com", password: "correct horse battery" },
    );

    const res = await signIn(ctx, "dave@example.com", "wrong");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("session cookie does NOT authenticate /items — data plane stays bearer-only", async () => {
    ctx = await createTestContext(
      {},
      { email: "eve@example.com", password: "correct horse battery" },
    );

    const signInRes = await signIn(
      ctx,
      "eve@example.com",
      "correct horse battery",
    );
    const setCookie = signInRes.headers.get("set-cookie");
    // Send the cookie back without any Bearer token. /items should 401.
    const res = await request(ctx.app, "GET", "/items?type=core.note", {
      headers: setCookie ? { cookie: setCookie } : {},
    });
    expect(res.status).toBe(401);
  });

  it("returns the active session via /auth/get-session for a signed-in user", async () => {
    ctx = await createTestContext(
      {},
      { email: "frank@example.com", password: "correct horse battery" },
    );

    const signInRes = await signIn(
      ctx,
      "frank@example.com",
      "correct horse battery",
    );
    const setCookie = signInRes.headers.get("set-cookie");
    const cookie = setCookie?.split(";")[0];

    const res = await request(ctx.app, "GET", "/auth/get-session", {
      headers: cookie ? { cookie } : {},
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user?: { email?: string };
      session?: unknown;
    } | null;
    expect(body?.user?.email).toBe("frank@example.com");
  });

  it("/.well-known/oauth-authorization-server/auth returns the discovery doc", async () => {
    ctx = await createTestContext({});
    const res = await request(
      ctx.app,
      "GET",
      "/.well-known/oauth-authorization-server/auth",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      issuer?: string;
      authorization_endpoint?: string;
      token_endpoint?: string;
      code_challenge_methods_supported?: string[];
    };
    expect(body.issuer).toBeTruthy();
    // Endpoints live under the @better-auth/oauth-provider plugin's
    // basePath (/auth/oauth2/*). RPs reading the discovery doc follow
    // the issued URLs.
    expect(body.authorization_endpoint).toMatch(/\/auth\/oauth2\/authorize$/);
    expect(body.token_endpoint).toMatch(/\/auth\/oauth2\/token$/);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("discovery doc advertises none for revocation and not for introspection", async () => {
    // Every client this server issues is public and revokes with its
    // `client_id` alone, which the revocation endpoint admits. Introspection
    // requires a secret in the plugin, so it keeps the confidential methods
    // alone and a public client reading the document is not told it can
    // call it.
    ctx = await createTestContext({});
    const res = await request(
      ctx.app,
      "GET",
      "/.well-known/oauth-authorization-server/auth",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      revocation_endpoint_auth_methods_supported?: string[];
      introspection_endpoint_auth_methods_supported?: string[];
    };
    expect(body.revocation_endpoint_auth_methods_supported).toContain("none");
    expect(body.introspection_endpoint_auth_methods_supported).not.toContain(
      "none",
    );
  });

  it("discovery doc advertises the device_code grant + device_authorization_endpoint", async () => {
    // RFC 8628 §4: clients discover the device-flow initiation endpoint
    // via the `device_authorization_endpoint` metadata field. The grant
    // type URN appears in `grant_types_supported` so conformant clients
    // know they can request device-code authorization at all.
    ctx = await createTestContext({});
    const res = await request(
      ctx.app,
      "GET",
      "/.well-known/oauth-authorization-server/auth",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      grant_types_supported?: string[];
      device_authorization_endpoint?: string;
    };
    expect(body.grant_types_supported).toContain(
      "urn:ietf:params:oauth:grant-type:device_code",
    );
    // The other grants this server issues stay advertised, and the one it
    // does not have is absent rather than filtered out on the way past: the
    // plugin is configured with the grants this server has, so
    // `grant_types_supported` is that list plus the URN the augmentation
    // appends. A client reading the document has to be able to pick a grant
    // that works.
    expect(body.grant_types_supported).toEqual(
      expect.arrayContaining([
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:device_code",
      ]),
    );
    expect(body.grant_types_supported).not.toContain("client_credentials");
    expect(body.device_authorization_endpoint).toMatch(/\/auth\/device\/code$/);
  });

  it("openid-configuration also advertises the device_code grant", async () => {
    ctx = await createTestContext({});
    const res = await request(
      ctx.app,
      "GET",
      "/.well-known/openid-configuration/auth",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      grant_types_supported?: string[];
      device_authorization_endpoint?: string;
    };
    expect(body.grant_types_supported).toContain(
      "urn:ietf:params:oauth:grant-type:device_code",
    );
    expect(body.device_authorization_endpoint).toMatch(/\/auth\/device\/code$/);
  });

  it("every discovery-doc URL field is prefixed with the configured authBaseUrl", async () => {
    const base = "https://example.test";
    ctx = await createTestContext({
      authBaseUrl: base,
    });
    const res = await request(
      ctx.app,
      "GET",
      "/.well-known/oauth-authorization-server/auth",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // The @better-auth/oauth-provider plugin sets the issuer to
    // `${authBaseUrl}/auth` (basePath included), and this document came
    // back from `/.well-known/oauth-authorization-server/auth` — the
    // RFC 8414 §3.1 URL for exactly that issuer, formed by inserting the
    // well-known segment between the host and the issuer's path. The two
    // identifiers therefore agree, and §3.3 — the document's `issuer`
    // must equal the issuer whose metadata was requested — passes on the
    // strings themselves rather than on a client being lenient. That
    // check is the one guard stopping a metadata document from pointing
    // a client at somebody else's token endpoint, so it is the reading
    // to satisfy, not to work around.
    expect(body.issuer).toBe(`${base}/auth`);

    // Every absolute-URL field starts with the configured base. If the
    // deployment is missing MARFA_AUTH_BASE_URL the server falls back to
    // `http://localhost:<port>`, which the host header then rewrites to
    // the internal hostname. Asserting the prefix here catches that
    // regression.
    const urlFields = [
      "authorization_endpoint",
      "token_endpoint",
      "registration_endpoint",
      "userinfo_endpoint",
    ];
    for (const field of urlFields) {
      const value = body[field];
      expect(typeof value).toBe("string");
      expect(value as string).toMatch(new RegExp(`^${base}/`));
    }
  });

  it("every derivable discovery URL serves the same augmented document", async () => {
    // Three of these are registered because a client derives them; the fourth,
    // `/auth/.well-known/oauth-authorization-server`, is registered because the
    // Better Auth plugin answers it from inside its own mount if we do not.
    // That plugin document is not the same one — it carries no device-code
    // grant, no `device_authorization_endpoint` and no permission bundles —
    // and its issuer matches the URL, so a client checking RFC 8414 §3.3 finds
    // nothing wrong. A device-flow client discovering there concludes the
    // server has no device flow. Asserting a 200 would not catch that; the
    // augmentation is the whole point, so the augmentation is what is asserted.
    ctx = await createTestContext({});
    for (const path of [
      "/.well-known/oauth-authorization-server/auth",
      "/.well-known/openid-configuration/auth",
      "/auth/.well-known/openid-configuration",
      "/auth/.well-known/oauth-authorization-server",
    ]) {
      const res = await request(ctx.app, "GET", path);
      expect(res.status, `${path} must be served`).toBe(200);
      const body = (await res.json()) as {
        issuer?: string;
        grant_types_supported?: string[];
        device_authorization_endpoint?: string;
        marfa_permission_bundles?: unknown;
      };
      expect(body.issuer, `${path} issuer`).toMatch(/\/auth$/);
      expect(body.grant_types_supported, `${path} device-code grant`).toContain(
        "urn:ietf:params:oauth:grant-type:device_code",
      );
      expect(
        body.device_authorization_endpoint,
        `${path} device endpoint`,
      ).toMatch(/\/auth\/device\/code$/);
      expect(
        body.marfa_permission_bundles,
        `${path} permission bundles`,
      ).toBeDefined();
    }
  });

  it("the bare-root discovery paths 404, and that 404 is the product", async () => {
    // These two paths are deliberately unregistered. Per RFC 8414 §3 they
    // belong to an issuer of `<authBaseUrl>` with no path component, and
    // this server's issuer is `<authBaseUrl>/auth` — so a document served
    // here answered a question nobody had asked. Its `issuer` could not
    // match the issuer the client was discovering against, the client
    // failed the §3.3 identity check, and what it reported was a
    // malformed metadata document: a server-shaped error for a client
    // holding the wrong issuer. The 404 is the better answer because it
    // names its own cause — there is no authorization server at that
    // identifier, and the three spec-formed URLs above say where one is.
    ctx = await createTestContext({});
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
    ]) {
      const res = await request(ctx.app, "GET", path);
      expect(res.status, `${path} must not be served`).toBe(404);
    }
  });

  it("/auth/grants returns app connections, /auth/grants/{id} revokes", async () => {
    ctx = await createTestContext({});

    // OAuth clients live in `auth_oauth_client` (owned by the
    // @better-auth/oauth-provider plugin). The /auth/grants endpoint
    // reads system.connection items directly — for this test we create
    // the projection row with a fake client_id string. The /grants
    // listing doesn't validate against the client table.
    const fakeClientId = `client_${Math.random().toString(36).slice(2, 8)}`;
    const grant = await itemWrites(ctx.storage).create({
      type: "system.connection",
      state: "active",
      tier: "library",
      properties: {
        kind: "app",
        client_id: fakeClientId,
        scopes: ["core.note:read"],
        status: "active",
        granted_at: new Date().toISOString(),
      },
      source: "test/oauth",
    });

    const listRes = await request(ctx.app, "GET", "/auth/grants", {
      key: ctx.workingKey,
    });
    expect(listRes.status).toBe(200);
    const list = (
      (await listRes.json()) as {
        data: {
          id: string;
          client_id: string;
          scopes: string[];
          status: string;
        }[];
      }
    ).data;
    expect(list.some((g) => g.id === grant.id)).toBe(true);
    const found = list.find((g) => g.id === grant.id);
    expect(found?.client_id).toBe(fakeClientId);
    expect(found?.scopes).toEqual(["core.note:read"]);
    expect(found?.status).toBe("active");

    // Revoke (cascade-revoke through plugin tables is a no-op here since
    // we never minted a real token for the fake client).
    const revokeRes = await request(
      ctx.app,
      "DELETE",
      `/auth/grants/${grant.id}`,
      { key: ctx.workingKey },
    );
    expect(revokeRes.status).toBe(204);

    // Confirm it's gone from the active list
    const list2Res = await request(ctx.app, "GET", "/auth/grants", {
      key: ctx.workingKey,
    });
    const list2 = ((await list2Res.json()) as { data: { id: string }[] }).data;
    expect(list2.some((g) => g.id === grant.id)).toBe(false);
  });

  // "/auth/clients" is gone — the plugin owns client registration at
  // /auth/oauth2/register.
});
