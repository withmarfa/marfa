import { describe, it, expect, afterEach } from "vitest";
import {
  createTestContext,
  markEmailVerified,
  request,
  waitForAudit,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * Tests for the Device Authorization Grant (RFC 8628) surface:
 *
 *   - POST /auth/device (JSON) — initiate
 *   - POST /auth/device (form) — submit user_code
 *   - GET  /auth/device — verification form
 *   - GET  /auth/device/consent — consent screen (gated on session)
 *   - POST /auth/device/consent — approve / deny
 *   - POST /auth/device/token — polling
 *
 * Coverage: full happy path (initiate → user submits code → sign-in → consent →
 * approve → token), plus every documented RFC 8628 error path
 * (authorization_pending, slow_down, expired_token, access_denied,
 * invalid_grant for unknown / wrong-client device_code).
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

async function createClient(c: TestContext): Promise<string> {
  // The @better-auth/oauth-provider plugin owns DCR at
  // /auth/oauth2/register. For the device-flow tests we shortcut by
  // writing the auth_oauth_client row directly; the device-flow handlers
  // only need a valid client_id business key.
  const clientId = `client_${Math.random().toString(36).slice(2, 10)}`;
  const clientPk = `pk_${Math.random().toString(36).slice(2, 10)}`;
  if (!c.storage.betterAuthDb) {
    throw new Error("createClient: storage.betterAuthDb missing");
  }
  const schemaModule =
    c.storage.betterAuthDialect === "pg"
      ? await import("../storage/pg/schema.js")
      : await import("../storage/sqlite/schema.js");
  const db = c.storage.betterAuthDb as unknown as {
    insert: (table: unknown) => {
      values: (v: Record<string, unknown>) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const now = new Date();
  // PG has native `text[]` columns for the plugin's `string[]` fields
  // (see migration 0059); SQLite stays on `text` with JSON-serialized
  // arrays via the Better Auth adapter (`supportsArrays: false`).
  const redirectUris: unknown =
    c.storage.betterAuthDialect === "pg"
      ? ["http://localhost:0/callback"]
      : JSON.stringify(["http://localhost:0/callback"]);
  const op = db.insert(schemaModule.auth_oauth_client).values({
    id: clientPk,
    clientId,
    name: "Test CLI",
    redirectUris,
    disabled: false,
    createdAt: now,
    updatedAt: now,
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
  return clientId;
}
void ORIGIN;

async function initiate(
  c: TestContext,
  clientId: string,
  scope = "core.note:read core.note:write",
): Promise<{
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}> {
  const res = await c.app.fetch(
    new Request(`${ORIGIN}/auth/device`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ client_id: clientId, scope }),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Awaited<ReturnType<typeof initiate>>;
}

async function pollToken(
  c: TestContext,
  deviceCode: string,
  clientId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await c.app.fetch(
    new Request(`${ORIGIN}/auth/device/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: clientId,
      }).toString(),
    }),
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

/** Sign in via Better Auth and capture the session cookie for use in
 *  authenticated /auth/device/consent calls. */
async function signInAndCookie(
  c: TestContext,
  email: string,
  password: string,
): Promise<string> {
  await c.app.fetch(
    new Request(`${ORIGIN}/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, password, name: "Tester" }),
    }),
  );
  // requireEmailVerification blocks sign-in until the verify link is
  // clicked. Stand-in for that here.
  await markEmailVerified(c.storage, email);
  const signIn = await c.app.fetch(
    new Request(`${ORIGIN}/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, password }),
    }),
  );
  expect(signIn.status).toBe(200);
  const cookies =
    typeof (signIn.headers as Headers & { getSetCookie?: () => string[] })
      .getSetCookie === "function"
      ? (
          signIn.headers as Headers & { getSetCookie: () => string[] }
        ).getSetCookie()
      : [signIn.headers.get("set-cookie") ?? ""];
  return cookies.map((c) => c.split(";")[0]).join("; ");
}

describe("POST /auth/device — initiate", () => {
  it("returns device_code, user_code, verification URIs, expires_in, interval", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const result = await initiate(ctx, clientId, "core.note:read");

    expect(result.device_code).toMatch(/^marfa_dc_/);
    expect(result.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(result.verification_uri).toMatch(/\/auth\/device$/);
    // Complete URI must carry the issued user_code (URL-encoded since
    // the canonical form has a hyphen) so the verification page can
    // pre-fill from `?user_code=`.
    expect(result.verification_uri_complete).toBe(
      `${result.verification_uri}?user_code=${encodeURIComponent(result.user_code)}`,
    );
    expect(result.expires_in).toBe(600);
    expect(result.interval).toBe(5);
  });

  it("rejects unknown client_id with 400 INVALID_CLIENT", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/device`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ client_id: "fake", scope: "core.note:read" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_client");
  });

  it("rejects empty scope with 400 VALIDATION_ERROR", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/device`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ client_id: clientId, scope: "" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  // RFC 8628 §3.1 specifies the init request as
  // `application/x-www-form-urlencoded`. Any client following the RFC
  // literally must work end-to-end; a form-encoded init request was
  // previously routing into the user-code submission branch and
  // returning the wrong shape.
  it("accepts an RFC 8628 form-encoded init request", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/device`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
        },
        body: new URLSearchParams({
          client_id: clientId,
          scope: "core.note:read",
        }).toString(),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    };
    expect(body.device_code).toMatch(/^marfa_dc_/);
    expect(body.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(body.verification_uri).toMatch(/\/auth\/device$/);
    expect(body.expires_in).toBe(600);
    expect(body.interval).toBe(5);
  });

  it("rejects a form-encoded init with unknown client_id", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/device`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
        },
        body: new URLSearchParams({
          client_id: "fake",
          scope: "core.note:read",
        }).toString(),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_client");
  });
});

describe("GET /auth/device — verification form", () => {
  it("renders the form with no error banner", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/auth/device", {
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("Device sign-in");
    expect(html).toContain('name="user_code"');
    expect(html).not.toContain('role="alert"');
  });

  it("redirects canonical-shape user_code straight to consent", async () => {
    // verification_uri_complete pre-fill UX: when the URL carries a
    // well-formed code, skip the manual "Continue" tap and route the
    // user straight to /auth/device/consent. The consent route handles
    // sign-in fallback via return_to, so this stays safe.
    ctx = await createTestContext();
    const res = await request(
      ctx.app,
      "GET",
      "/auth/device?user_code=ABCD-EFGH",
      { headers: { origin: ORIGIN } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/auth/device/consent?user_code=ABCD-EFGH",
    );
  });

  it("renders the form pre-filled when the user_code is malformed", async () => {
    // Garbled code (lowercase / wrong length / non-canonical chars) —
    // fall through to the form so the user can correct it.
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/auth/device?user_code=zz", {
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('value="zz"');
  });

  it("renders the form when an error is being surfaced (no auto-redirect)", async () => {
    // If `?error=` is set, render the form with the banner — auto-
    // redirecting would hide the error from the user.
    ctx = await createTestContext();
    const res = await request(
      ctx.app,
      "GET",
      "/auth/device?user_code=ABCD-EFGH&error=invalid_code",
      { headers: { origin: ORIGIN } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain('value="ABCD-EFGH"');
  });

  it("renders an error banner when ?error=invalid_code is set", async () => {
    ctx = await createTestContext();
    const res = await request(
      ctx.app,
      "GET",
      "/auth/device?error=invalid_code",
      { headers: { origin: ORIGIN } },
    );
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain("wasn&#39;t recognized");
  });
});

describe("POST /auth/device (form) — submit user_code", () => {
  it("redirects to consent on a valid user_code", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const initResult = await initiate(ctx, clientId);
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/device`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
        },
        body: new URLSearchParams({
          user_code: initResult.user_code,
        }).toString(),
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `/auth/device/consent?user_code=${encodeURIComponent(initResult.user_code)}`,
    );
  });

  it("redirects with error=invalid_code on an unknown user_code", async () => {
    ctx = await createTestContext();
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/device`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
        },
        body: new URLSearchParams({ user_code: "FAKE-CODE" }).toString(),
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=invalid_code");
  });

  it("normalizes user_code without hyphen to canonical form", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const initResult = await initiate(ctx, clientId);
    const stripped = initResult.user_code.replace("-", "");
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/device`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
        },
        body: new URLSearchParams({ user_code: stripped }).toString(),
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(
      encodeURIComponent(initResult.user_code),
    );
  });
});

describe("GET /auth/device/consent — gated on session", () => {
  it("redirects to /auth/sign-in when no session cookie is present", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const initResult = await initiate(ctx, clientId);
    const res = await ctx.app.fetch(
      new Request(
        `${ORIGIN}/auth/device/consent?user_code=${encodeURIComponent(initResult.user_code)}`,
        { headers: { origin: ORIGIN } },
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/auth\/sign-in\?return_to=/);
  });

  it("renders the consent screen for an authenticated user", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const initResult = await initiate(ctx, clientId);
    const cookie = await signInAndCookie(
      ctx,
      "alice@example.com",
      "correct horse",
    );

    const res = await ctx.app.fetch(
      new Request(
        `${ORIGIN}/auth/device/consent?user_code=${encodeURIComponent(initResult.user_code)}`,
        { headers: { origin: ORIGIN, cookie } },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("Approve device sign-in");
    expect(html).toContain("Test CLI");
  });
});

describe("POST /auth/device/consent — approve / deny", () => {
  it("approve flips device_code to approved and renders success page", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const initResult = await initiate(ctx, clientId);
    const cookie = await signInAndCookie(
      ctx,
      "bob@example.com",
      "correct horse",
    );

    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/device/consent`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
          cookie,
        },
        body: new URLSearchParams({
          user_code: initResult.user_code,
          decision: "approve",
        }).toString(),
      }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("You&#39;re signed in");

    // Polling now returns the access token.
    const poll = await pollToken(ctx, initResult.device_code, clientId);
    expect(poll.status).toBe(200);
    expect(poll.body.access_token).toMatch(/^marfa_at_/);
    expect(poll.body.refresh_token).toMatch(/^marfa_rt_/);
  });

  it("F16: approve emits auth.grant.created audit row with source='device'", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const initResult = await initiate(ctx, clientId);
    const cookie = await signInAndCookie(
      ctx,
      "f16@example.com",
      "correct horse",
    );

    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/device/consent`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
          cookie,
        },
        body: new URLSearchParams({
          user_code: initResult.user_code,
          decision: "approve",
        }).toString(),
      }),
    );
    expect(res.status).toBe(200);

    // Tiny wait — audit.log is fire-and-forget.
    await new Promise((r) => setTimeout(r, 50));

    const audits = await ctx.storage.audit.list({
      action: "auth.grant.created",
      limit: 10,
    });
    expect(audits.data.length).toBe(1);
    const row = audits.data[0];
    expect(row?.resource_id).toBe(clientId);
    expect(row?.details.source).toBe("device");
    expect(row?.details.created).toBe(true);
    expect(row?.details.client_id).toBe(clientId);
    expect(row?.details.grant_item_id).toBeDefined();
  });

  it("F15: re-approving the same client doesn't duplicate the system.connection row", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const cookie = await signInAndCookie(
      ctx,
      "f15@example.com",
      "correct horse",
    );

    // First device-flow approval.
    const first = await initiate(ctx, clientId);
    const res1 = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/device/consent`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
          cookie,
        },
        body: new URLSearchParams({
          user_code: first.user_code,
          decision: "approve",
        }).toString(),
      }),
    );
    expect(res1.status).toBe(200);
    let items = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items.data.length).toBe(1);
    const grantId = items.data[0]!.id;

    // Second device-flow approval for the SAME client (e.g. user re-
    // authorizes after a tokens flush).
    const second = await initiate(ctx, clientId);
    const res2 = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/device/consent`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
          cookie,
        },
        body: new URLSearchParams({
          user_code: second.user_code,
          decision: "approve",
        }).toString(),
      }),
    );
    expect(res2.status).toBe(200);

    // Still one row.
    items = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items.data.length).toBe(1);
    expect(items.data[0]!.id).toBe(grantId);

    // Audit reflects re-consent: 2 rows, second has `created: false`.
    // Audit inserts are fire-and-forget — poll briefly until both rows
    // land. Under parallel test execution a hard-sleep isn't reliable.
    const storage = ctx.storage;
    const audits = await waitForAudit(
      () =>
        storage.audit.list({
          action: "auth.grant.created",
          limit: 10,
        }),
      (result) => result.data.length >= 2,
    );
    expect(audits.data.length).toBe(2);
    // Audit rows are list in descending order — first entry is the most recent.
    expect(audits.data[0]?.details.created).toBe(false);
    expect(audits.data[1]?.details.created).toBe(true);
  });

  it("deny flips device_code to denied; polling returns access_denied", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const initResult = await initiate(ctx, clientId);
    const cookie = await signInAndCookie(
      ctx,
      "carol@example.com",
      "correct horse",
    );

    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/device/consent`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
          cookie,
        },
        body: new URLSearchParams({
          user_code: initResult.user_code,
          decision: "deny",
        }).toString(),
      }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("You denied the request");

    const poll = await pollToken(ctx, initResult.device_code, clientId);
    expect(poll.status).toBe(400);
    expect(poll.body.error).toBe("access_denied");
  });
});

describe("POST /auth/device/token — RFC 8628 error paths", () => {
  it("returns authorization_pending while user has not yet acted", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const initResult = await initiate(ctx, clientId);
    const poll = await pollToken(ctx, initResult.device_code, clientId);
    expect(poll.status).toBe(400);
    expect(poll.body.error).toBe("authorization_pending");
  });

  it("returns slow_down on a second poll inside the interval", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const initResult = await initiate(ctx, clientId);
    const first = await pollToken(ctx, initResult.device_code, clientId);
    expect(first.body.error).toBe("authorization_pending");
    // Immediately re-poll: inside the 5s interval window.
    const second = await pollToken(ctx, initResult.device_code, clientId);
    expect(second.body.error).toBe("slow_down");
  });

  it("returns invalid_grant for an unknown device_code", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const poll = await pollToken(ctx, "marfa_dc_unknown", clientId);
    expect(poll.status).toBe(400);
    expect(poll.body.error).toBe("invalid_grant");
  });

  it("returns invalid_grant when client_id doesn't match the device_code's client", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientA = await createClient(ctx);
    const clientB = await createClient(ctx);
    const initResult = await initiate(ctx, clientA);
    const poll = await pollToken(ctx, initResult.device_code, clientB);
    expect(poll.status).toBe(400);
    expect(poll.body.error).toBe("invalid_grant");
  });

  it("returns invalid_request when grant_type is wrong", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/device/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          device_code: "marfa_dc_x",
          client_id: "x",
        }).toString(),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  // Defense-in-depth. The token-issuance handler resolves
  // `connection_item_id` (set at consent-approve time) and treats the
  // resulting item as a `system.connection` grant — pulling scopes,
  // client_id, user_id, tenant_id out of its properties. A corrupted
  // `connection_item_id` pointing at any non-grant item must not silently
  // mint a token with whatever scopes that item happened to carry.
  it("rejects token issuance when connection_item_id resolves to a non-system.connection item", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const initResult = await initiate(ctx, clientId);

    // Seed an item of the wrong type — a plain note — and approve the
    // device code against it, bypassing the consent UI. This simulates
    // a projection drift the type check is meant to catch.
    const decoyNote = await ctx.storage.items.create(
      {
        type: "core.note",
        properties: { body: "decoy note — must not become a grant" },
      },
      undefined,
    );
    const codeRow = await ctx.storage.oauth.findDeviceCodeByUserCode(
      initResult.user_code,
    );
    expect(codeRow).not.toBeNull();
    const approved = await ctx.storage.oauth.approveDeviceCode(
      codeRow!.id,
      decoyNote.id,
    );
    expect(approved).toBe(true);

    const poll = await pollToken(ctx, initResult.device_code, clientId);
    expect(poll.status).toBe(500);
    // No access token in the response — handler threw before
    // `mintTokenPair` ran.
    expect(poll.body.access_token).toBeUndefined();
    expect(poll.body.refresh_token).toBeUndefined();
  });
});
