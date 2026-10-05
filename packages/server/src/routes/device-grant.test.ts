/**
 * The device authorization grant, end to end, through the provider's own
 * device plugin.
 *
 * The plugin owns the codes, the approval state machine and the exchange;
 * Marfa fronts the pages a person meets and calls the plugin in-process, so
 * the consent screen, its per-scope toggles, the grant projection, the
 * consent row and the audit row stay Marfa's. The cases drive the real
 * flow: a client registered through the plugin's own registration
 * initiates, a signed-in person approves on Marfa's consent screen, the
 * device polls the token endpoint and the bearer reaches the data plane; a
 * poll before the approval is `authorization_pending`; a denial answers the
 * poll with `access_denied` and leaves no grant; a refresh token is minted
 * only for a client registered for the refresh grant; unticking a scope narrows
 * the token and the grant to the ticked set; the verification form refuses
 * a code nobody issued and forwards a live one; a code one person claimed is
 * not another's to approve; a client without the grant cannot initiate; and
 * the discovery document advertises the grant and the initiation endpoint.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { DEVICE_CODE_GRANT_TYPE } from "@better-auth/oauth-provider";
import {
  createTestContext,
  createTestAccount,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

// Every case boots a server, registers a client, signs a person up and in
// and drives a device flow before it asserts anything.
vi.setConfig({ testTimeout: 45_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

interface DeviceInit {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
}

/** Register a public native client through the plugin's own registration
 *  endpoint, asking for the grants named. Native, because a device is one
 *  and because the plugin admits a loopback http redirect only for one. */
async function registerClient(
  c: TestContext,
  grantTypes: string[],
): Promise<string> {
  const res = await request(c.app, "POST", "/auth/oauth2/register", {
    body: {
      client_name: "Device Test App",
      application_type: "native",
      grant_types: grantTypes,
      token_endpoint_auth_method: "none",
      redirect_uris: [`${ORIGIN}/callback`],
      response_types: grantTypes.includes("authorization_code") ? ["code"] : [],
    },
    headers: { origin: ORIGIN },
  });
  if (res.status !== 201) {
    throw new Error(
      `registration failed (${String(res.status)}): ${await res.text()}`,
    );
  }
  return ((await res.json()) as { client_id: string }).client_id;
}

async function signInUser(c: TestContext, email: string): Promise<string> {
  const password = "correct horse battery";
  await createTestAccount(c, email, password, "Device Test User");
  const signInRes = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  if (signInRes.status !== 200) {
    throw new Error(`sign-in failed (${String(signInRes.status)})`);
  }
  const setCookie = signInRes.headers.get("set-cookie");
  if (!setCookie) throw new Error("sign-in: no Set-Cookie header");
  const match = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(setCookie);
  if (!match?.[1]) throw new Error("sign-in: session_token cookie not found");
  return match[1];
}

/** RFC 8628 §3.1: the device asks, and gets a pair of codes back. */
async function initiate(
  c: TestContext,
  clientId: string,
  scope: string,
): Promise<DeviceInit> {
  const res = await request(c.app, "POST", "/auth/device/code", {
    form: { client_id: clientId, scope },
    headers: { origin: ORIGIN },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as DeviceInit;
}

/** The person opens the consent screen, which is what claims the code for
 *  them; then they submit a decision. */
async function openConsent(
  c: TestContext,
  userCode: string,
  cookie: string,
): Promise<Response> {
  return request(
    c.app,
    "GET",
    `/auth/device/consent?user_code=${encodeURIComponent(userCode)}`,
    { headers: { cookie } },
  );
}

async function decide(
  c: TestContext,
  userCode: string,
  cookie: string,
  decision: "approve" | "deny",
  scopes: string[],
): Promise<Response> {
  return request(c.app, "POST", "/auth/device/consent", {
    form: { user_code: userCode, decision, scopes },
    headers: { origin: ORIGIN, cookie },
  });
}

/** RFC 8628 §3.4: the device polls the token endpoint with its code. */
async function poll(
  c: TestContext,
  deviceCode: string,
  clientId: string,
): Promise<{ status: number; body: TokenBody }> {
  const res = await request(c.app, "POST", "/auth/oauth2/token", {
    form: {
      grant_type: DEVICE_CODE_GRANT_TYPE,
      device_code: deviceCode,
      client_id: clientId,
    },
    headers: { origin: ORIGIN },
  });
  return { status: res.status, body: (await res.json()) as TokenBody };
}

/** The plugin holds a poller to its interval, and a poll stamps the row.
 *  Clear the stamp so a second poll in the same case is answered on the
 *  code's state rather than with `slow_down`. */
async function allowRepoll(c: TestContext, deviceCode: string): Promise<void> {
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
    .update(schema.auth_oauth_device_code)
    .set({ lastPolledAt: null })
    .where(eq(schema.auth_oauth_device_code.deviceCode, deviceCode));
}

async function grants(c: TestContext) {
  const items = await c.storage.items.list({ type: "system.connection" });
  return items.data.filter((i) => i.properties.kind === "app");
}

describe("the device authorization grant through the provider plugin", () => {
  it("registers a device client, approves on the consent screen, polls a token and reaches the data plane", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await registerClient(c, [DEVICE_CODE_GRANT_TYPE]);

    const init = await initiate(c, clientId, "core.note:read");
    expect(init.device_code).toBeTruthy();
    expect(init.user_code).toMatch(/^[A-Z0-9]{8}$/);
    // The verification URI is Marfa's page, resolved against the issuer, and
    // the complete form carries the code so a device can render a link.
    expect(init.verification_uri).toMatch(/\/auth\/device$/);
    expect(init.verification_uri_complete).toBe(
      `${init.verification_uri}?user_code=${init.user_code}`,
    );
    expect(init.expires_in).toBe(600);
    expect(init.interval).toBe(5);

    // Nobody has decided yet.
    const early = await poll(c, init.device_code, clientId);
    expect(early.status).toBe(400);
    expect(early.body.error).toBe("authorization_pending");

    const cookie = await signInUser(c, "device-approve@example.com");
    const screen = await openConsent(c, init.user_code, cookie);
    expect(screen.status).toBe(200);
    const html = await screen.text();
    expect(html).toContain("Device Test App");
    expect(html).toContain("core.note:read");
    expect(html).toContain('<form method="POST" action="/auth/device/consent"');

    const approved = await decide(c, init.user_code, cookie, "approve", [
      "core.note:read",
    ]);
    expect(approved.status).toBe(200);

    await allowRepoll(c, init.device_code);
    const minted = await poll(c, init.device_code, clientId);
    expect(minted.status).toBe(200);
    expect(minted.body.access_token).toBeTruthy();
    expect(minted.body.token_type?.toLowerCase()).toBe("bearer");
    expect(minted.body.scope).toBe("core.note:read");
    // No `offline_access`, no refresh token.
    expect(minted.body.refresh_token).toBeUndefined();

    // A code is spent by its one exchange.
    await allowRepoll(c, init.device_code);
    const again = await poll(c, init.device_code, clientId);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("invalid_grant");

    const data = await request(c.app, "GET", "/items?type=core.note", {
      headers: { authorization: `Bearer ${minted.body.access_token ?? ""}` },
    });
    expect(data.status).toBe(200);

    // Marfa's half of the grant: the projection, with the device as its
    // source, and the audit row saying who approved what.
    const projected = await grants(c);
    expect(projected).toHaveLength(1);
    expect(projected[0]!.properties.client_id).toBe(clientId);
    expect(projected[0]!.properties.status).toBe("active");
    expect(projected[0]!.properties.scopes).toEqual(["core.note:read"]);
    expect(projected[0]!.source).toBe("marfa/oauth/device");
    const audits = await c.storage.audit.list({
      action: "auth.grant.created",
      limit: 10,
    });
    expect(audits.data.length >= 1).toBe(true);
    expect(audits.data[0]!.resource_id).toBe(clientId);
    expect(audits.data[0]!.details.source).toBe("device");
    expect(audits.data[0]!.details.approved_scopes).toEqual(["core.note:read"]);
  });

  it("a client registered for the refresh grant is minted a refresh token on offline_access, and one that is not is not", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const cookie = await signInUser(c, "device-refresh@example.com");
    const scope = "core.note:read offline_access";

    const withRefresh = await registerClient(c, [
      DEVICE_CODE_GRANT_TYPE,
      "refresh_token",
    ]);
    const first = await initiate(c, withRefresh, scope);
    expect((await openConsent(c, first.user_code, cookie)).status).toBe(200);
    expect(
      (
        await decide(c, first.user_code, cookie, "approve", [
          "core.note:read",
          "offline_access",
        ])
      ).status,
    ).toBe(200);
    const minted = await poll(c, first.device_code, withRefresh);
    expect(minted.status).toBe(200);
    expect(minted.body.refresh_token).toBeTruthy();

    // The refresh token works, and at the same endpoint.
    const refreshed = await request(c.app, "POST", "/auth/oauth2/token", {
      form: {
        grant_type: "refresh_token",
        refresh_token: minted.body.refresh_token!,
        client_id: withRefresh,
      },
      headers: { origin: ORIGIN },
    });
    expect(refreshed.status).toBe(200);
    expect(((await refreshed.json()) as TokenBody).access_token).toBeTruthy();

    // Without the grant, `offline_access` is approved and honored for the
    // session scopes alone: the access token comes, the refresh token does
    // not.
    const deviceOnly = await registerClient(c, [DEVICE_CODE_GRANT_TYPE]);
    const second = await initiate(c, deviceOnly, scope);
    expect((await openConsent(c, second.user_code, cookie)).status).toBe(200);
    expect(
      (
        await decide(c, second.user_code, cookie, "approve", [
          "core.note:read",
          "offline_access",
        ])
      ).status,
    ).toBe(200);
    const plain = await poll(c, second.device_code, deviceOnly);
    expect(plain.status).toBe(200);
    expect(plain.body.access_token).toBeTruthy();
    expect(plain.body.refresh_token).toBeUndefined();
  });

  it("names the types a wildcard covers today on the approval screen, as the authorize screen does", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await registerClient(c, [DEVICE_CODE_GRANT_TYPE]);
    await c.storage.types.create({
      id: "user.recipe",
      version: 1,
      label: "Recipes",
      fields: { title: { type: "string", required: true } },
    });
    const init = await initiate(c, clientId, "user.*:read");
    const cookie = await signInUser(c, "device-wildcard@example.com");

    const screen = await openConsent(c, init.user_code, cookie);
    expect(screen.status).toBe(200);
    const html = await screen.text();
    // The line the authorize screen prints for the same grant, from the same
    // function: the enumeration reaches this page through the route.
    expect(html).toContain('value="user.*:read"');
    expect(html).toContain("Today this covers Recipes");
    expect(html).toContain("plus any you add later");
  });

  it("warns on the approval screen that Marfa has not verified an app that registered itself", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await registerClient(c, [DEVICE_CODE_GRANT_TYPE]);
    const init = await initiate(c, clientId, "core.note:read");
    const cookie = await signInUser(c, "device-unverified@example.com");

    const screen = await openConsent(c, init.user_code, cookie);
    expect(screen.status).toBe(200);
    const html = await screen.text();
    expect(html).toContain('class="callout"');
    expect(html).toContain("Marfa hasn't verified this app");
  });

  it("does not warn about an app that authenticates with a secret", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await registerClient(c, [DEVICE_CODE_GRANT_TYPE]);
    // Registration cannot produce a confidential client without a secret to
    // initiate with, so the row is made one after the code exists: the screen
    // reads the row, and the row is what says the app is vetted.
    const init = await initiate(c, clientId, "core.note:read");
    const schema = await import("./../storage/sqlite/schema.js");
    const { eq } = await import("drizzle-orm");
    const db = c.storage.betterAuthDb as {
      update: (t: unknown) => {
        set: (v: Record<string, unknown>) => {
          where: (w: unknown) => Promise<unknown>;
        };
      };
    };
    await db
      .update(schema.auth_oauth_client)
      .set({ public: false, tokenEndpointAuthMethod: "client_secret_basic" })
      .where(eq(schema.auth_oauth_client.clientId, clientId));
    // The witness that the absence below is a decision and not a screen that
    // never rendered: the same screen, for the same flow, rendered the
    // warning in the case above.
    const cookie = await signInUser(c, "device-vetted@example.com");
    const screen = await openConsent(c, init.user_code, cookie);
    expect(screen.status).toBe(200);
    const html = await screen.text();
    expect(html).toContain("Device Test App");
    expect(html).not.toContain('class="callout"');
    expect(html).not.toContain("Marfa hasn't verified");
  });

  it("a denial answers the poll with access_denied and leaves no grant", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await registerClient(c, [DEVICE_CODE_GRANT_TYPE]);
    const init = await initiate(c, clientId, "core.note:read");
    const cookie = await signInUser(c, "device-deny@example.com");
    expect((await openConsent(c, init.user_code, cookie)).status).toBe(200);

    const denied = await decide(c, init.user_code, cookie, "deny", []);
    expect(denied.status).toBe(200);

    const res = await poll(c, init.device_code, clientId);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("access_denied");
    expect(res.body.access_token).toBeUndefined();
    expect(await grants(c)).toHaveLength(0);
  });

  it("unticking a scope narrows the token and the grant to the ticked set", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await registerClient(c, [DEVICE_CODE_GRANT_TYPE]);
    const init = await initiate(c, clientId, "core.note:read core.note:write");
    const cookie = await signInUser(c, "device-narrow@example.com");
    expect((await openConsent(c, init.user_code, cookie)).status).toBe(200);

    // Only the read ticked, and a scope the device never asked for, which
    // the intersection drops.
    const approved = await decide(c, init.user_code, cookie, "approve", [
      "core.note:read",
      "core.file:read",
    ]);
    expect(approved.status).toBe(200);

    const minted = await poll(c, init.device_code, clientId);
    expect(minted.status).toBe(200);
    expect(minted.body.scope).toBe("core.note:read");

    const write = await request(c.app, "POST", "/items", {
      headers: { authorization: `Bearer ${minted.body.access_token ?? ""}` },
      body: { type: "core.note", properties: { title: "no", body: "x" } },
    });
    expect(write.status).toBe(403);

    const projected = await grants(c);
    expect(projected).toHaveLength(1);
    expect(projected[0]!.properties.scopes).toEqual(["core.note:read"]);
  });

  it("the verification form refuses a code nobody issued and forwards a live one", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await registerClient(c, [DEVICE_CODE_GRANT_TYPE]);
    const init = await initiate(c, clientId, "core.note:read");

    const bogus = await request(c.app, "POST", "/auth/device", {
      form: { user_code: "ZZZZ-9999" },
      headers: { origin: ORIGIN },
    });
    expect(bogus.status).toBe(302);
    expect(bogus.headers.get("location")).toContain("error=invalid_code");

    // Typed with the hyphen and in lower case, the way a person does.
    const typed = `${init.user_code.slice(0, 4)}-${init.user_code.slice(4)}`;
    const live = await request(c.app, "POST", "/auth/device", {
      form: { user_code: typed.toLowerCase() },
      headers: { origin: ORIGIN },
    });
    expect(live.status).toBe(302);
    expect(live.headers.get("location")).toBe(
      `/auth/device/consent?user_code=${init.user_code}`,
    );

    // The form checked without claiming: the device is still told to wait,
    // not that somebody else owns the code.
    const res = await poll(c, init.device_code, clientId);
    expect(res.body.error).toBe("authorization_pending");
  });

  it("a code one person claimed is not another's to approve", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await registerClient(c, [DEVICE_CODE_GRANT_TYPE]);
    const init = await initiate(c, clientId, "core.note:read");
    const cookieA = await signInUser(c, "device-owner@example.com");
    const cookieB = await signInUser(c, "device-other@example.com");
    expect((await openConsent(c, init.user_code, cookieA)).status).toBe(200);

    const other = await openConsent(c, init.user_code, cookieB);
    expect(other.status).toBe(302);
    expect(other.headers.get("location")).toContain("error=another_account");
    const approved = await decide(c, init.user_code, cookieB, "approve", [
      "core.note:read",
    ]);
    expect(approved.status).toBe(302);
    expect(approved.headers.get("location")).toContain("error=another_account");

    const res = await poll(c, init.device_code, clientId);
    expect(res.body.error).toBe("authorization_pending");
    expect(await grants(c)).toHaveLength(0);
  });

  it("a client without the device grant cannot initiate, and an unknown client cannot either", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const browserOnly = await registerClient(c, ["authorization_code"]);
    const refused = await request(c.app, "POST", "/auth/device/code", {
      form: { client_id: browserOnly, scope: "core.note:read" },
      headers: { origin: ORIGIN },
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error?: string }).error).toBeTruthy();

    const unknown = await request(c.app, "POST", "/auth/device/code", {
      form: { client_id: "nobody", scope: "core.note:read" },
      headers: { origin: ORIGIN },
    });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error?: string }).error).toBe(
      "invalid_client",
    );
  });

  it("the discovery document advertises the grant and the initiation endpoint", async () => {
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
    expect(body.grant_types_supported).toContain(DEVICE_CODE_GRANT_TYPE);
    expect(body.device_authorization_endpoint).toMatch(/\/auth\/device\/code$/);
  });
});
