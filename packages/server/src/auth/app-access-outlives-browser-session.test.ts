/**
 * Ending a browser session ends that browser and nothing an app holds.
 *
 * The provider persists the browser session's id on the access and refresh
 * rows it issues, and every door that ends a session sweeps the rows bound to
 * it. An app is not the browser that approved it, and an app with no refresh
 * grant would have no way back in, so Marfa stores the rows without that
 * binding and no door that ends a session reaches an app.
 *
 * **Every door is driven, not one.** The sweep is the provider's own, run
 * from a hook on session deletion, and each door reaches deletion by its own
 * route: sign-out, the three revocations, a password change and the lookup of
 * an expired session. Disabling one hook would leave the others. The
 * provider's end-session verifies its hint by fetching the instance's own
 * keys over HTTP, which a test app cannot do, so the conformance fixture
 * drives that door.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  createTestContext,
  createTestAccount,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

vi.setConfig({ testTimeout: 60_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";
const CALLBACK = "http://localhost:0/callback";
const PASSWORD = "correct horse battery";

async function seedClient(c: TestContext, name: string): Promise<string> {
  const clientId = `client_${randomBytes(5).toString("hex")}`;
  const oauth = c.storage.oauthProvider;
  if (!oauth) throw new Error("storage.oauthProvider missing");
  await oauth.createClient({
    clientId,
    name,
    isPublic: true,
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    scopes: null,
    redirectUris: [CALLBACK],
    postLogoutRedirectUris: [ORIGIN + "/"],
  });
  return clientId;
}

async function signIn(c: TestContext, email: string): Promise<string> {
  const res = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password: PASSWORD },
    headers: { origin: ORIGIN },
  });
  if (res.status !== 200)
    throw new Error(`sign-in failed (${String(res.status)})`);
  for (const part of (res.headers.get("set-cookie") ?? "").split(
    /,\s*(?=[a-zA-Z0-9_-]+=)/,
  )) {
    const head = part.split(";")[0];
    if (head?.includes("session_token")) return head;
  }
  throw new Error("sign-in: session_token cookie not found");
}

/** The raw session token inside a signed cookie, which the revocation door takes. */
function rawToken(cookie: string): string {
  const value = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
  return value.slice(0, value.lastIndexOf("."));
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

/** Authorize and accept at the consent screen, ending on the code's exchange form. */
async function approve(
  c: TestContext,
  clientId: string,
  cookie: string,
  scope: string,
) {
  const { verifier, challenge } = pkce();
  const authorize = await request(
    c.app,
    "GET",
    `/auth/oauth2/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      state: "browser-session",
      scope,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString()}`,
    { headers: { cookie } },
  );
  const location = authorize.headers.get("location") ?? "";
  // A standing consent answers with a code at once.
  let landed = location;
  if (!location.startsWith(CALLBACK)) {
    if (!location.includes("/auth/authorize?"))
      throw new Error(`authorize did not reach consent: ${location}`);
    const decision = await request(c.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: location.slice(location.indexOf("?") + 1),
        scopes: scope.split(" ").filter(Boolean),
      },
      headers: { cookie, origin: ORIGIN },
    });
    landed = decision.headers.get("location") ?? "";
  }
  const code = new URL(landed, ORIGIN).searchParams.get("code");
  if (!code) throw new Error("no code on the callback redirect");
  return {
    grant_type: "authorization_code",
    code,
    redirect_uri: CALLBACK,
    client_id: clientId,
    code_verifier: verifier,
  };
}

interface Tokens {
  access_token: string;
  refresh_token?: string;
  scope?: string;
}

function exchange(c: TestContext, form: Record<string, string>) {
  return request(c.app, "POST", "/auth/oauth2/token", {
    form,
    headers: { origin: ORIGIN },
  });
}

async function connect(
  c: TestContext,
  clientId: string,
  cookie: string,
  scope: string,
): Promise<Tokens> {
  const res = await exchange(c, await approve(c, clientId, cookie, scope));
  expect(res.status).toBe(200);
  return (await res.json()) as Tokens;
}

async function dataStatus(c: TestContext, accessToken: string) {
  const res = await request(c.app, "GET", "/items?type=core.note", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  await res.body?.cancel();
  return res.status;
}

async function refresh(c: TestContext, clientId: string, token: string) {
  const res = await exchange(c, {
    grant_type: "refresh_token",
    refresh_token: token,
    client_id: clientId,
  });
  return {
    status: res.status,
    body: (await res.json()) as Tokens & { error?: string },
  };
}

async function browserSessionLive(c: TestContext, cookie: string) {
  const res = await request(c.app, "GET", "/auth/get-session", {
    headers: { cookie },
  });
  return (await res.json()) !== null;
}

async function consentRows(c: TestContext, clientId: string) {
  const schema = await import("../storage/sqlite/schema.js");
  const { eq } = await import("drizzle-orm");
  const db = c.storage.betterAuthDb as {
    select: () => {
      from: (t: unknown) => { where: (w: unknown) => Promise<unknown[]> };
    };
  };
  return (
    await db
      .select()
      .from(schema.auth_oauth_consent)
      .where(eq(schema.auth_oauth_consent.clientId, clientId))
  ).length;
}

async function expireSession(c: TestContext, cookie: string) {
  const schema = await import("../storage/sqlite/schema.js");
  const { eq } = await import("drizzle-orm");
  const db = c.storage.betterAuthDb as {
    update: (t: unknown) => {
      set: (v: Record<string, unknown>) => {
        where: (w: unknown) => Promise<unknown>;
      };
    };
  };
  await db
    .update(schema.auth_session)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(schema.auth_session.token, rawToken(cookie)));
}

interface Doors {
  /** The browser that authorized the apps. */
  a: string;
  /** Another browser of the same person. */
  b: string;
}

/** Each door of this table ends session `a`; `survivor` is whether `b` lives on. */
const DOORS: {
  name: string;
  survivor: boolean;
  run: (c: TestContext, d: Doors) => Promise<void>;
}[] = [
  {
    name: "browser sign-out",
    survivor: true,
    run: async (c, d) => {
      const res = await request(c.app, "POST", "/auth/sign-out", {
        headers: { cookie: d.a, origin: ORIGIN },
        body: {},
      });
      expect(res.status).toBe(200);
    },
  },
  {
    name: "ending one session",
    survivor: true,
    run: async (c, d) => {
      const res = await request(c.app, "POST", "/auth/revoke-session", {
        headers: { cookie: d.b, origin: ORIGIN },
        body: { token: rawToken(d.a) },
      });
      expect(res.status).toBe(200);
    },
  },
  {
    name: "ending the other sessions",
    survivor: true,
    run: async (c, d) => {
      const res = await request(c.app, "POST", "/auth/revoke-other-sessions", {
        headers: { cookie: d.b, origin: ORIGIN },
        body: {},
      });
      expect(res.status).toBe(200);
    },
  },
  {
    name: "ending every session",
    survivor: false,
    run: async (c, d) => {
      const res = await request(c.app, "POST", "/auth/revoke-sessions", {
        headers: { cookie: d.b, origin: ORIGIN },
        body: {},
      });
      expect(res.status).toBe(200);
    },
  },
  {
    name: "changing the password",
    // The door replaces the session that asked with a new one.
    survivor: false,
    run: async (c, d) => {
      const res = await request(c.app, "POST", "/auth/change-password", {
        headers: { cookie: d.b, origin: ORIGIN },
        body: {
          currentPassword: PASSWORD,
          newPassword: "a different horse battery",
          revokeOtherSessions: true,
        },
      });
      expect(res.status).toBe(200);
    },
  },
  {
    name: "a session's expiry",
    survivor: true,
    run: async (c, d) => {
      await expireSession(c, d.a);
      // The lookup of an expired session is what deletes it.
      await request(c.app, "GET", "/auth/get-session", {
        headers: { cookie: d.a },
      });
    },
  },
];

describe("an app stays connected when a browser session ends", () => {
  it.each(DOORS)(
    "$name ends the browser and leaves the apps' access, refresh and consent",
    async ({ run, survivor }) => {
      ctx = await createTestContext({});
      const c = ctx;
      const email = "browser-sessions@example.com";
      await createTestAccount(c, email, PASSWORD, "Browser Sessions");
      const a = await signIn(c, email);
      const b = await signIn(c, email);
      const refreshing = await seedClient(c, "Refreshing App");
      const accessOnly = await seedClient(c, "Access Only App");
      const withRefresh = await connect(
        c,
        refreshing,
        a,
        "core.note:read offline_access",
      );
      const withoutRefresh = await connect(c, accessOnly, a, "core.note:read");
      expect(withRefresh.refresh_token).toBeTruthy();
      expect(withoutRefresh.refresh_token).toBeUndefined();
      expect(await dataStatus(c, withRefresh.access_token)).toBe(200);
      expect(await dataStatus(c, withoutRefresh.access_token)).toBe(200);

      await run(c, { a, b });

      // The door did end the browser, and only the browsers it names.
      expect(await browserSessionLive(c, a)).toBe(false);
      expect(await browserSessionLive(c, b)).toBe(survivor);

      expect(await dataStatus(c, withRefresh.access_token)).toBe(200);
      expect(await dataStatus(c, withoutRefresh.access_token)).toBe(200);
      const renewed = await refresh(c, refreshing, withRefresh.refresh_token!);
      expect(renewed.status).toBe(200);
      expect(await dataStatus(c, renewed.body.access_token)).toBe(200);
      expect(await consentRows(c, refreshing)).toBe(1);
      expect(await consentRows(c, accessOnly)).toBe(1);
    },
  );

  it("still refuses an authorization code once its browser has ended, and accepts one whose browser lives", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const email = "browser-code@example.com";
    await createTestAccount(c, email, PASSWORD, "Browser Code");
    const a = await signIn(c, email);
    const clientId = await seedClient(c, "Code App");
    const live = await approve(c, clientId, a, "core.note:read");
    const orphaned = await approve(c, clientId, a, "core.note:read");

    // The witness: a code whose browser is live is exchanged.
    expect((await exchange(c, live)).status).toBe(200);

    await request(c.app, "POST", "/auth/sign-out", {
      headers: { cookie: a, origin: ORIGIN },
      body: {},
    });

    const refused = await exchange(c, orphaned);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "invalid_request",
    );
  });

  it("advertises no back-channel logout, since no app is notified of a browser ending", async () => {
    ctx = await createTestContext({});
    for (const path of [
      "/auth/.well-known/openid-configuration",
      "/auth/.well-known/oauth-authorization-server",
    ]) {
      const res = await request(ctx.app, "GET", path);
      expect(res.status).toBe(200);
      const document = (await res.json()) as Record<string, unknown>;
      expect(document.backchannel_logout_supported).toBe(false);
      expect(document.backchannel_logout_session_supported).toBe(false);
    }
  });

  it("registers a client without a back-channel logout address and does not echo one", async () => {
    ctx = await createTestContext({});
    const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: {
        client_name: "Logout Address App",
        application_type: "native",
        redirect_uris: [CALLBACK],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        backchannel_logout_uri: "https://app.example/logout",
        backchannel_logout_session_required: true,
      },
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(201);
    const answer = (await res.json()) as Record<string, unknown>;
    expect(answer.client_id).toBeTruthy();
    expect(answer).not.toHaveProperty("backchannel_logout_uri");
    expect(answer).not.toHaveProperty("backchannel_logout_session_required");
    const schema = await import("../storage/sqlite/schema.js");
    const { eq } = await import("drizzle-orm");
    const db = ctx.storage.betterAuthDb as {
      select: () => {
        from: (t: unknown) => {
          where: (w: unknown) => Promise<Record<string, unknown>[]>;
        };
      };
    };
    const rows = await db
      .select()
      .from(schema.auth_oauth_client)
      .where(eq(schema.auth_oauth_client.clientId, answer.client_id as string));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.backchannelLogoutUri ?? null).toBeNull();
  });
});
