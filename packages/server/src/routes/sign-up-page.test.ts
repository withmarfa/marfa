import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Hono } from "hono";
import {
  createPgTestStorage,
  createTestContext,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { renderSignUpPage } from "./sign-up-page.js";
import { createApp } from "../app.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { FilesystemBlobBackend } from "../storage/blob-backend.js";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";

/**
 * Smoke tests for GET /auth/sign-up (HTML page) + the POST /auth/sign-up
 * form-handler that wraps Better Auth's POST /auth/sign-up/email. Coverage:
 *   - GET 200 + text/html when allowSignup=true
 *   - GET 404 when allowSignup=false
 *   - POST 302 with auto-sign-in cookie on success
 *   - POST 302 + error=email_exists when email is taken
 *   - POST 302 + error=password_mismatch / weak_password / missing_field / email_invalid
 *   - POST 404 when allowSignup=false (defense-in-depth past the GET gate)
 *   - return_to round-trips through the form
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

describe("renderSignUpPage", () => {
  it("renders form with email + name + password + password_confirm fields", () => {
    const html = renderSignUpPage({ returnTo: "/" });
    expect(html).toContain('<form method="POST" action="/auth/sign-up"');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="name"');
    expect(html).toContain('name="password"');
    expect(html).toContain('name="password_confirm"');
    expect(html).toContain("Create account");
  });

  it("loads the password-toggle script", () => {
    const html = renderSignUpPage({ returnTo: "/" });
    expect(html).toContain(
      '<script src="/auth/static/password-toggle.js"></script>',
    );
  });

  it("repopulates email, name, and username from values, escaped", () => {
    const html = renderSignUpPage({
      returnTo: "/",
      error: "handle_taken",
      values: {
        email: "second@example.com",
        name: "Ann & Bob <x>",
        username: "shared",
      },
    });
    expect(html).toContain('value="second@example.com"');
    expect(html).toContain('value="shared"');
    // The name is escaped into the value attribute, never injected raw.
    expect(html).toContain('value="Ann &amp; Bob &lt;x&gt;"');
    expect(html).not.toContain("Ann & Bob <x>");
  });

  it("renders empty value attributes when no values are supplied", () => {
    const html = renderSignUpPage({ returnTo: "/" });
    expect(html).toMatch(/name="email"\s+value=""/);
    expect(html).toMatch(/name="username"\s+value=""/);
  });

  it("preserves return_to in the form's hidden field", () => {
    const html = renderSignUpPage({
      returnTo: "/auth/authorize?client_id=abc",
    });
    expect(html).toContain(
      '<input type="hidden" name="return_to" value="/auth/authorize?client_id=abc">',
    );
  });

  it("renders email_exists as a field-level error under the email input", () => {
    const html = renderSignUpPage({
      returnTo: "/",
      error: "email_exists",
    });
    // email_exists maps to the email field, so it renders inline there, not as
    // a top banner.
    expect(html).toContain('class="field field--error"');
    expect(html).toContain('class="field__error"');
    expect(html).toContain("already exists");
    expect(html).not.toContain('class="banner banner--error"');
  });

  it("maps weak_password / password_mismatch / handle errors to their fields", () => {
    const weak = renderSignUpPage({ returnTo: "/", error: "weak_password" });
    expect(weak).toContain('class="field__error"');
    expect(weak).toContain("at least 8 characters");
    expect(weak).not.toContain('class="banner banner--error"');

    const handle = renderSignUpPage({ returnTo: "/", error: "handle_taken" });
    expect(handle).toContain('class="field__error"');
    expect(handle).toContain("already taken");
    expect(handle).not.toContain('class="banner banner--error"');
  });

  it("keeps non-field errors (missing_field, unknown) in the top banner", () => {
    const missing = renderSignUpPage({ returnTo: "/", error: "missing_field" });
    expect(missing).toContain('class="banner banner--error"');
    expect(missing).toContain('role="alert"');
    expect(missing).toContain("fill in every field");

    const html = renderSignUpPage({ returnTo: "/", error: "unknown_code" });
    expect(html).toContain('class="banner banner--error"');
    expect(html).toContain("Something went wrong");
  });

  it("drops the username hint and renders at the standard (non-wide) width", () => {
    const html = renderSignUpPage({ returnTo: "/" });
    // The username field-hint copy is gone; native pattern validation remains.
    expect(html).not.toContain("Public");
    expect(html).not.toContain("used as your handle");
    expect(html).toContain('pattern="[a-z0-9]');
    // Standard width — no card--wide modifier.
    expect(html).not.toContain("card--wide");
    expect(html).toContain('<main class="card"');
  });

  it("loads the submit-state script and labels the create button", () => {
    const html = renderSignUpPage({ returnTo: "/" });
    expect(html).toContain(
      '<script src="/auth/static/submit-state.js"></script>',
    );
    expect(html).toContain('data-loading-label="Creating account..."');
    // Continue / Back stay type=button so the loading script never fires on
    // them.
    expect(html).toContain('type="button" class="btn btn--primary" data-next');
  });

  it("gives the username field a friendly inline validation message", () => {
    // The username pattern's generic validity message reads poorly; the inline
    // validator uses this override instead of the browser's native bubble.
    const html = renderSignUpPage({ returnTo: "/" });
    expect(html).toContain(
      'data-validate-msg="Use 3 to 32 lowercase letters, numbers, or hyphens."',
    );
  });

  it("escapes HTML in returnTo to prevent template injection", () => {
    const html = renderSignUpPage({
      returnTo: '/foo"><script>alert(1)</script>',
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("links to /auth/static/auth.css and carries no inline <style>", () => {
    const html = renderSignUpPage({ returnTo: "/" });
    expect(html).toContain(
      '<link rel="stylesheet" href="/auth/static/auth.css">',
    );
    expect(html).not.toContain("<style>");
  });

  it("renders a sign-in link with return_to preserved", () => {
    const html = renderSignUpPage({
      returnTo: "/auth/authorize?client_id=abc",
    });
    expect(html).toContain('href="/auth/sign-in?return_to=');
  });
});

describe("GET /auth/sign-up", () => {
  it("returns 200 + text/html when allowSignup=true", async () => {
    ctx = await createTestContext({
      authAllowSignup: true,
      authRequireEmailVerification: true,
    });
    const res = await request(ctx.app, "GET", "/auth/sign-up", {
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("Create your Marfa account");
  });

  it("returns 404 when allowSignup=false", async () => {
    ctx = await createTestContext({ authAllowSignup: false });
    const res = await request(ctx.app, "GET", "/auth/sign-up", {
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(404);
  });

  it("§3.18: returns Cache-Control: no-store + Pragma: no-cache", async () => {
    ctx = await createTestContext({
      authAllowSignup: true,
      authRequireEmailVerification: true,
    });
    const res = await request(ctx.app, "GET", "/auth/sign-up", {
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "no-store, no-cache, private",
    );
    expect(res.headers.get("pragma")).toBe("no-cache");
  });

  it("preserves return_to from query in the hidden field", async () => {
    ctx = await createTestContext({
      authAllowSignup: true,
      authRequireEmailVerification: true,
    });
    const returnTo = "/auth/authorize?client_id=abc";
    const res = await request(
      ctx.app,
      "GET",
      `/auth/sign-up?return_to=${encodeURIComponent(returnTo)}`,
      { headers: { origin: ORIGIN } },
    );
    const html = await res.text();
    expect(html).toContain(
      `<input type="hidden" name="return_to" value="${returnTo
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")}">`,
    );
  });
});

describe("POST /auth/sign-up (form wrapper)", () => {
  async function postSignUpForm(
    c: TestContext,
    fields: Record<string, string>,
  ): Promise<Response> {
    return c.app.fetch(
      new Request(`${ORIGIN}/auth/sign-up`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
        },
        body: new URLSearchParams(fields).toString(),
      }),
    );
  }

  it("returns 404 when allowSignup=false", async () => {
    ctx = await createTestContext({ authAllowSignup: false });
    const res = await postSignUpForm(ctx, {
      email: "alice@example.com",
      name: "Alice",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "/",
    });
    expect(res.status).toBe(404);
  });

  it("redirects to error=missing_field when fields are blank", async () => {
    ctx = await createTestContext({
      authAllowSignup: true,
      authRequireEmailVerification: true,
    });
    const res = await postSignUpForm(ctx, {
      email: "",
      name: "",
      password: "",
      password_confirm: "",
      return_to: "/",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=missing_field");
  });

  it("redirects to error=password_mismatch when passwords differ", async () => {
    ctx = await createTestContext({
      authAllowSignup: true,
      authRequireEmailVerification: true,
    });
    const res = await postSignUpForm(ctx, {
      email: "alice@example.com",
      name: "Alice",
      username: "alice",
      password: "correct horse",
      password_confirm: "different",
      return_to: "/",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=password_mismatch");
  });

  it("redirects to error=weak_password when password is too short", async () => {
    ctx = await createTestContext({
      authAllowSignup: true,
      authRequireEmailVerification: true,
    });
    const res = await postSignUpForm(ctx, {
      email: "alice@example.com",
      name: "Alice",
      username: "alice",
      password: "short",
      password_confirm: "short",
      return_to: "/",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=weak_password");
  });

  it("redirects to error=email_invalid when email is malformed", async () => {
    ctx = await createTestContext({
      authAllowSignup: true,
      authRequireEmailVerification: true,
    });
    const res = await postSignUpForm(ctx, {
      email: "not-an-email",
      name: "Alice",
      username: "alice",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "/",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=email_invalid");
  });

  it("redirects to /auth/verify-email on successful sign-up (no auto-sign-in cookie)", async () => {
    // With requireEmailVerification: true, better-auth suppresses
    // autoSignIn — sign-up returns 200 + { token: null, user } and
    // no Set-Cookie. The wrapper detects the missing cookie and
    // redirects to the verify-email page so the user knows what to
    // do next.
    ctx = await createTestContext({
      authAllowSignup: true,
      authRequireEmailVerification: true,
    });
    const res = await postSignUpForm(ctx, {
      email: "alice@example.com",
      name: "Alice",
      username: "alice",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "/auth/authorize?client_id=abc",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/auth/verify-email");
    expect(location).toContain("email=alice%40example.com");
    expect(location).toContain("return_to=%2Fauth%2Fauthorize");
    // No session cookie set on the verification-required path.
    const cookies =
      typeof (res.headers as Headers & { getSetCookie?: () => string[] })
        .getSetCookie === "function"
        ? (
            res.headers as Headers & { getSetCookie: () => string[] }
          ).getSetCookie()
        : [res.headers.get("set-cookie") ?? ""];
    expect(cookies.some((c) => c.includes("marfa.auth"))).toBe(false);
  });

  it("duplicate sign-up follows the generic-duplicate-response path (no email enumeration)", async () => {
    // With requireEmailVerification: true, better-auth returns 200
    // (no cookie) on duplicate sign-ups so an attacker can't probe
    // whether an address has an account. The wrapper forwards that as
    // a verify-email redirect, identical to a fresh sign-up.
    ctx = await createTestContext({
      authAllowSignup: true,
      authRequireEmailVerification: true,
    });
    const first = await postSignUpForm(ctx, {
      email: "carol@example.com",
      name: "Carol",
      username: "carol",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "/",
    });
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toContain("/auth/verify-email");

    const second = await postSignUpForm(ctx, {
      email: "carol@example.com",
      name: "Carol Again",
      // A different (non-colliding) handle so the wrapper's pre-validation
      // pass doesn't bail with handle_taken before calling Better Auth —
      // exercising the real generic-duplicate-response branch.
      username: "carol-two",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "/",
    });
    expect(second.status).toBe(302);
    // Second attempt looks identical to the first — no `error=email_exists` leak.
    expect(second.headers.get("location")).toContain("/auth/verify-email");
    expect(second.headers.get("location")).not.toContain("error=email_exists");
  });

  // -------------------------------------------------------------------------
  // Username gating at sign-up.
  //
  // Each invariant here protects an attack class:
  //
  //   - reserved handles MUST NOT create an auth_user row (lest a
  //     determined attacker spam Better Auth with reserved-name attempts
  //     to confirm which words are reserved server-side via timing)
  //   - invalid handles MUST short-circuit before the upstream call
  //   - colliding handles likewise (otherwise users.create() throws and
  //     leaves an orphan auth_user)
  // -------------------------------------------------------------------------

  it("redirects to error=missing_field when username is blank", async () => {
    ctx = await createTestContext({
      authAllowSignup: true,
      authRequireEmailVerification: true,
    });
    const res = await postSignUpForm(ctx, {
      email: "alice@example.com",
      name: "Alice",
      username: "",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "/",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=missing_field");
  });

  it("redirects to error=handle_invalid on a malformed username", async () => {
    ctx = await createTestContext({
      authAllowSignup: true,
      authRequireEmailVerification: true,
    });
    const res = await postSignUpForm(ctx, {
      email: "alice@example.com",
      name: "Alice",
      username: "AB", // too short + uppercase
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "/",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=handle_invalid");
  });

  // Collision + provisioning cases need hosted-mode storage (the keys-
  // mode default has no `users` table, so the collision check skips).
  // Covered by separate describe blocks below; they each spin up a
  // hosted fixture inline.

  it("rejects unsafe return_to values and falls back to / (threaded through the verify-email redirect)", async () => {
    ctx = await createTestContext({
      authAllowSignup: true,
      authRequireEmailVerification: true,
    });
    const res = await postSignUpForm(ctx, {
      email: "dave@example.com",
      name: "Dave",
      username: "dave",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "https://evil.com/",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    // return_to was sanitized to "/" before the redirect built the
    // verify-email URL; the off-origin value never threads through.
    expect(location).toContain("/auth/verify-email");
    expect(location).toContain("return_to=%2F");
    expect(location).not.toContain("evil.com");
  });
});

// ---------------------------------------------------------------------------
// Hosted-mode-only sign-up coverage.
//
// The username-collision check + the space + users-row provisioning step
// only fire when storage.users is wired (hosted mode). The default
// createTestContext is keys mode, so these tests stand up a hosted fixture
// inline.
// ---------------------------------------------------------------------------

interface HostedSignUpContext {
  app: Hono<AppEnv>;
  storage: Storage;
  cleanup: () => Promise<void>;
}

async function createHostedSignUpContext(): Promise<HostedSignUpContext> {
  const dialect = process.env.DB_DIALECT ?? "sqlite";
  const tmpDir = mkdtempSync(join(tmpdir(), "marfa-signup-test-"));
  const blobPath = join(tmpDir, "blobs");

  let storage: Storage;
  let pgCleanup: (() => Promise<void>) | undefined;
  if (dialect === "pg") {
    const pg = await createPgTestStorage({ authMode: "hosted" });
    storage = pg.storage;
    pgCleanup = pg.cleanup;
  } else {
    const dbPath = join(tmpDir, "test.db");
    storage = await createSqliteStorage(dbPath, { authMode: "hosted" });
  }

  const blobBackend = new FilesystemBlobBackend(blobPath);
  const app = createApp(storage, blobBackend, {
    port: 0,
    storageDialect: dialect as "sqlite" | "pg",
    sqlitePath: "",
    databaseUrl: "",
    blobPath,
    blobBackend: "fs",
    maxBlobSize: 50 * 1024 * 1024,
    maxRequestBytes: 1_048_576,
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    apiKeySalt: "test-salt",
    corsOrigins: [],
    cdnBaseUrl: "",
    authMode: "hosted",
    rateLimitEnabled: false,
    enableHsts: false,
    auditRetentionDays: 90,
    auditCleanupIntervalMs: 86_400_000,
    eventLogRetentionHours: 168,
    versionThinningIntervalMs: 3_600_000,
    versionRecentDays: 30,
    versionDailySnapshotDays: 90,
    versionWeeklySnapshotDays: 365,
    versionMaxVersions: 500,
    trashRetentionDays: 60,
    trashPurgeIntervalMs: 3_600_000,
    errorWebhookUrl: "",
    trustedProxyCidrs: [],
    authBaseUrl: ORIGIN,
    authAllowSignup: true,
    seedStarterContent: false,
    authRequireEmailVerification: true,
    authSecret: "test-auth-secret",
    oidcProviders: [],
    rateLimitDefaultLimit: 1000,
    rateLimitWindowMs: 60_000,
    mcpEnabled: false,
  });

  return {
    app,
    storage,
    cleanup: async () => {
      if (pgCleanup) {
        await pgCleanup();
      } else {
        await storage.close();
      }
    },
  };
}

async function postHostedSignUp(
  ctx: HostedSignUpContext,
  fields: Record<string, string>,
): Promise<Response> {
  return ctx.app.fetch(
    new Request(`${ORIGIN}/auth/sign-up`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
      },
      body: new URLSearchParams(fields).toString(),
    }),
  );
}

describe("POST /auth/sign-up — hosted-mode invariants", () => {
  let hosted: HostedSignUpContext | undefined;

  afterEach(async () => {
    await hosted?.cleanup();
    hosted = undefined;
  });

  it("redirects to error=handle_taken when the username is already claimed", async () => {
    hosted = await createHostedSignUpContext();
    const first = await postHostedSignUp(hosted, {
      email: "first@example.com",
      name: "First",
      username: "shared",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "/",
    });
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toContain("/auth/verify-email");

    const second = await postHostedSignUp(hosted, {
      email: "second@example.com",
      name: "Second",
      username: "shared",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "/",
    });
    expect(second.status).toBe(302);
    expect(second.headers.get("location")).toContain("error=handle_taken");
  });

  it("preserves email, name, and username across a handle_taken bounce", async () => {
    hosted = await createHostedSignUpContext();
    await postHostedSignUp(hosted, {
      email: "first@example.com",
      name: "First",
      username: "shared",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "/",
    });
    const bounce = await postHostedSignUp(hosted, {
      email: "second@example.com",
      name: "Second User",
      username: "shared",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "/",
    });
    expect(bounce.status).toBe(302);
    expect(bounce.headers.get("location")).toContain("error=handle_taken");
    // The PII rides a cookie, never the URL (which lands in logs/history).
    expect(bounce.headers.get("location")).not.toContain("second@example.com");
    expect(bounce.headers.get("location")).not.toContain("Second");

    const setCookie = bounce.headers.get("set-cookie");
    expect(setCookie).toContain("marfa.signup_prefill=");
    expect(setCookie).toContain("HttpOnly");
    const cookie = (setCookie ?? "").split(";")[0];

    // Follow the redirect carrying the cookie: the form comes back filled.
    const page = await hosted.app.fetch(
      new Request(`${ORIGIN}/auth/sign-up?error=handle_taken`, {
        headers: { origin: ORIGIN, cookie },
      }),
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('value="second@example.com"');
    expect(html).toContain('value="Second User"');
    expect(html).toContain('value="shared"');
    // The password is never echoed back into the form.
    expect(html).not.toContain("correct horse");
    // Single-use: rendering the prefilled form clears the cookie.
    const cleared = page.headers.get("set-cookie") ?? "";
    expect(cleared).toContain("marfa.signup_prefill=");
    expect(cleared).toMatch(/Max-Age=0|Expires=/i);
  });

  it("provisions a `users` row + space + auth_user_id binding atomically", async () => {
    hosted = await createHostedSignUpContext();
    const res = await postHostedSignUp(hosted, {
      email: "newhuman@example.com",
      name: "New Human",
      username: "new-human",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "/",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/auth/verify-email");

    const userStore = hosted.storage.users;
    expect(userStore).toBeDefined();
    const row = await userStore!.getByHandle("new-human");
    expect(row).not.toBeNull();
    expect(row?.auth_user_id).toBeTruthy();
    expect(row?.space_id).toBeTruthy();
  });

  it("reserved-handle attempts never create an auth_user row", async () => {
    hosted = await createHostedSignUpContext();
    const res = await postHostedSignUp(hosted, {
      email: "alice@example.com",
      name: "Alice",
      username: "admin",
      password: "correct horse",
      password_confirm: "correct horse",
      return_to: "/",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=handle_reserved");

    // The invariant: pre-validation runs BEFORE forwarding to Better
    // Auth, so no auth_user row should exist. The SQLite path uses the
    // typed helper; the PG path drops to drizzle-orm directly because
    // there's no equivalent facade.
    const dialect = (hosted.storage as { betterAuthDialect?: string })
      .betterAuthDialect;
    let count: number | undefined;
    if (dialect === "pg") {
      const db = (
        hosted.storage as unknown as {
          pgDb?: { execute: (q: unknown) => Promise<unknown> };
        }
      ).pgDb;
      if (db) {
        const { sql } = await import("drizzle-orm");
        const rows = (await db.execute(
          sql`SELECT COUNT(*)::int AS n FROM auth_user`,
        )) as { n: number }[];
        count = rows[0]?.n;
      }
    } else {
      const rows = await (
        hosted.storage as unknown as {
          __sqliteAll?: (q: string) => Promise<{ n: number }[]>;
        }
      ).__sqliteAll?.("SELECT COUNT(*) as n FROM auth_user");
      count = rows?.[0]?.n;
    }
    expect(count).toBe(0);
  });
});
