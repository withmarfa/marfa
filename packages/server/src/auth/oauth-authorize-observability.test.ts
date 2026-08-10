/**
 * The authorize endpoint's failures produce a signal.
 *
 * A total sign-in outage ran on production for days and the observability
 * pipeline recorded nothing unusual. Every failed authorization logged as
 * `GET /auth/oauth2/authorize`, `status: 302`, `severity_text: info`,
 * `error_code: null` — byte-identical to a success.
 *
 * Three mechanisms compounded, and each would have been enough alone:
 *
 *   - The plugin signals failure with `throw ctx.redirect(...)`, which
 *     `better-call` converts to a `Response` before Hono sees it. So
 *     `app.onError` never runs, the 100%-on-error trace sampling never
 *     triggers, and a fleet alert keyed on `level='error'` cannot fire.
 *   - The request logger records the path but not the query string, and
 *     `error=invalid_scope` lives only in the redirect's `Location`.
 *   - The endpoint answers 302 on every outcome, so status separates nothing.
 *
 * These tests assert on what the logger was actually called with, because
 * that is the artefact an operator or an alert consumes. Asserting that a
 * function ran would not have caught any of the three failures above.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  createTestContext,
  markEmailVerified,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import * as logger from "../middleware/logger.js";
import { AUTHORIZE_REFUSED_MESSAGE } from "./oauth-provider.js";

vi.setConfig({ testTimeout: 45_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";
const CALLBACK = "http://localhost:0/callback";

interface LoggedLine {
  level: string;
  message: string;
  data?: Record<string, unknown>;
}

/** Capture every `log()` call rather than reading stdout, so an assertion
 *  names the level and the structured fields an alert would filter on. */
function captureLogs(): LoggedLine[] {
  const lines: LoggedLine[] = [];
  vi.spyOn(logger, "log").mockImplementation((level, message, data) => {
    lines.push({ level, message, data });
  });
  return lines;
}

function authorizeLines(lines: LoggedLine[]): LoggedLine[] {
  return lines.filter((l) => l.message === AUTHORIZE_REFUSED_MESSAGE);
}

async function seedClient(
  c: TestContext,
  scopes: readonly string[] | null,
): Promise<string> {
  const clientId = `obs-${randomBytes(5).toString("hex")}`;
  const oauth = c.storage.oauthProvider;
  if (!oauth) throw new Error("storage.oauthProvider missing");
  await oauth.createClient({
    clientId,
    name: "Observability Test Client",
    isPublic: true,
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    scopes,
    redirectUris: [CALLBACK],
    postLogoutRedirectUris: [ORIGIN + "/"],
    referenceId: null,
  });
  return clientId;
}

async function signInUser(c: TestContext, email: string): Promise<string> {
  const password = "correct horse battery";
  const up = await request(c.app, "POST", "/auth/sign-up/email", {
    body: { email, password, name: "Test User" },
    headers: { origin: ORIGIN },
  });
  if (up.status !== 200) throw new Error(`sign-up failed ${String(up.status)}`);
  await markEmailVerified(c.storage, email);
  const inRes = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  if (inRes.status !== 200) {
    throw new Error(`sign-in failed ${String(inRes.status)}`);
  }
  const setCookie = inRes.headers.get("set-cookie") ?? "";
  for (const part of setCookie.split(/,\s*(?=[a-zA-Z0-9_-]+=)/)) {
    const head = part.split(";")[0];
    if (head?.includes("session_token")) return head;
  }
  throw new Error("session_token cookie not found");
}

function authorizeUrl(
  clientId: string,
  scope: string,
  extra = "",
  redirectUri = CALLBACK,
): string {
  const challenge = createHash("sha256")
    .update(randomBytes(32).toString("base64url"))
    .digest("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state: "obs-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `/auth/oauth2/authorize?${params.toString()}${extra}`;
}

/** Register a client whose redirect URI carries a fixed query of its own.
 *  Registration does not forbid one and dynamic registration is open, so
 *  this is a shape a stranger can create. */
async function seedClientWithRedirect(
  c: TestContext,
  redirectUri: string,
  scopes: readonly string[] | null,
): Promise<string> {
  const clientId = `obs-${randomBytes(5).toString("hex")}`;
  const oauth = c.storage.oauthProvider;
  if (!oauth) throw new Error("storage.oauthProvider missing");
  await oauth.createClient({
    clientId,
    name: "Fixed-Query Redirect Client",
    isPublic: true,
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    scopes: scopes === null ? null : [...scopes],
    redirectUris: [redirectUri],
    postLogoutRedirectUris: [ORIGIN + "/"],
    referenceId: null,
  });
  return clientId;
}

/**
 * Run the first-consent dance so a later authorize issues a code straight to
 * the client's callback. That second request is the only path that reaches
 * the guard at all: without a standing consent row the plugin redirects to
 * the consent page instead, where no top-level `error` is ever visible.
 */
async function grantConsent(
  c: TestContext,
  clientId: string,
  cookie: string,
  redirectUri: string,
  scope: string,
): Promise<void> {
  const res = await request(
    c.app,
    "GET",
    authorizeUrl(clientId, scope, "", redirectUri),
    { headers: { cookie } },
  );
  expect(res.status).toBe(302);
  const location = res.headers.get("location") ?? "";
  expect(location).toContain("/auth/authorize?");
  const signedQuery = location.slice(location.indexOf("?") + 1);

  const decision = await request(c.app, "POST", "/auth/authorize/decision", {
    form: {
      accept: "true",
      oauth_query: signedQuery,
      scopes: scope.split(" "),
    },
    headers: { cookie, origin: ORIGIN },
  });
  expect(decision.status).toBe(302);
  const callback = new URL(decision.headers.get("location") ?? "");
  expect(callback.searchParams.get("code")).toBeTruthy();
}

describe("authorize failures are observable", () => {
  it("an unsatisfiable request logs at a visible level carrying the error code", async () => {
    ctx = await createTestContext({ authMode: "hosted" });
    const cookie = await signInUser(ctx, "obs-invalid@example.com");
    // A ceiling that permits nothing, so narrowing declines and the plugin's
    // own invalid_scope fires — the production failure shape.
    const clientId = await seedClient(ctx, []);
    const lines = captureLogs();

    const res = await request(
      ctx.app,
      "GET",
      authorizeUrl(clientId, "openid core.note:read"),
      { headers: { cookie } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("error=invalid_scope");

    const logged = authorizeLines(lines);
    expect(logged).toHaveLength(1);
    // `info` is what the outage produced and why nobody saw it.
    expect(logged[0]?.level).toBe("warn");
    expect(logged[0]?.data?.error_code).toBe("invalid_scope");
    expect(logged[0]?.data?.client_id).toBe(clientId);
    // The description names which scopes were at fault. Without it the line
    // says a request failed but not what to go and fix.
    expect(String(logged[0]?.data?.error_description)).toContain(
      "core.note:read",
    );
  });

  it("does not log when the authorization succeeds", async () => {
    ctx = await createTestContext({ authMode: "hosted" });
    const cookie = await signInUser(ctx, "obs-ok@example.com");
    const clientId = await seedClient(ctx, null);
    const lines = captureLogs();

    const res = await request(
      ctx.app,
      "GET",
      authorizeUrl(clientId, "openid core.note:read"),
      { headers: { cookie } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("/auth/authorize?");
    // A success is also a 302, which is exactly why the status could never
    // have been the signal.
    expect(authorizeLines(lines)).toHaveLength(0);
  });

  it("logs ordinary flow control at info, not as a fault", async () => {
    ctx = await createTestContext({ authMode: "hosted" });
    const clientId = await seedClient(ctx, null);
    const lines = captureLogs();

    // `prompt=none` with no session is the protocol working: the client asked
    // whether it could proceed silently and was told no. Reporting that at
    // `warn` would bury the failures that matter under routine traffic.
    const res = await request(
      ctx.app,
      "GET",
      authorizeUrl(clientId, "openid", "&prompt=none"),
      {},
    );
    expect(res.status).toBe(302);

    const logged = authorizeLines(lines);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.level).toBe("info");
    expect(logged[0]?.data?.error_code).toBe("login_required");
  });

  it("logs a refusal the plugin returns rather than throws", async () => {
    ctx = await createTestContext({ authMode: "hosted" });
    const cookie = await signInUser(ctx, "obs-json@example.com");
    const clientId = await seedClient(ctx, []);
    const lines = captureLogs();

    // The plugin only THROWS its redirect for a browser navigation. For a
    // `fetch` — or anything asking for JSON — it RETURNS `{redirect, url}`
    // with no headers at all. That covers the first-party app's post-sign-in
    // resume and every silent-renewal probe, so reading only the thrown shape
    // left the common path invisible while the tests all passed.
    const res = await request(
      ctx.app,
      "GET",
      authorizeUrl(clientId, "openid core.note:read"),
      { headers: { cookie, accept: "application/json" } },
    );
    expect(res.status).toBeLessThan(500);

    const logged = authorizeLines(lines);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.level).toBe("warn");
    expect(logged[0]?.data?.error_code).toBe("invalid_scope");
  });

  it("stays silent when a success lands on a redirect URI that itself carries error=", async () => {
    ctx = await createTestContext({ authMode: "hosted" });
    const cookie = await signInUser(ctx, "obs-poison@example.com");

    // Registration does not forbid a query on a redirect URI, and
    // unauthenticated dynamic registration is on. Without the guard, every
    // successful sign-in through such a client emits a refusal carrying an
    // error code of the registrant's choosing — a way to drown the signal in
    // noise precisely when it matters.
    const poisoned = `${CALLBACK}?error=invalid_scope&error_description=chosen`;
    const clientId = await seedClientWithRedirect(ctx, poisoned, null);

    // Consent first. A client with no standing grant is redirected to the
    // consent page, where the request never reaches its own callback and no
    // top-level `error` exists to be misread — so an assertion made on that
    // path runs against an empty line set and holds no matter what the guard
    // does.
    await grantConsent(ctx, clientId, cookie, poisoned, "openid");

    const lines = captureLogs();
    const res = await request(
      ctx.app,
      "GET",
      authorizeUrl(clientId, "openid", "", poisoned),
      { headers: { cookie } },
    );

    expect(res.status).toBe(302);
    const target = new URL(res.headers.get("location") ?? "");
    // Proves the branch was reached: a code was issued to the client's own
    // callback, alongside the `error` the client registered there.
    expect(target.searchParams.get("code")).toBeTruthy();
    expect(target.searchParams.get("error")).toBe("invalid_scope");

    expect(authorizeLines(lines)).toHaveLength(0);
  });

  it("does not let a client that registers code= silence its own refusals", async () => {
    ctx = await createTestContext({ authMode: "hosted" });
    const cookie = await signInUser(ctx, "obs-silencer@example.com");

    // The inverse of the case above, and the more dangerous one: reading the
    // mere presence of `code` hands any registrant a switch for this signal.
    // Register a callback carrying one and every genuine refusal goes
    // unlogged, which is a false negative on exactly the counter a total
    // sign-in outage is measured by.
    const silencing = `${CALLBACK}?code=fixed`;
    const clientId = await seedClientWithRedirect(ctx, silencing, []);

    const lines = captureLogs();
    const res = await request(
      ctx.app,
      "GET",
      authorizeUrl(clientId, "openid core.note:read", "", silencing),
      { headers: { cookie } },
    );

    expect(res.status).toBe(302);
    const target = new URL(res.headers.get("location") ?? "");
    expect(target.searchParams.get("error")).toBe("invalid_scope");
    expect(target.searchParams.get("code")).toBe("fixed");

    const logged = authorizeLines(lines);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.data?.error_code).toBe("invalid_scope");
  });

  it("separates the two by error code, not by whether one happened", async () => {
    ctx = await createTestContext({ authMode: "hosted" });
    const cookie = await signInUser(ctx, "obs-both@example.com");
    const refusing = await seedClient(ctx, []);
    const healthy = await seedClient(ctx, null);
    const lines = captureLogs();

    await request(ctx.app, "GET", authorizeUrl(refusing, "openid"), {
      headers: { cookie },
    });
    // `prompt=none` is what turns "no session" into an error redirect at all.
    // Without it the plugin bounces to the login page, which is not a failure
    // and correctly produces no line.
    await request(
      ctx.app,
      "GET",
      authorizeUrl(healthy, "openid", "&prompt=none"),
      {},
    );

    const logged = authorizeLines(lines);
    const byLevel = new Map(logged.map((l) => [l.data?.error_code, l.level]));
    expect(byLevel.get("invalid_scope")).toBe("warn");
    expect(byLevel.get("login_required")).toBe("info");
  });
});

/**
 * The alert is the consumer, and the consumer is in another language.
 *
 * `.github/observability/` runs standalone on a CI runner with no install
 * step, so it cannot import this constant and has to carry a copy. A copy
 * that drifts does not fail loudly: the counter simply matches nothing, stays
 * at zero forever, and the alert reads as healthy while blind — which is the
 * exact failure mode the whole signal exists to end. So the agreement is
 * pinned from this side, where the string is defined.
 */
describe("the fleet alert counts the message this server actually logs", () => {
  it("the built query counts this exact literal", async () => {
    // Importing the alert module and asking it to build its query is the only
    // check that means anything here: the query is assembled from a template
    // literal, so the source text holds `${AUTHORIZE_REFUSED_MESSAGE}` rather
    // than the string, and grepping the file would pass against a copy that
    // had drifted.
    const alertUrl = new URL(
      "../../../../.github/observability/posthog.mjs",
      import.meta.url,
    );
    const alert = (await import(alertUrl.href)) as {
      buildTelemetryQuery: () => string;
    };
    const query = alert.buildTelemetryQuery();
    expect(query).toContain(`countIf(message = '${AUTHORIZE_REFUSED_MESSAGE}'`);
    // Only the actionable half. Folding the `info` records in would make the
    // counter track traffic rather than trouble.
    expect(query).toContain("AND level = 'warn'");
  });
});
