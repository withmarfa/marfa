import { describe, it, expect, afterEach } from "vitest";
import {
  createTestContext,
  markEmailVerified,
  request,
  waitForAudit,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { setActivePermissionBundles } from "../config.js";
import { setConsentLockBackend } from "../auth/consent-lock.js";
import { grantCoversScope, TYPE_REGISTRY } from "@withmarfa/shared";

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

async function createClient(
  c: TestContext,
  registered: {
    scopes?: readonly string[];
    grantTypes?: readonly string[];
  } = {},
): Promise<string> {
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
  // Same dialect split as `redirectUris` above: a PG `text[]` takes the
  // array, SQLite's `text` takes JSON. Absent stays NULL in both, which is
  // "the client registered none" and not "the client registered an empty
  // set" — the distinction the ceiling turns on.
  const asColumn = (v: readonly string[] | undefined): unknown =>
    v === undefined
      ? null
      : c.storage.betterAuthDialect === "pg"
        ? [...v]
        : JSON.stringify(v);
  const op = db.insert(schemaModule.auth_oauth_client).values({
    id: clientPk,
    clientId,
    name: "Test CLI",
    redirectUris,
    scopes: asColumn(registered.scopes),
    grantTypes: asColumn(
      registered.grantTypes ?? ["urn:ietf:params:oauth:grant-type:device_code"],
    ),
    disabled: false,
    createdAt: now,
    updatedAt: now,
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
  return clientId;
}
void ORIGIN;

/** Init without the 200 assertion, so refusals can be inspected. */
async function tryInit(
  c: TestContext,
  clientId: string,
  scope: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await c.app.fetch(
    new Request(`${ORIGIN}/auth/device`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ client_id: clientId, scope }),
    }),
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

/** The stored ceiling as the row holds it now, read back through the store
 *  rather than assumed, because catching a stale ceiling up is a write. */
async function storedCeiling(
  c: TestContext,
  clientId: string,
): Promise<readonly string[] | null> {
  const client = await c.storage.oauthProvider?.getClient(clientId);
  return client?.scopes ?? null;
}

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

  // `user.*` types are per-space and never enumerate in the static
  // registry, so expansion-based validation dropped the wildcard to an
  // empty set and a request carrying only `user.*:read` was refused.
  // The scope allowlist is the validator — the same set the code flow
  // accepts — and a wildcard is a first-class literal in it.
  it("accepts a user.* wildcard scope", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const result = await initiate(ctx, clientId, "user.*:read");
    expect(result.device_code).toMatch(/^marfa_dc_/);
  });

  // The stored grant is the requested literal set, so a scope that
  // slipped through validation would be approved verbatim on consent.
  // Any disallowed scope therefore refuses the whole request rather
  // than being quietly dropped or quietly kept.
  it("rejects a scope outside the allowlist, even beside a valid one", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/device`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({
          client_id: clientId,
          scope: "core.note:read madeup.type:read",
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_scope");
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
    expect(html).toContain("Sign in on your device");
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

  it("renders a wildcard scope as its own row instead of dropping it", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const initResult = await initiate(
      ctx,
      clientId,
      "user.*:read core.note:read",
    );
    const cookie = await signInAndCookie(
      ctx,
      "carol@example.com",
      "correct horse",
    );

    const res = await ctx.app.fetch(
      new Request(
        `${ORIGIN}/auth/device/consent?user_code=${encodeURIComponent(initResult.user_code)}`,
        { headers: { origin: ORIGIN, cookie } },
      ),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // The wildcard is what the approval grants, so the screen has to
    // show it — silently omitting it would approve more than was shown.
    // Expansion against the static registry dropped `user.*` (runtime
    // types never enumerate there), leaving one row for two scopes.
    //
    // Both halves of the row, because they arrive from different places and
    // only one of them is copy. The description says what the grant reaches;
    // the clause after it says the grant is not a snapshot, and this screen
    // composes that from the scope grammar rather than reading it out of a
    // curated string. Pinning the description alone would pass on a row that
    // had quietly stopped saying how far the grant goes.
    expect(html).toContain("Your custom types.");
    expect(html).toContain(
      "Your custom types. Also covers anything added later.",
    );
    const rowCount = html.split('class="crow"').length - 1;
    expect(rowCount).toBe(2);
  });

  it("describes a type in the consent screen's words, not the registry's", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const initResult = await initiate(ctx, clientId, "core.note:read");
    const cookie = await signInAndCookie(
      ctx,
      "dave@example.com",
      "correct horse",
    );

    const res = await ctx.app.fetch(
      new Request(
        `${ORIGIN}/auth/device/consent?user_code=${encodeURIComponent(initResult.user_code)}`,
        { headers: { origin: ORIGIN, cookie } },
      ),
    );
    expect(res.status).toBe(200);
    const html = await res.text();

    // This route built a description map of its own that reached for the type
    // registry first, and the registry's copy is written for a developer
    // reading API docs. The authorize screen has always shown the curated
    // line, so a person approving the same grant met one answer or the other
    // depending on which screen the flow had put them in front of. Asserting
    // the curated line is what holds this route to the shared source: a
    // rebuilt local map would satisfy the wildcard row above unchanged.
    const registry = TYPE_REGISTRY.get("core.note")?.description;
    expect(
      registry,
      "fixture assumes the registry describes core.note",
    ).toMatch(/\S/);
    expect(registry).not.toBe("Notes.");
    expect(html).toContain("Notes.");
    expect(html).not.toContain(registry);
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
    // And nothing else: `initiate` asks for two data scopes and no
    // `offline_access`, so this grant did not ask to stay signed in. A
    // refresh token here would be one no rotation path can reach — the
    // parity between this route and the authorization-code path is pinned
    // in `auth/refresh-token-offline-access.test.ts`.
    expect(poll.body.refresh_token).toBeUndefined();
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

    // The consent handler emits its audit row fire-and-forget (`void
    // storage.audit.log(...)`) so an audit failure can never block the
    // user-facing response, which means the row lands some time after the
    // 200. Poll until it does rather than sleeping a guessed interval: the
    // wait tracks actual write latency instead of assuming one, and it
    // keeps the in-flight write inside the test body, so per-test teardown
    // can't close the database connection out from under it.
    const storage = ctx.storage;
    const audits = await waitForAudit(
      () =>
        storage.audit.list({
          action: "auth.grant.created",
          limit: 10,
        }),
      (result) => result.data.length >= 1,
    );
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

/**
 * The device screen confirms a scope list rather than offering one to edit,
 * so an approval may widen a standing grant and must never shrink one. These
 * pin both directions, plus the consequence at the token step: the record can
 * now hold more than this device asked for, and what it is handed must still
 * be what it asked for.
 *
 * The standing grant is established by an earlier device approval rather than
 * a browser consent because the record is the same row either way, and this
 * file already owns the machinery for one.
 */
describe("POST /auth/device/consent, approving merges into a standing grant", () => {
  /** Initiate for `scope`, approve at the consent screen, and hand back the
   *  initiation so a caller can also poll for the token it issues. */
  async function approveDeviceFlow(
    c: TestContext,
    clientId: string,
    cookie: string,
    scope: string,
  ): Promise<Awaited<ReturnType<typeof initiate>>> {
    const init = await initiate(c, clientId, scope);
    const res = await c.app.fetch(
      new Request(`${ORIGIN}/auth/device/consent`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
          cookie,
        },
        body: new URLSearchParams({
          user_code: init.user_code,
          decision: "approve",
        }).toString(),
      }),
    );
    expect(res.status).toBe(200);
    return init;
  }

  /** The one projected grant, whatever its `properties.status` says. Item
   *  state stays "active" across a revoke — only the property flips — so this
   *  finds the row either way. Asserting the count keeps a merge that
   *  accidentally forked the projection from reading as one that worked. */
  async function standingGrant(c: TestContext) {
    const items = await c.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items.data.length).toBe(1);
    return items.data[0]!;
  }

  /** The scope literals the one projected grant holds. */
  async function standingGrantScopes(c: TestContext): Promise<string[]> {
    return (await standingGrant(c)).properties.scopes as string[];
  }

  /** Revoke the standing grant the way the user does: the form post behind
   *  the Disconnect button on `/auth/security`. Driven through the route
   *  rather than by writing `status` onto the row, because the cascade
   *  through the plugin's token tables and the consent lock are both part of
   *  what a revoke IS, and a hand-written property would test a fiction of
   *  one. */
  async function revokeStandingGrant(
    c: TestContext,
    cookie: string,
  ): Promise<void> {
    const grant = await standingGrant(c);
    const res = await c.app.fetch(
      new Request(`${ORIGIN}/auth/grants/${grant.id}/revoke`, {
        method: "POST",
        headers: { origin: ORIGIN, cookie },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("notice=grant_revoked");
    // The revoke has to have landed for anything after it to mean
    // something. Without this the test still passes when the route quietly
    // does nothing, on the strength of a merge that had nothing to restore.
    const after = await standingGrant(c);
    expect(after.properties.status).toBe("revoked");
    expect(after.properties.revoked_at).toBeTruthy();
  }

  it("keeps a scope the standing grant holds and this device did not name", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const cookie = await signInAndCookie(
      ctx,
      "merge-narrower@example.com",
      "correct horse",
    );

    await approveDeviceFlow(
      ctx,
      clientId,
      cookie,
      "core.note:read core.task:write",
    );
    await approveDeviceFlow(ctx, clientId, cookie, "core.note:read");

    const scopes = await standingGrantScopes(ctx);
    expect(scopes).toContain("core.task:write");
    expect(grantCoversScope(scopes, "core.task:write")).toBe(true);
    expect(grantCoversScope(scopes, "core.note:read")).toBe(true);
  });

  // REGRESSION: `findGrantItemId` has no status predicate and
  // `revokeProjectedGrant` leaves `scopes` verbatim on the row it flips, so a
  // revoked grant came back through the merge as a standing one. A device
  // login asking for less than the user had revoked reactivated the record
  // holding the scope they withdrew, on a consent screen that never showed
  // it. A device approval never narrows a STANDING grant; a revoked grant is
  // not standing.
  it("does not restore a scope the user revoked", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const cookie = await signInAndCookie(
      ctx,
      "merge-revoked@example.com",
      "correct horse",
    );

    await approveDeviceFlow(
      ctx,
      clientId,
      cookie,
      "core.note:read core.task:write",
    );
    await revokeStandingGrant(ctx, cookie);

    // The device logs in again, asking for less than the revoked record
    // holds and never showing `core.task:write` on its consent screen.
    await approveDeviceFlow(ctx, clientId, cookie, "core.note:read");

    // Reactivating the row on re-consent is the intended behavior and has to
    // survive the fix — the failure being pinned is what it reactivates AT.
    const grant = await standingGrant(ctx);
    expect(grant.properties.status).toBe("active");
    expect(grant.properties.revoked_at).toBeUndefined();

    const scopes = grant.properties.scopes as string[];
    expect(scopes).toEqual(["core.note:read"]);
    expect(grantCoversScope(scopes, "core.task:write")).toBe(false);
  });

  // The clause above must not turn every re-approval into an overwrite: an
  // approval against a grant that is still active merges as it always did.
  // The two live side by side because the fix is one predicate away from
  // taking the merge out altogether, and only this direction notices.
  it("still merges into a grant that was never revoked", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const cookie = await signInAndCookie(
      ctx,
      "merge-not-revoked@example.com",
      "correct horse",
    );

    await approveDeviceFlow(
      ctx,
      clientId,
      cookie,
      "core.note:read core.task:write",
    );
    await approveDeviceFlow(ctx, clientId, cookie, "core.note:read");

    const grant = await standingGrant(ctx);
    expect(grant.properties.status).toBe("active");
    expect(
      grantCoversScope(grant.properties.scopes as string[], "core.task:write"),
    ).toBe(true);
  });

  // A grant is hidden from both read surfaces on TWO axes, and the merge read
  // one. `softDeleteState` puts a `system.*` item in `revoked` rather than
  // `trashed`, and the soft delete leaves `properties.status` alone, so this
  // row reads "active" on the axis the merge checked and "revoked" on the axis
  // it did not. `items.get` hides only trashed rows, so it comes back.
  //
  // The lookup refuses it before the merge is reached now, so what this pins
  // is that the approval re-establishes on a row the user can see rather than
  // on the tombstone. The merge's own both-axes read is the second fence and
  // is covered directly in `auth-grant-visibility.test.ts`.
  //
  // Driven through `DELETE /items/{id}` with the platform credential rather
  // than written onto the row, because the shape being pinned is one the API
  // actually produces, and a hand-stamped `state` would prove only that the
  // predicate reads the field.
  it("does not merge into a grant whose lifecycle state is not active", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const cookie = await signInAndCookie(
      ctx,
      "merge-state-revoked@example.com",
      "correct horse",
    );

    await approveDeviceFlow(
      ctx,
      clientId,
      cookie,
      "core.note:read core.task:write",
    );
    const original = await standingGrant(ctx);
    const grantId = original.id;

    // Straight to the state axis. A bare item delete of a live grant is
    // refused now (it would strand the plugin's records), so the shape this
    // case needs, revoked on the state axis and still active on the status
    // axis, is written the way a misbehaving operator path would leave it.
    await ctx.storage.items.transition(
      grantId,
      "revoked",
      original.space_id ?? undefined,
    );
    // The fixture only means something if it is admitted by the predicate the
    // clause was added to. `status` still reads "active", so the merge would
    // take these scopes as standing were the `state` clause removed.
    const hidden = await ctx.storage.items.get(grantId);
    expect(hidden?.state).toBe("revoked");
    expect(hidden?.properties.status).toBe("active");

    await approveDeviceFlow(ctx, clientId, cookie, "core.note:read");

    // The approval never reaches that row now: `findGrantItemId` carries its
    // own `state = 'active'` predicate, so the re-consent branch is not
    // entered and the fresh insert below is the only remaining path. An
    // unchanged `granted_at` is what separates "was not reached" from "was
    // reached and written the same values back".
    const after = await ctx.storage.items.get(grantId);
    expect(after?.state).toBe("revoked");
    expect(after?.properties.granted_at).toBe(hidden?.properties.granted_at);
    expect(after?.properties.scopes).toEqual([
      "core.note:read",
      "core.task:write",
    ]);

    // The scopes the user can actually see are the ones this approval asked
    // for, on a row both read surfaces list. `standingGrant` filters on
    // `state: "active"`, so it finds the new row and its count assertion
    // pins that the tombstone did not fork the projection into two live
    // grants.
    const standing = await standingGrant(ctx);
    expect(standing.id).not.toBe(grantId);
    const scopes = standing.properties.scopes as string[];
    expect(scopes).toEqual(["core.note:read"]);
    expect(grantCoversScope(scopes, "core.task:write")).toBe(false);
  });

  it("adds a scope the standing grant does not reach", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const cookie = await signInAndCookie(
      ctx,
      "merge-wider@example.com",
      "correct horse",
    );

    await approveDeviceFlow(ctx, clientId, cookie, "core.note:read");
    await approveDeviceFlow(
      ctx,
      clientId,
      cookie,
      "core.note:read core.task:write",
    );

    const scopes = await standingGrantScopes(ctx);
    expect(scopes).toContain("core.task:write");
    expect(grantCoversScope(scopes, "core.task:write")).toBe(true);
  });

  // The merge happens on effective permissions because a literal one can
  // narrow. Scope resolution gives an exact type id precedence over a wildcard
  // spanning it, so parking `core.note:read` beside a standing `core.*:write`
  // pins `core.note` to read and takes away a write nobody unticked. The unit
  // coverage is in `device-scope-merge.test.ts`; this pins that the route
  // actually routes through it.
  it("does not park a covered literal beside the wildcard that covers it", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const cookie = await signInAndCookie(
      ctx,
      "merge-covered@example.com",
      "correct horse",
    );

    await approveDeviceFlow(ctx, clientId, cookie, "core.*:write");
    await approveDeviceFlow(ctx, clientId, cookie, "core.note:read");

    const scopes = await standingGrantScopes(ctx);
    expect(scopes).not.toContain("core.note:read");
    expect(grantCoversScope(scopes, "core.note:write")).toBe(true);
  });

  // The other direction, which the coverage-append merge got wrong: skipping a
  // pin the standing wildcard already covers leaves the record conferring a
  // write neither side conferred.
  it("does not confer a write neither the standing grant nor the request did", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const cookie = await signInAndCookie(
      ctx,
      "merge-escalation@example.com",
      "correct horse",
    );

    await approveDeviceFlow(ctx, clientId, cookie, "core.*:read");
    await approveDeviceFlow(
      ctx,
      clientId,
      cookie,
      "core.*:write core.note:read",
    );

    const scopes = await standingGrantScopes(ctx);
    expect(grantCoversScope(scopes, "core.note:write")).toBe(false);
    // Not vacuous: the request genuinely widened the rest of the namespace, so
    // a merge that refused to widen anything would also pass the line above.
    expect(grantCoversScope(scopes, "core.task:write")).toBe(true);
  });

  // Coverage is not reflexive on a pinned set, so a literal merge failed the
  // stored `core.*:write` against its own record and re-appended it on every
  // login. Five repeats took the array from two entries to seven.
  //
  // The CLI keeps sending the request it was built with while the record has
  // been canonicalized upward, so `core.note` is spelled differently on the
  // two sides from the second login onward. Repeating a request the record
  // already spells identically would not exercise that.
  it("does not grow the record when a CLI signs in again and again", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const cookie = await signInAndCookie(
      ctx,
      "merge-repeat@example.com",
      "correct horse",
    );

    await approveDeviceFlow(ctx, clientId, cookie, "core.*:write");
    await approveDeviceFlow(ctx, clientId, cookie, "core.note:read");
    const first = await standingGrantScopes(ctx);
    for (let i = 0; i < 4; i++) {
      await approveDeviceFlow(ctx, clientId, cookie, "core.note:read");
      expect(await standingGrantScopes(ctx)).toEqual(first);
    }
  });

  // An approval merges, so the request no longer describes what the record
  // ends up holding. Logging only the request made a grant look like it
  // acquired scopes from nowhere.
  it("audits the approved scopes and the record the merge produced", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const cookie = await signInAndCookie(
      ctx,
      "merge-audit@example.com",
      "correct horse",
    );

    await approveDeviceFlow(ctx, clientId, cookie, "core.task:write");
    await approveDeviceFlow(ctx, clientId, cookie, "core.note:read");

    // The audit write is fire-and-forget, so poll until the re-consent row
    // lands rather than racing it.
    const ctxRef = ctx;
    const rows = await waitForAudit(
      () => ctxRef.storage.audit.list({ action: "auth.grant.created" }),
      (r) => r.data.some((row) => row.details.created === false),
    );
    const reconsent = rows.data.find((r) => r.details.created === false);
    expect(reconsent).toBeDefined();
    // The request, unchanged: this is what the device asked for and what its
    // screen showed.
    expect(reconsent?.details.scopes).toEqual(["core.note:read"]);
    // The record after the merge, which is the half the request cannot supply.
    // Neither literal reaches the other, so the merge is the plain pair and
    // can be asserted exactly.
    expect(reconsent?.details.resulting_scopes).toEqual([
      "core.task:write",
      "core.note:read",
    ]);
  });

  it("issues the device a token for what it asked for, not for the merged grant", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const cookie = await signInAndCookie(
      ctx,
      "merge-token-scope@example.com",
      "correct horse",
    );

    await approveDeviceFlow(
      ctx,
      clientId,
      cookie,
      "core.note:read core.task:write",
    );
    const narrow = await approveDeviceFlow(
      ctx,
      clientId,
      cookie,
      "core.note:read",
    );

    const poll = await pollToken(ctx, narrow.device_code, clientId);
    expect(poll.status).toBe(200);
    expect(poll.body.scope).toBe("core.note:read");

    // The response field is a claim; the minted row is the authority, and the
    // two are set from different expressions. Spending the token is what tells
    // them apart, so this asks the data plane rather than re-reading the JSON.
    const write = await ctx.app.fetch(
      new Request(`${ORIGIN}/items`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          authorization: `Bearer ${poll.body.access_token as string}`,
        },
        body: JSON.stringify({
          type: "core.task",
          properties: { title: "from a device that never asked" },
        }),
      }),
    );
    expect(write.status).toBe(403);
  });

  it("withholds a refresh token from a device that did not ask to stay signed in", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const cookie = await signInAndCookie(
      ctx,
      "merge-token-offline@example.com",
      "correct horse",
    );

    await approveDeviceFlow(
      ctx,
      clientId,
      cookie,
      "offline_access core.note:read",
    );
    const narrow = await approveDeviceFlow(
      ctx,
      clientId,
      cookie,
      "core.note:read",
    );

    const poll = await pollToken(ctx, narrow.device_code, clientId);
    expect(poll.status).toBe(200);
    expect(poll.body.access_token).toMatch(/^marfa_at_/);
    expect(poll.body.refresh_token).toBeUndefined();
  });

  // The other half of the same rule. A device code outlives its approval by up
  // to the rest of its TTL, so a narrowing on the consent screen can land in
  // between, and that narrowing has already revoked the live tokens. The poll
  // that follows must not hand back what was just taken away.
  it("does not reissue access the standing grant no longer reaches", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const cookie = await signInAndCookie(
      ctx,
      "merge-token-narrowed@example.com",
      "correct horse",
    );

    const wide = await approveDeviceFlow(
      ctx,
      clientId,
      cookie,
      "core.note:read core.task:write",
    );

    // Stands in for the consent screen narrowing the grant, which rewrites
    // exactly this record. Written directly because the point under test is
    // what the token step reads, not how the record came to say it.
    const items = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items.data.length).toBe(1);
    const grant = items.data[0]!;
    await ctx.storage.items.update(
      grant.id,
      { properties: { scopes: ["core.note:read"] } },
      grant.space_id ?? undefined,
    );

    const poll = await pollToken(ctx, wide.device_code, clientId);
    expect(poll.status).toBe(200);
    expect(poll.body.scope).toBe("core.note:read");
  });

  // REGRESSION: what a device is issued was computed by testing each
  // requested literal with `grantCoversScope`, which reads as an intersection
  // and is not one. Coverage is not reflexive on a pinned set, so a request
  // of `core.note:read *:write` failed its own `*:write` against a grant
  // holding exactly that pair, and the device was issued the pin alone. The
  // user approved both, the grant reached both, and the client was handed a
  // narrower `scope` string rather than an error. The unit coverage is in
  // `device-scope-merge.test.ts`; this pins that the route routes through it.
  //
  // Nothing here needs a second login: a first approval stores the request
  // verbatim, so the grant and the request are the same set and the drop
  // still happened.
  it("issues a wildcard the device asked for alongside a narrower pin", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const cookie = await signInAndCookie(
      ctx,
      "token-pinned-wildcard@example.com",
      "correct horse",
    );

    const login = await approveDeviceFlow(
      ctx,
      clientId,
      cookie,
      "core.note:read *:write",
    );

    // The premise, asserted rather than assumed: the record holds both, and
    // the test the old filter ran answers false on the literal it contains.
    const scopes = await standingGrantScopes(ctx);
    expect(scopes).toEqual(["core.note:read", "*:write"]);
    expect(grantCoversScope(scopes, "*:write")).toBe(false);

    const poll = await pollToken(ctx, login.device_code, clientId);
    expect(poll.status).toBe(200);
    // The response field is a claim; the minted row is the authority, and the
    // two are set from different expressions. Spending the token is what
    // tells them apart, so the reach is asked of the data plane.
    expect(poll.body.scope).toContain("*:write");
    const token = poll.body.access_token as string;

    const write = async (type: string): Promise<number> => {
      const res = await ctx!.app.fetch(
        new Request(`${ORIGIN}/items`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: ORIGIN,
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ type, properties: { title: "from a CLI" } }),
        }),
      );
      return res.status;
    };

    // The wildcard reaches a type the request never named concretely.
    expect(await write("core.task")).toBe(201);
    // And the pin under it still holds notes down to read, so the fix cannot
    // be "issue the whole request and stop filtering".
    expect(await write("core.note")).toBe(403);
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
  // client_id, user_id, space_id out of its properties. A corrupted
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

// ---------------------------------------------------------------------------
// The client's own registration is a ceiling on what it may ask for.
// ---------------------------------------------------------------------------

describe("POST /auth/device — the client's registered ceiling", () => {
  it("refuses a scope the client never registered for", async () => {
    ctx = await createTestContext();
    const clientId = await createClient(ctx, { scopes: ["core.note:read"] });
    // Every scope here is on the platform allowlist, so the pre-existing
    // check passes all of them. What the client asked to be allowed is a
    // different question, and this path had never asked it.
    //
    // The wildcard is what makes the case a ceiling case rather than a
    // staleness one. A stored ceiling catches up to what the bundles publish
    // (see the describe below), so a per-type bundle literal would be
    // admitted here by that repair instead. A wildcard is requestable and in
    // no bundle, so the registration is the only thing that can admit it.
    const res = await tryInit(ctx, clientId, "core.note:read core.*:read");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "invalid_scope" });
    expect(JSON.stringify(res.body)).toContain("core.*:read");
  });

  it("allows a scope inside the registered ceiling", async () => {
    ctx = await createTestContext();
    const clientId = await createClient(ctx, {
      scopes: ["core.note:read", "core.note:write"],
    });
    const res = await tryInit(ctx, clientId, "core.note:read core.note:write");
    expect(res.status).toBe(200);
    expect(res.body.device_code).toBeTruthy();
  });

  it("tracks the live allowlist when the client registered no ceiling", async () => {
    // NULL is not an empty ceiling. A client that registered none follows
    // whatever the platform currently advertises, which is the same reading
    // the authorization-code path takes via `client.scopes ?? opts.scopes`.
    // `grant_types` is the opposite: absent there means authorization_code
    // only, per RFC 7591 §2, so the two nulls deliberately read differently.
    ctx = await createTestContext();
    const clientId = await createClient(ctx);
    const res = await tryInit(ctx, clientId, "core.note:read core.task:write");
    expect(res.status).toBe(200);
  });

  it("still refuses a scope the platform does not offer, ceiling or not", async () => {
    ctx = await createTestContext();
    const clientId = await createClient(ctx, {
      scopes: ["core.note:read", "core.nonexistent.type:read"],
    });
    const res = await tryInit(ctx, clientId, "core.nonexistent.type:read");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "invalid_scope" });
  });

  it("refuses a client that registered grant types without the device grant", async () => {
    ctx = await createTestContext();
    const clientId = await createClient(ctx, {
      grantTypes: ["authorization_code", "refresh_token"],
    });
    const res = await tryInit(ctx, clientId, "core.note:read");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "invalid_client" });
  });

  it("refuses a client that registered no grant types at all", async () => {
    // An empty registration is authorization_code only, not "anything
    // goes" — the reading the plugin applies on every path it owns.
    ctx = await createTestContext();
    const clientId = await createClient(ctx, { grantTypes: [] });
    const res = await tryInit(ctx, clientId, "core.note:read");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "invalid_client" });
  });

  it("allows a client that registered the device grant", async () => {
    ctx = await createTestContext();
    const clientId = await createClient(ctx, {
      grantTypes: [
        "authorization_code",
        "urn:ietf:params:oauth:grant-type:device_code",
      ],
    });
    const res = await tryInit(ctx, clientId, "core.note:read");
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// The ceiling this surface compares against is a registration-time snapshot,
// so it catches up first.
// ---------------------------------------------------------------------------

describe("POST /auth/device — a stale ceiling catches up", () => {
  it("admits a bundle scope beneath a wildcard the client registered", async () => {
    // `core.*:read` is a legitimate registration literal, and `core.note:read`
    // is one of the scopes every client is told it may ask for. Comparing a
    // frozen row exactly refused it anyway, terminally, for a registration
    // that plainly covered it.
    ctx = await createTestContext();
    const clientId = await createClient(ctx, { scopes: ["core.*:read"] });

    const res = await tryInit(ctx, clientId, "core.note:read");
    expect(res.status).toBe(200);
    expect(res.body.device_code).toBeTruthy();

    // And the repair is the row moving, not the comparison loosening. That
    // distinction is the whole design: every other reader of this row tests
    // exact membership, so a literal admitted on breadth alone here would be
    // refused by one of them a moment later.
    expect(await storedCeiling(ctx, clientId)).toEqual([
      "core.*:read",
      "core.note:read",
    ]);
  });

  it("records which surface widened the row", async () => {
    // Two callers write this action now, and the row is what an operator
    // reads afterwards. Without the surface it says a registration changed
    // and not where the request that changed it came in.
    ctx = await createTestContext();
    const clientId = await createClient(ctx, { scopes: ["core.*:read"] });

    expect((await tryInit(ctx, clientId, "core.note:read")).status).toBe(200);

    const audits = await waitForAudit(
      () =>
        ctx!.storage.audit.list({
          action: "auth.client.scopes_widened",
          limit: 10,
        }),
      (result) => result.data.length >= 1,
    );
    expect(audits.data.length).toBe(1);
    const row = audits.data[0];
    expect(row?.resource_id).toBe(clientId);
    expect(row?.details.surface).toBe("device");
    expect(row?.details.added_scopes).toEqual(["core.note:read"]);
  });

  it("does not widen the row on a request the allowlist refuses", async () => {
    // The catch-up is a persistent write and initiation is unauthenticated,
    // so the live allowlist has to clear the whole request before the row
    // moves. Both halves of the fixture are load-bearing: `core.task:read` is
    // bundle-published and unheld, which is exactly what a catch-up widens
    // by, and `core.nonexistent.type:read` is on no allowlist, so the request
    // cannot succeed. Widening on the way to that refusal leaves an
    // anonymous caller holding a ceiling it was refused — and the ceiling is
    // also what this client is given the next time it omits `scope`.
    ctx = await createTestContext();
    const clientId = await createClient(ctx, { scopes: ["core.note:read"] });

    const res = await tryInit(
      ctx,
      clientId,
      "core.task:read core.nonexistent.type:read",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "invalid_scope" });
    expect(await storedCeiling(ctx, clientId)).toEqual(["core.note:read"]);
  });

  it("does not fill in an empty ceiling", async () => {
    // An empty array is a deliberate statement that this client may have
    // nothing, and the catch-up must not read it as "not configured yet".
    ctx = await createTestContext();
    const clientId = await createClient(ctx, { scopes: [] });

    const res = await tryInit(ctx, clientId, "core.note:read");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "invalid_scope" });
    expect(await storedCeiling(ctx, clientId)).toEqual([]);
  });

  it("does not write a ceiling onto a client that has none", async () => {
    // A null ceiling already tracks the live allowlist, so writing one would
    // replace a set that follows the registry with a snapshot that does not.
    ctx = await createTestContext();
    const clientId = await createClient(ctx);

    const res = await tryInit(ctx, clientId, "core.note:read");
    expect(res.status).toBe(200);
    expect(await storedCeiling(ctx, clientId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A registration must be able to sign in with the credential it was given.
// ---------------------------------------------------------------------------

describe("POST /auth/device — a real registration can complete a login", () => {
  /** Exactly what `marfa auth login` sends: no `scope`, so the server
   *  chooses the ceiling. See `CLI_DCR_MANIFEST` in the CLI's auth command. */
  const CLI_MANIFEST = {
    client_name: "marfa-cli",
    redirect_uris: ["http://127.0.0.1:0"],
    grant_types: [
      "urn:ietf:params:oauth:grant-type:device_code",
      "refresh_token",
    ],
    token_endpoint_auth_method: "none",
  };

  /** The CLI's own default request set. `offline_access` is the whole point
   *  of the device flow — a CLI that cannot refresh re-authenticates hourly. */
  const CLI_LOGIN_SCOPES = "openid offline_access profile";

  it("lets a client registered with no scope request offline_access", async () => {
    ctx = await createTestContext();
    const reg = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: CLI_MANIFEST,
    });
    expect(reg.status).toBe(201);
    const registered = (await reg.json()) as Record<string, unknown>;
    const clientId = registered.client_id as string;

    // The ceiling the server minted must contain the session scopes it
    // expects clients to ask for. Omitting them mints a credential that
    // cannot be used, and the client cannot amend its own registration.
    expect((registered.scope as string).split(" ")).toEqual(
      expect.arrayContaining(["openid", "offline_access"]),
    );

    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/device`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ client_id: clientId, scope: CLI_LOGIN_SCOPES }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("keeps the session scopes when the registration names its own", async () => {
    // A narrow, deliberate registration still has to be able to hold a
    // session. `openid` and `offline_access` carry no data-plane reach, so
    // admitting them widens nothing a consent screen would show.
    ctx = await createTestContext();
    const reg = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: { ...CLI_MANIFEST, scope: "core.note:read" },
    });
    expect(reg.status).toBe(201);
    const registered = (await reg.json()) as Record<string, unknown>;
    const scopes = (registered.scope as string).split(" ");
    expect(scopes).toEqual(
      expect.arrayContaining(["core.note:read", "openid", "offline_access"]),
    );
    // Still a ceiling: naming one type does not admit another.
    expect(scopes).not.toContain("core.task:write");
  });
});

// ---------------------------------------------------------------------------
// An off-by-default bundle withholds a scope from a screen that cannot offer
// it, and a wildcard must not walk around that.
// ---------------------------------------------------------------------------

describe("POST /auth/device — off-by-default scopes", () => {
  /**
   * Every shipped bundle is `default_on: true`, so on a default deployment
   * nothing is withheld and neither direction of this is reachable. A test
   * that does not install an off-by-default bundle passes against the broken
   * code and the fixed code alike, which is the whole trap here.
   *
   * Installed before the app is built so the request-time bundle read and
   * the router's snapshot of the requestable allowlist agree.
   */
  const withBundles = async <T>(
    bundles: Parameters<typeof setActivePermissionBundles>[0],
    fn: () => Promise<T>,
  ): Promise<T> => {
    setActivePermissionBundles(bundles);
    try {
      return await fn();
    } finally {
      setActivePermissionBundles(null);
    }
  };

  const bundle = (
    id: string,
    default_on: boolean,
    scopes: string[],
  ): {
    id: string;
    label: string;
    description: string;
    scopes: string[];
    default_on: boolean;
  } => ({ id, label: id, description: "", scopes, default_on });

  it("refuses a wildcard that reaches a withheld scope", async () => {
    // The device approval screen confirms a scope list and has no per-scope
    // toggle, so an off-by-default scope reaching it is granted on one click.
    // Matching the withheld set by membership let `core.*:write` past while
    // covering every literal in it.
    await withBundles(
      [
        bundle("read", true, ["core.note:read"]),
        bundle("manage", false, ["core.task:write"]),
      ],
      async () => {
        ctx = await createTestContext();
        const clientId = await createClient(ctx);

        const res = await tryInit(ctx, clientId, "core.*:write");
        expect(res.status).toBe(400);
        expect(res.body.error).toMatchObject({ code: "invalid_scope" });

        // Naming the wildcard back at the client tells it nothing it did not
        // already know. Naming what is being protected is what lets it narrow
        // to a request this flow can honor.
        const message = (res.body.error as { message?: string }).message ?? "";
        expect(message).toContain("core.task:write");
        expect(message).not.toContain("core.*:write");
      },
    );
  });

  it("still refuses the withheld scope named outright", async () => {
    await withBundles(
      [
        bundle("read", true, ["core.note:read"]),
        bundle("manage", false, ["core.task:write"]),
      ],
      async () => {
        ctx = await createTestContext();
        const clientId = await createClient(ctx);

        const res = await tryInit(ctx, clientId, "core.task:write");
        expect(res.status).toBe(400);
        expect(res.body.error).toMatchObject({ code: "invalid_scope" });
      },
    );
  });

  it("admits a scope an on-by-default bundle's wildcard reaches", async () => {
    // The producer half, end to end. `core.*:write` is ticked by default, so
    // the user gets `core.task:write` by leaving the consent screen alone.
    // Withholding that literal here refused a device flow over a scope the
    // other surface grants without being asked.
    await withBundles(
      [
        bundle("write", true, ["core.*:write"]),
        bundle("manage", false, ["core.task:write"]),
      ],
      async () => {
        ctx = await createTestContext();
        const clientId = await createClient(ctx);

        const res = await tryInit(ctx, clientId, "core.task:write");
        expect(res.status).toBe(200);
        expect(res.body.device_code).toBeTruthy();
      },
    );
  });

  it("names one withheld scope rather than the operator's whole set", async () => {
    // The refusal answers an unauthenticated caller, and which scopes an
    // operator withheld is not otherwise public: discovery advertises
    // `scopes_supported` and carries no `default_on`. Joining every reached
    // scope would hand the partition back in one response, so a wildcard
    // reaching two withheld scopes must still name only one — enumeration
    // stays at a request per scope, as it is for the refusals beside it.
    await withBundles(
      [
        bundle("read", true, ["core.note:read"]),
        bundle("manage", false, ["core.task:write", "core.note:write"]),
      ],
      async () => {
        ctx = await createTestContext();
        const clientId = await createClient(ctx);

        const res = await tryInit(ctx, clientId, "core.*:write");
        expect(res.status).toBe(400);
        const message = (res.body.error as { message?: string }).message ?? "";
        const named = ["core.task:write", "core.note:write"].filter((s) =>
          message.includes(s),
        );
        expect(named).toHaveLength(1);
      },
    );
  });

  it("keeps a request clear of the withheld set working", async () => {
    // The control. Withholding is not "an off-by-default bundle exists", it
    // is this scope, so a neighboring scope still initiates.
    await withBundles(
      [
        bundle("read", true, ["core.note:read"]),
        bundle("manage", false, ["core.task:write"]),
      ],
      async () => {
        ctx = await createTestContext();
        const clientId = await createClient(ctx);

        const res = await tryInit(ctx, clientId, "core.note:read");
        expect(res.status).toBe(200);
      },
    );
  });
});

/**
 * The device code is bound to its grant inside the same consent lock that
 * created it.
 *
 * **The window this closes, stated as the sequence that produced it.** The
 * grant write held the lock and the binding ran after it was released. A
 * revoke taking the lock in that gap ran its whole cascade — including
 * `deleteDeviceCodesForGrant`, which is keyed on `connection_item_id` — past a
 * code whose grant reference was still null, so the sweep matched nothing.
 * The binding then attached that code to a grant that had just been revoked,
 * and it succeeded because revocation deletes device codes rather than
 * flipping their status, leaving the `status = 'pending'` predicate satisfied.
 *
 * **Asserted through the lock rather than by racing two requests.** A race
 * test that loses its race leaves the same end state as one that never
 * raced, so it keeps passing and quietly stops covering anything. Observing
 * that the binding happens while the lock is held is the property itself.
 */
describe("POST /auth/device/consent binds the code inside the consent lock", () => {
  afterEach(() => {
    setConsentLockBackend(null);
  });

  it("holds the lock across the binding, not only across the grant write", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await createClient(ctx);
    const cookie = await signInAndCookie(
      ctx,
      "device-lock@example.com",
      "correct horse",
    );

    // The backend is composed inside the in-process queue, so this flag is
    // true for exactly the span the lock is held.
    let lockHeld = false;
    setConsentLockBackend(async (_key, fn) => {
      lockHeld = true;
      try {
        return await fn();
      } finally {
        lockHeld = false;
      }
    });

    const oauth = ctx.storage.oauth;
    const realApprove = oauth.approveDeviceCode.bind(oauth);
    let heldAtBinding: boolean | undefined;
    oauth.approveDeviceCode = async (codeId: string, grantId: string) => {
      heldAtBinding = lockHeld;
      return realApprove(codeId, grantId);
    };

    const init = await initiate(ctx, clientId, "core.note:read");
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/device/consent`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
          cookie,
        },
        body: new URLSearchParams({
          user_code: init.user_code,
          decision: "approve",
        }).toString(),
      }),
    );
    expect(res.status).toBe(200);

    // Undefined would mean the binding never ran at all, which would pass a
    // naive truthiness check while covering nothing.
    expect(heldAtBinding).toBe(true);
  });
});
