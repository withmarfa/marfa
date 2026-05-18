import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import {
  renderSecurityPage,
  type SecurityPageGrant,
  type SecurityPageSession,
} from "./security-page.js";

/**
 * Wave C PR7 / T-031 — security page renderer + handler smoke. Full
 * round-trip (sign-in cookie → /auth/security → revoke → reload)
 * lives in `security-flow.test.ts`; this file covers the renderer
 * states + the route auth gate.
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

const SAMPLE_GRANT: SecurityPageGrant = {
  id: "grant-abc",
  client_name: "Test CLI",
  client_id: "client-1",
  scopes: ["core.note:read", "core.task:write"],
  granted_at: "2026-05-01T10:00:00Z",
  last_used_at: "2026-05-05T14:30:00Z",
};

const SAMPLE_SESSION: SecurityPageSession = {
  id: "session-1",
  created_at: "2026-05-01T10:00:00Z",
  last_active_at: "2026-05-06T18:00:00Z",
  is_current: false,
  ip_address: "203.0.113.1",
  user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ...",
};

describe("renderSecurityPage", () => {
  it("links to the shared stylesheet and uses the wide card variant", () => {
    const html = renderSecurityPage({
      email: "alice@example.com",
      grants: [],
      sessions: [],
    });
    expect(html).toContain(
      '<link rel="stylesheet" href="/auth/static/auth.css">',
    );
    expect(html).toContain('class="card card--wide"');
  });

  it("renders the user's email + connected-apps + active-sessions sections", () => {
    const html = renderSecurityPage({
      email: "alice@example.com",
      grants: [SAMPLE_GRANT],
      sessions: [SAMPLE_SESSION],
    });
    expect(html).toContain("alice@example.com");
    expect(html).toContain("Connected apps");
    expect(html).toContain("Active sessions");
    expect(html).toContain("Test CLI");
    expect(html).toContain("core.note:read");
    expect(html).toContain("core.task:write");
  });

  it("renders the empty-state copy when no grants exist", () => {
    const html = renderSecurityPage({
      email: "alice@example.com",
      grants: [],
      sessions: [SAMPLE_SESSION],
    });
    expect(html).toContain("No third-party apps");
  });

  it("renders a Revoke form per grant + the Sign out everywhere form", () => {
    const html = renderSecurityPage({
      email: "alice@example.com",
      grants: [SAMPLE_GRANT],
      sessions: [SAMPLE_SESSION],
    });
    expect(html).toContain('action="/auth/grants/grant-abc/revoke"');
    expect(html).toContain('action="/auth/sessions/session-1/revoke"');
    expect(html).toContain('action="/auth/sessions/sign-out-all"');
  });

  it("disables the per-session Revoke for the current session and tags it", () => {
    const html = renderSecurityPage({
      email: "alice@example.com",
      grants: [],
      sessions: [{ ...SAMPLE_SESSION, is_current: true }],
    });
    expect(html).toContain("current device");
    expect(html).toContain('class="tag tag--current"');
    // No per-session revoke form for the current session.
    expect(html).not.toContain('action="/auth/sessions/session-1/revoke"');
    // The disabled button still renders so the user sees it exists.
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Revoke<\/button>/);
  });

  it("surfaces a notice banner when supplied", () => {
    const html = renderSecurityPage({
      email: "alice@example.com",
      grants: [],
      sessions: [],
      notice: { kind: "success", text: "App access revoked." },
    });
    expect(html).toContain('class="banner banner--success"');
    expect(html).toContain('role="status"');
    expect(html).toContain("App access revoked.");
  });

  it("renders ip + UA hint per session", () => {
    const html = renderSecurityPage({
      email: "alice@example.com",
      grants: [],
      sessions: [SAMPLE_SESSION],
    });
    expect(html).toContain("203.0.113.1");
    expect(html).toContain("Mac");
  });

  it("escapes user-controlled fields in the rendered output", () => {
    const html = renderSecurityPage({
      email: '"><script>x</script>',
      grants: [
        { ...SAMPLE_GRANT, client_name: "<img src=x onerror=alert(1)>" },
      ],
      sessions: [SAMPLE_SESSION],
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });
});

describe("GET /auth/security", () => {
  it("redirects to /auth/sign-in when no session cookie is present", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/auth/security", {
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/auth\/sign-in\?return_to=/);
  });
});

describe("POST /auth/grants/:id/revoke + /auth/sessions/:id/revoke gates", () => {
  it("session-revoke redirects to sign-in when no session", async () => {
    ctx = await createTestContext();
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/sessions/x/revoke`, {
        method: "POST",
        headers: { origin: ORIGIN },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/auth\/sign-in/);
  });

  it("sign-out-all redirects to sign-in when no session", async () => {
    ctx = await createTestContext();
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/sessions/sign-out-all`, {
        method: "POST",
        headers: { origin: ORIGIN },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/auth\/sign-in/);
  });

  it("grant-revoke redirects to sign-in when no session", async () => {
    ctx = await createTestContext();
    const res = await ctx.app.fetch(
      new Request(`${ORIGIN}/auth/grants/x/revoke`, {
        method: "POST",
        headers: { origin: ORIGIN },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/auth\/sign-in/);
  });
});
