import { describe, it, expect, afterEach } from "vitest";
import {
  createTestContext,
  markEmailVerified,
  request,
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

afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

async function createClient(c: TestContext): Promise<string> {
  const res = await request(c.app, "POST", "/auth/clients", {
    body: { name: "Test CLI", redirect_uris: ["http://localhost:0/callback"] },
    headers: { origin: ORIGIN },
    key: c.adminKey,
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
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
  // Wave C PR2: requireEmailVerification blocks sign-in until the
  // verify link is clicked. Stand-in for that here.
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

    expect(result.device_code).toMatch(/^myme_dc_/);
    expect(result.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(result.verification_uri).toMatch(/\/auth\/device$/);
    // T-096: complete URI must carry the issued user_code (URL-encoded
    // since the canonical form has a hyphen) so the verification page
    // can pre-fill from `?user_code=`.
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

  it("pre-fills the user_code from ?user_code=X", async () => {
    ctx = await createTestContext();
    const res = await request(
      ctx.app,
      "GET",
      "/auth/device?user_code=ABCD-EFGH",
      { headers: { origin: ORIGIN } },
    );
    const html = await res.text();
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
    expect(html).toContain("wasn&#39;t recognised");
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

  it("normalises user_code without hyphen to canonical form", async () => {
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
    expect(poll.body.access_token).toMatch(/^myme_at_/);
    expect(poll.body.refresh_token).toMatch(/^myme_rt_/);
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
    const poll = await pollToken(ctx, "myme_dc_unknown", clientId);
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
          device_code: "myme_dc_x",
          client_id: "x",
        }).toString(),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });
});
