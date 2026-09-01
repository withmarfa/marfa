import { describe, it, expect, afterEach } from "vitest";
import {
  authUserExists,
  createTestContext,
  markEmailVerified,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * Smoke tests for the better-auth integration mounted at /auth/*.
 *
 * Coverage:
 *   - sign-up enabled vs disabled gating (MARFA_AUTH_ALLOW_SIGNUP)
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

async function signUp(
  c: TestContext,
  email: string,
  password: string,
  name = "Test User",
): Promise<Response> {
  return request(c.app, "POST", "/auth/sign-up/email", {
    body: { email, password, name },
    headers: { origin: ORIGIN },
  });
}

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

const MAGIC_CALLBACK = "http://localhost:0/callback";

async function requestMagicLink(
  c: TestContext,
  email: string,
): Promise<Response> {
  return request(c.app, "POST", "/auth/sign-in/magic-link", {
    body: { email, callbackURL: MAGIC_CALLBACK },
    headers: { origin: ORIGIN },
  });
}

async function followMagicLink(
  c: TestContext,
  token: string,
): Promise<Response> {
  return request(
    c.app,
    "GET",
    `/auth/magic-link/verify?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent(MAGIC_CALLBACK)}`,
    { headers: { origin: ORIGIN } },
  );
}

/** A spy transport, so the test can read the token the email carried. */
function emailSpy(): {
  transport: import("../email/transport.js").EmailTransport;
  sent: import("../email/transport.js").EmailMessage[];
} {
  const sent: import("../email/transport.js").EmailMessage[] = [];
  return {
    sent,
    transport: {
      backend: "none",
      send(message) {
        sent.push(message);
        return Promise.resolve({
          ok: true,
          messageId: `spy/${message.idempotencyKey}`,
        });
      },
    },
  };
}

/** `instance.ts` stamps the token onto the idempotency key as
 *  `magic-link/<token>`, which is the only place the test can reach it
 *  without parsing the rendered email body. */
function magicLinkToken(
  sent: import("../email/transport.js").EmailMessage[],
): string | undefined {
  const prefix = "magic-link/";
  const message = sent.find((m) => m.idempotencyKey.startsWith(prefix));
  return message?.idempotencyKey.slice(prefix.length);
}

describe("better-auth /auth/* surface", () => {
  it("allows email + password sign-up when MARFA_AUTH_ALLOW_SIGNUP=true", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const res = await signUp(ctx, "alice@example.com", "correct horse battery");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: { email?: string } };
    expect(body.user?.email).toBe("alice@example.com");
  });

  it("rejects email + password sign-up when MARFA_AUTH_ALLOW_SIGNUP=false", async () => {
    ctx = await createTestContext({ authAllowSignup: false });
    const res = await signUp(ctx, "bob@example.com", "correct horse battery");
    // better-auth returns 403 when sign-up is disabled.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  /**
   * `MARFA_AUTH_ALLOW_SIGNUP` is the one switch that decides whether a
   * stranger can create an account. The password path above has always
   * honored it. The magic-link path did not: better-auth creates the
   * user when none exists unless the plugin is told otherwise, so an
   * instance with sign-up deliberately closed still grew an account —
   * and, through the space-provisioning hook, a space — for any address
   * that asked for a link.
   *
   * The refusal lands at verify rather than at send. An unknown address
   * still receives a link and only the click fails. That is the
   * plugin's non-enumeration behavior and is deliberate: refusing the
   * send would tell a stranger which addresses hold accounts.
   */
  it("does not create an account via magic link when MARFA_AUTH_ALLOW_SIGNUP=false", async () => {
    const { transport, sent } = emailSpy();
    ctx = await createTestContext({ authAllowSignup: false }, transport);

    const res = await requestMagicLink(ctx, "stranger@example.com");
    // Not refused: the send is deliberately indistinguishable from one
    // for an address that does hold an account.
    expect(res.status).toBe(200);

    const token = magicLinkToken(sent);
    expect(token).toBeTruthy();

    const verify = await followMagicLink(ctx, token!);
    expect(verify.headers.get("location") ?? "").toContain(
      "new_user_signup_disabled",
    );
    await expect(
      authUserExists(ctx.storage, "stranger@example.com"),
    ).resolves.toBe(false);
  });

  it("creates an account via magic link when MARFA_AUTH_ALLOW_SIGNUP=true", async () => {
    const { transport, sent } = emailSpy();
    ctx = await createTestContext({ authAllowSignup: true }, transport);

    const res = await requestMagicLink(ctx, "newcomer@example.com");
    expect(res.status).toBe(200);

    const token = magicLinkToken(sent);
    expect(token).toBeTruthy();

    const verify = await followMagicLink(ctx, token!);
    expect(verify.headers.get("location") ?? "").not.toContain(
      "new_user_signup_disabled",
    );
    await expect(
      authUserExists(ctx.storage, "newcomer@example.com"),
    ).resolves.toBe(true);
  });

  it("authenticates an existing user via sign-in/email", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const signUpRes = await signUp(
      ctx,
      "carol@example.com",
      "correct horse battery",
    );
    if (signUpRes.status !== 200) {
      const text = await signUpRes.text();
      throw new Error(
        `sign-up/email returned ${String(signUpRes.status)}: ${text.slice(0, 600)}`,
      );
    }
    // requireEmailVerification blocks sign-in until the user clicks the
    // verify link. Stand-in for that here.
    await markEmailVerified(ctx.storage, "carol@example.com");

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
    ctx = await createTestContext({
      authAllowSignup: true,
      authBaseUrl: HTTPS_ORIGIN,
    });
    // Use the matching origin since baseURL drives trustedOrigins.
    const signUpRes = await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "secure-cookie-test@example.com",
        password: "correct horse battery",
        name: "Test",
      },
      headers: { origin: HTTPS_ORIGIN },
    });
    if (signUpRes.status !== 200) {
      const text = await signUpRes.text();
      throw new Error(
        `sign-up/email returned ${String(signUpRes.status)}: ${text.slice(0, 400)}`,
      );
    }
    await markEmailVerified(ctx.storage, "secure-cookie-test@example.com");
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
    ctx = await createTestContext({ authAllowSignup: true });
    await signUp(ctx, "dave@example.com", "correct horse battery");

    const res = await signIn(ctx, "dave@example.com", "wrong");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("session cookie does NOT authenticate /items — data plane stays bearer-only", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const signUpRes = await signUp(
      ctx,
      "eve@example.com",
      "correct horse battery",
    );
    const setCookie = signUpRes.headers.get("set-cookie");
    // Send the cookie back without any Bearer token. /items should 401.
    const res = await request(ctx.app, "GET", "/items?type=core.note", {
      headers: setCookie ? { cookie: setCookie } : {},
    });
    expect(res.status).toBe(401);
  });

  it("returns the active session via /auth/get-session for a signed-in user", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const signUpRes = await signUp(
      ctx,
      "frank@example.com",
      "correct horse battery",
    );
    if (signUpRes.status !== 200) {
      const text = await signUpRes.text();
      throw new Error(
        `sign-up/email returned ${String(signUpRes.status)}: ${text.slice(0, 400)}`,
      );
    }
    // requireEmailVerification means sign-up doesn't auto-sign-in; verify
    // explicitly so we have a session cookie to send back.
    await markEmailVerified(ctx.storage, "frank@example.com");
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

  it("magic-link request creates a verification token (default log transport)", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    // First sign up so the user exists.
    await signUp(ctx, "grace@example.com", "correct horse battery");
    const res = await request(ctx.app, "POST", "/auth/sign-in/magic-link", {
      body: {
        email: "grace@example.com",
        callbackURL: "http://localhost:0/callback",
      },
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: boolean };
    expect(body.status).toBe(true);
  });

  it("exposes passkey registration challenge under /auth/passkey/*", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    await signUp(ctx, "henry@example.com", "correct horse battery");
    await markEmailVerified(ctx.storage, "henry@example.com");
    const signInRes = await signIn(
      ctx,
      "henry@example.com",
      "correct horse battery",
    );
    const cookie = signInRes.headers.get("set-cookie")?.split(";")[0];

    // Generating a registration challenge is a GET requiring a fresh session.
    const res = await request(
      ctx.app,
      "GET",
      "/auth/passkey/generate-register-options",
      {
        headers: cookie ? { origin: ORIGIN, cookie } : { origin: ORIGIN },
      },
    );
    // Either a 200 with challenge or a 4xx — we just verify the route is
    // mounted (not a 404 falling through to a different handler).
    expect(res.status).not.toBe(404);
  });

  it("a reachable federated provider redirects to its authorize URL", async () => {
    // Discovery is the only network the provider needs at this point;
    // building the authorize URL is local. Answering it here exercises
    // the real path a browser takes, which asserting "not a 404" never
    // did — the endpoint this route dispatches to moved, and a route
    // pointing at a path that no longer exists still isn't a 404 to the
    // caller, it is a silent redirect back to the sign-in page.
    const realFetch = globalThis.fetch;
    const stub: typeof fetch = (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes("accounts.example.com")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              issuer: "https://accounts.example.com",
              authorization_endpoint: "https://accounts.example.com/authorize",
              token_endpoint: "https://accounts.example.com/token",
              userinfo_endpoint: "https://accounts.example.com/userinfo",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return realFetch(input, init);
    };
    globalThis.fetch = stub;

    try {
      ctx = await createTestContext({
        authAllowSignup: true,
        oidcProviders: [
          {
            providerId: "test-provider",
            clientId: "test-client",
            clientSecret: "test-secret",
            discoveryUrl:
              "https://accounts.example.com/.well-known/openid-configuration",
          },
        ],
      });

      const form = new URLSearchParams({ return_to: "/" });
      const res = await ctx.app.request(
        "/auth/sign-in/provider/test-provider",
        {
          method: "POST",
          headers: {
            origin: ORIGIN,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: form.toString(),
        },
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain(
        "https://accounts.example.com/authorize",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("an unreachable provider degrades itself, leaves the server up, and says so", async () => {
    // No fetch stub: the discovery URL does not resolve. Before
    // providers initialized one at a time, this rejection escaped plugin
    // init where no caller could reach it, and — since the auth instance
    // is built at boot and nothing installs an unhandledRejection
    // handler — terminated the process.
    ctx = await createTestContext({
      authAllowSignup: true,
      oidcProviders: [
        {
          providerId: "unreachable-provider",
          clientId: "test-client",
          clientSecret: "test-secret",
          discoveryUrl:
            "https://nothing-listens.invalid/.well-known/openid-configuration",
        },
      ],
    });

    // The sign-in route says why, rather than claiming the provider does
    // not exist or failing generically. Driven first because it
    // dispatches through the auth handler, which awaits the context Better
    // Auth builds asynchronously — after this, availability is settled
    // rather than still initializing.
    const res = await ctx.app.request(
      "/auth/sign-in/provider/unreachable-provider",
      {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ return_to: "/" }).toString(),
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("provider_unavailable");

    // The server is up and answering.
    const health = await request(ctx.app, "GET", "/health");
    expect(health.status).toBe(200);
    const body = (await health.json()) as {
      status: string;
      components: Record<
        string,
        {
          status: string;
          providers?: { provider_id: string; status: string }[];
        }
      >;
    };
    // Visible without reading container output.
    expect(body.status).toBe("degraded");
    expect(body.components.identity_providers?.status).toBe("degraded");
    expect(body.components.identity_providers?.providers).toContainEqual(
      expect.objectContaining({
        provider_id: "unreachable-provider",
        status: "unavailable",
      }),
    );

    // Every other way in is untouched.
    const signUp = await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "degraded@example.com",
        password: "correct horse battery",
        name: "Degraded",
      },
      headers: { origin: ORIGIN },
    });
    expect(signUp.status).toBe(200);
  });

  it("no federated providers configured means no identity component at all", async () => {
    ctx = await createTestContext({ authAllowSignup: true, oidcProviders: [] });
    const health = await request(ctx.app, "GET", "/health");
    const body = (await health.json()) as {
      status: string;
      components: Record<string, unknown>;
    };
    expect(body.status).toBe("ok");
    expect(body.components.identity_providers).toBeUndefined();
  });

  it("/.well-known/oauth-authorization-server/auth returns the discovery doc", async () => {
    ctx = await createTestContext({ authAllowSignup: false });
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

  it("discovery doc advertises the device_code grant + device_authorization_endpoint", async () => {
    // RFC 8628 §4: clients discover the device-flow initiation endpoint
    // via the `device_authorization_endpoint` metadata field. The grant
    // type URN appears in `grant_types_supported` so conformant clients
    // know they can request device-code authorization at all.
    ctx = await createTestContext({ authAllowSignup: false });
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
    // Other grants the plugin natively supports stay advertised — the
    // augmentation is strictly additive (insertion preserves the
    // upstream order before appending the URN).
    expect(body.grant_types_supported).toEqual(
      expect.arrayContaining([
        "authorization_code",
        "client_credentials",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:device_code",
      ]),
    );
    expect(body.device_authorization_endpoint).toMatch(/\/auth\/device$/);
  });

  it("openid-configuration also advertises the device_code grant", async () => {
    ctx = await createTestContext({ authAllowSignup: false });
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
    expect(body.device_authorization_endpoint).toMatch(/\/auth\/device$/);
  });

  it("every discovery-doc URL field is prefixed with the configured authBaseUrl", async () => {
    const base = "https://example.test";
    ctx = await createTestContext({
      authAllowSignup: false,
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
    ctx = await createTestContext({ authAllowSignup: false });
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
      ).toMatch(/\/auth\/device$/);
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
    ctx = await createTestContext({ authAllowSignup: false });
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
    ]) {
      const res = await request(ctx.app, "GET", path);
      expect(res.status, `${path} must not be served`).toBe(404);
    }
  });

  it("/auth/grants returns app connections, /auth/grants/{id} revokes", async () => {
    ctx = await createTestContext({ authAllowSignup: false });

    // OAuth clients live in `auth_oauth_client` (owned by the
    // @better-auth/oauth-provider plugin). The /auth/grants endpoint
    // reads system.connection items directly — for this test we create
    // the projection row with a fake client_id string. The /grants
    // listing doesn't validate against the client table.
    const fakeClientId = `client_${Math.random().toString(36).slice(2, 8)}`;
    const grant = await ctx.storage.items.create({
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
      key: ctx.adminKey,
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      id: string;
      client_id: string;
      scopes: string[];
      status: string;
    }[];
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
      { key: ctx.adminKey },
    );
    expect(revokeRes.status).toBe(204);

    // Confirm it's gone from the active list
    const list2Res = await request(ctx.app, "GET", "/auth/grants", {
      key: ctx.adminKey,
    });
    const list2 = (await list2Res.json()) as { id: string }[];
    expect(list2.some((g) => g.id === grant.id)).toBe(false);
  });

  // "/auth/clients" is gone — the plugin owns client registration at
  // /auth/oauth2/register.
});
