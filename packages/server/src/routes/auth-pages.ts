import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  MymeError,
  ErrorCode,
  parseScope,
  expandWildcardScopes,
  isValidHandle,
  isReservedHandle,
  TYPE_REGISTRY,
} from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  hashApiKey,
  stampOAuthGrantLastUsed,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type {
  MymeAuth,
  MymeAuthSession,
  MymeAuthSessionUser,
} from "../auth/instance.js";
import {
  renderSignInPage,
  synthesizeOauthReturnTo,
  validateReturnTo,
} from "./sign-in-page.js";
import { renderSignUpPage } from "./sign-up-page.js";
import { renderVerifyEmailPage } from "./verify-email-page.js";
import { renderPasskeyEnrollPage } from "./passkey-enroll-page.js";
import { renderForgotPasswordPage } from "./forgot-password-page.js";
import { renderResetPasswordPage } from "./reset-password-page.js";
import {
  renderSecurityPage,
  type SecurityPageGrant,
  type SecurityPageSession,
} from "./security-page.js";
import { PerEmailThrottle } from "../auth/per-email-throttle.js";
import {
  renderDevicePage,
  renderDeviceConsentScreen,
  renderDeviceDecisionPage,
} from "./device-pages.js";
import { setNoStore } from "./no-store.js";
import { publish } from "../pubsub.js";
import type { OidcSigner } from "../auth/oidc-signing.js";

const ACCESS_TOKEN_PREFIX = "myme_at_";
const REFRESH_TOKEN_PREFIX = "myme_rt_";
const ACCESS_TOKEN_TTL_MS = 3600_000; // 1 hour

/**
 * Plain-English descriptions for the metadata-layer sub-resource scopes.
 * Type scopes pull their descriptions from `TYPE_REGISTRY`; these don't
 * correspond to a registered type, so they live alongside the route.
 */
const METADATA_SCOPE_DESCRIPTIONS: Record<string, string> = {
  metadata: "Read or write any metadata-layer resource",
  "metadata.types": "Register and update custom data types in your space",
};

/**
 * **T-074: standard OIDC scope literals.** Surfaced on the consent
 * screen so end-users see what the third-party app is asking for.
 * Mirrors what `/oauth/userinfo` actually returns when each scope is
 * granted. The literal `openid` is the OIDC marker that indicates the
 * client wants an ID token / userinfo lookup at all; `profile` and
 * `email` gate the field set.
 */
const OIDC_SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: "Confirm your identity",
  profile: "Your username, name, bio, and avatar",
  email: "Your email address",
};

function generateToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("hex")}`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

/**
 * Persist (or refresh) a `kind: app` connection through `ItemStore`. Routes
 * through `ItemStore.create` on first consent and `ItemStore.update` on
 * re-consent so the row gets full ItemStore treatment: `tenant_id`
 * stamping (T-004), search indexing, metadata-row insertion (so subsequent
 * setTags / setExtension actually write), versions snapshot on re-consent,
 * the `created`/`updated` event emission, and `source` / `origin`
 * stamping (T-005). Returns the connection-item id + whether the call
 * created vs updated the projection.
 *
 * F15 (T-131 review-sweep): pre-fix, this function ALWAYS inserted —
 * device-flow re-approval of the same client created duplicate
 * `system.connection` rows. Now uses `findGrantItemId` to detect the
 * re-consent case and routes through `items.update` (same shape as the
 * code-flow consent's `projectGrantOnConsent`). F3-equivalent treatment:
 * status flips to "active" + `revoked_at` is cleared on re-consent.
 *
 * `tenantId` resolves from the consenting Better Auth user's myme `users`
 * row in hosted mode; in single-tenant mode (no `users` store) the grant
 * is stamped tenant-less. Hosted mode without a provisioned tenant for the
 * authenticated user refuses outright — the OAuth flow can't honour a
 * grant without a tenant to scope it to.
 */
async function createUserAppGrant(
  storage: Storage,
  consentingUser: MymeAuthSessionUser,
  clientId: string,
  scopes: string[],
  source: "myme/oauth/authorize" | "myme/oauth/device",
): Promise<{ id: string; created: boolean }> {
  // T-144: cycle metadata flows through `cycleRequestContext` (set by
  // `cycleMiddleware`) — `publish()` reads it automatically. The
  // explicit `cycle` parameter was dead weight under the new shape.
  let tenantId: string | undefined;
  if (storage.users) {
    // T-074: lookup by Better Auth user id (the canonical bridge);
    // `users.email` no longer exists.
    const user = await storage.users.getByAuthUserId(consentingUser.id);
    tenantId = user?.tenant_id;
    if (!tenantId) {
      throw new MymeError(
        ErrorCode.UNAUTHORIZED,
        "No Myme tenant is provisioned for this account; complete onboarding first",
      );
    }
  }
  const now = new Date().toISOString();

  // F15: detect re-consent. Existing projection → update in place; else
  // insert. Mirrors `projectGrantOnConsent` from `routes/auth-consent.ts`.
  let existingItemId: string | null = null;
  if (typeof storage.oauthProvider?.findGrantItemId === "function") {
    existingItemId = await storage.oauthProvider.findGrantItemId({
      tenantId: tenantId ?? null,
      clientId,
      authUserId: consentingUser.id,
    });
  }

  if (existingItemId) {
    // Re-consent: items.update writes a versions snapshot + bumps
    // version. Flip status back to "active" + clear revoked_at (F3
    // equivalent for device-flow).
    const existing = await storage.items.get(existingItemId, tenantId);
    if (!existing) {
      // Race — findGrantItemId saw a row but a concurrent delete
      // raced. Fall through to insert.
    } else {
      const updated = await storage.items.update(
        existingItemId,
        {
          properties: {
            scopes,
            status: "active",
            granted_at: now,
            revoked_at: undefined,
          },
        },
        tenantId,
      );
      if (!("error" in updated)) {
        const metadata = await storage.metadata.get(updated.id);
        await publish({
          type: "updated",
          item: updated,
          metadata,
          tenantId,
        });
        return { id: updated.id, created: false };
      }
    }
  }

  // First-time consent: insert a fresh row.
  const item = await storage.items.create(
    {
      type: "system.connection",
      tier: "library",
      state: "active",
      properties: {
        kind: "app",
        client_id: clientId,
        // T-131: store the consenting auth_user id so cascade revoke
        // (/auth/grants/:id/revoke → revokeTokensForGrant(clientId, userId))
        // and the device-flow terminal step (which needs (clientId, userId)
        // to mint tokens against the plugin's tables) can find the user.
        user_id: consentingUser.id,
        scopes,
        status: "active",
        granted_at: now,
      },
      source,
    },
    tenantId,
  );
  const metadata = await storage.metadata.get(item.id);
  await publish({ type: "created", item, metadata, tenantId });
  return { id: item.id, created: true };
}

/**
 * T-131 note on the signature: `salt` + `oidcSigner` used to be consumed
 * by the OAuth-protocol handlers that lived in this file (token issuance,
 * id_token signing). The @better-auth/oauth-provider plugin owns those
 * surfaces now and gets its own salt + signer wiring through `instance.ts`.
 * The two arguments are kept on `authRoutes` for caller compatibility
 * (app.ts still threads them through); they're consumed inside the kept
 * surfaces (device flow uses `salt` for hashing, future expansions may
 * need `oidcSigner` for ID-token-related claims).
 */
export function authRoutes(
  storage: Storage,
  salt: string,
  auth?: MymeAuth,
  oidcSigner?: OidcSigner,
): Hono<AppEnv> {
  // `salt` is consumed by the device-flow terminal step (hashes
  // minted tokens with the same `hashApiKey(token, salt)` as the
  // bearer middleware). `oidcSigner` is currently unused after the
  // OAuth-protocol delete; kept on the signature for caller stability.
  void oidcSigner;
  const router = new Hono<AppEnv>();
  const knownTypes = Array.from(TYPE_REGISTRY.keys());

  // Wave C PR3 / T-033: per-email throttle on `/auth/forgot-password`.
  // 3 requests per email per hour. Sits on top of the per-IP rate
  // limit configured in `middleware/rate-limit.ts` — per-IP bounds a
  // noisy client; per-email bounds the address itself so a burst from
  // many IPs can't drown one user's inbox. T-026 moved the counter
  // into `storage.rateLimits`; cluster-shared on Postgres, in-process
  // on SQLite single-process self-hosts.
  const forgotPasswordThrottle = new PerEmailThrottle(storage, {
    limit: 3,
    windowMs: 60 * 60 * 1000,
  });

  /**
   * Gate `/auth/authorize` on a Better Auth cookie session. End users
   * (not just admins) must be signed in before the consent screen
   * renders or processes a decision. Unauthenticated requests are
   * redirected to `/auth/sign-in` with the original URL preserved as
   * `return_to` so the sign-in flow can pick up where the OAuth flow
   * left off.
   *
   * Returns the active session on success; the caller responds to a
   * `null` return by issuing the redirect (no further work to do).
   */
  async function requireConsentSession(
    c: Context<AppEnv>,
  ): Promise<{ kind: "session"; session: MymeAuthSession } | Response> {
    if (!auth) {
      // Better-auth isn't mounted on this instance. Without an identity
      // layer the consent screen can't authenticate a user — refuse
      // outright rather than silently accept.
      throw new MymeError(
        ErrorCode.UNAUTHORIZED,
        "Consent flow requires the better-auth identity layer to be configured",
      );
    }
    const session = await auth.getSession(c.req.raw.headers);
    if (session) {
      return { kind: "session", session };
    }
    const url = new URL(c.req.url);
    const returnTo = `${url.pathname}${url.search}`;
    const signInPath = `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`;
    return c.redirect(signInPath, 302);
  }

  // -----------------------------------------------------------------------
  // T-131: /auth/tokens (GET / DELETE / PATCH) handlers removed.
  //
  // The homegrown surface exposed individual-access-token management
  // — list, revoke-by-id, reduce-scope. Under @better-auth/oauth-provider
  // tokens are short-lived (1h default), rotate on every refresh, and
  // are revoked at the grant level (`/oauth2/revoke` for a single
  // token-in-hand; `/auth/grants/:id/revoke` for the whole grant).
  // Individual-token management was admin/debug-only surface with no
  // CLI / SDK / sandbox consumers — dropped outright.
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // /auth/grants — typed query into system.connection items
  //
  // The user's "approved apps" surface. Reads system.connection items
  // with kind: app. DELETE flips status → revoked and
  // cascades through revokeGrantTokens to invalidate every token issued
  // under the grant.
  // -----------------------------------------------------------------------

  router.get("/grants", async (c) => {
    const key = requireAuth(c);
    // T-021: tenant-scope the listing. Admin keys can list cross-tenant
    // (their `tenant_id` is undefined by design); any other credential
    // must carry a resolved tenant_id, otherwise the storage call would
    // fall through and return every tenant's grants.
    const isAdmin = key.role === "admin" || key.is_platform;
    if (!isAdmin && !key.tenant_id) {
      throw new MymeError(
        ErrorCode.FORBIDDEN,
        "Tenant scope required for this credential",
      );
    }
    const items = await storage.items.list({
      type: "system.connection",
      state: "active",
      tenantId: key.tenant_id ?? undefined,
    });
    const grants: {
      id: string;
      kind: string;
      client_id: string;
      scopes: string[];
      status: string;
      granted_at: string;
      last_used_at: string | null;
    }[] = [];
    for (const item of items.data) {
      const props = item.properties;
      if (props.kind !== "app") continue;
      if (props.status !== "active") continue;
      grants.push({
        id: item.id,
        kind: props.kind,
        client_id: typeof props.client_id === "string" ? props.client_id : "",
        scopes: Array.isArray(props.scopes) ? (props.scopes as string[]) : [],
        status: typeof props.status === "string" ? props.status : "active",
        granted_at:
          typeof props.granted_at === "string" ? props.granted_at : "",
        last_used_at:
          typeof props.last_used_at === "string" ? props.last_used_at : null,
      });
    }
    return c.json(grants);
  });

  router.delete("/grants/:id", async (c) => {
    const key = requireAuth(c);
    const isAdmin = key.role === "admin" || key.is_platform;
    if (!isAdmin && !key.tenant_id) {
      throw new MymeError(
        ErrorCode.FORBIDDEN,
        "Tenant scope required for this credential",
      );
    }
    const tenantId = key.tenant_id ?? undefined;
    const id = c.req.param("id");
    const item = await storage.items.get(id, tenantId);
    if (item?.type !== "system.connection") {
      throw new MymeError(ErrorCode.OAUTH_GRANT_NOT_FOUND, "Grant not found");
    }
    const props = item.properties;
    if (props.kind !== "app") {
      throw new MymeError(ErrorCode.OAUTH_GRANT_NOT_FOUND, "Grant not found");
    }
    const now = new Date().toISOString();
    await storage.items.update(
      id,
      {
        properties: { ...props, status: "revoked", revoked_at: now },
      },
      tenantId,
    );
    // T-131: cascade-revoke through the plugin's tables. The system.connection
    // properties carry `client_id` + (after projection lands) `user_id` —
    // we use those to delete every access + refresh token for this grant
    // and drop the consent row so the next /authorize prompt re-consents.
    const clientId =
      typeof props.client_id === "string" ? props.client_id : undefined;
    const authUserId =
      typeof props.user_id === "string" ? props.user_id : undefined;
    if (
      clientId &&
      authUserId &&
      typeof storage.oauthProvider?.revokeTokensForGrant === "function"
    ) {
      await storage.oauthProvider.revokeTokensForGrant(clientId, authUserId);
    }
    // T-131: emit the audit row. Fire-and-forget (audit failures must
    // never break the user-facing revoke flow). Pre-T-131 this row was
    // listed in CLAUDE.md as "out-of-scope today" — T-131 is what gave us
    // a clean emission seam (the explicit Myme handler, not the plugin
    // hook which fires from a token-in-hand context without client_id).
    void storage.audit.log({
      tenant_id: tenantId ?? null,
      action: "auth.grant.revoked",
      resource_type: "oauth_grant",
      resource_id: clientId ?? id,
      client_ip: c.var.clientIp ?? null,
      details: {
        client_id: clientId,
        user_id: authUserId,
        grant_item_id: id,
      },
    });
    return c.body(null, 204);
  });

  // -----------------------------------------------------------------------
  // Sign-in page (HTML) + form-handler wrappers around Better Auth's API
  // -----------------------------------------------------------------------
  //
  // GET /sign-in renders a server-rendered HTML form. It's mounted here
  // (inside authRoutes, which dispatches before the better-auth catch-all
  // in app.ts) so the explicit handler wins.
  //
  // POST /sign-in accepts a form-encoded body and dispatches internally
  // to Better Auth's JSON API (`POST /auth/sign-in/email` for password,
  // `POST /auth/sign-in/magic-link` for magic). Better Auth's response
  // is translated back into a 302 redirect so the no-JavaScript path
  // works — Set-Cookie headers from a successful sign-in are forwarded
  // intact onto the redirect response.

  router.get("/sign-in", (c) => {
    const url = new URL(c.req.url);
    const modeRaw = url.searchParams.get("mode");
    const mode = modeRaw === "magic" ? "magic" : "password";
    const error = url.searchParams.get("error") ?? undefined;
    const magicLinkSent = url.searchParams.get("sent") === "1";

    // Two paths feed `return_to`:
    //
    //  1. Explicit `return_to` query param. Set by Myme's own
    //     `requireConsentSession` redirect (the well-behaved
    //    consent-gate path).
    //  2. Bare OAuth params on the URL (`response_type`, `client_id`,
    //     `sig`, etc.) with no `return_to` wrapping. The
    //     @better-auth/oauth-provider plugin's `loginPage` config
    //     redirects unauthenticated users at `/auth/oauth2/authorize`
    //     here by appending the verified-query parameters directly
    //     onto `/auth/sign-in`. Before this fix the params were dropped
    //     on form submit (no hidden `return_to` field carried them
    //     forward) and the user landed on `/` after credential check.
    //     Detect that shape and synthesize `return_to=/auth/authorize?<full original query>`
    //     so the existing form-round-trip path takes over for password,
    //     magic-link, and passkey.
    let returnTo = validateReturnTo(url.searchParams.get("return_to"));
    if (returnTo === "/" && url.searchParams.has("response_type")) {
      returnTo = synthesizeOauthReturnTo(url.searchParams);
    }

    const html = renderSignInPage({
      mode,
      returnTo,
      error,
      magicLinkSent,
      allowSignup: auth?.allowSignup ?? false,
      oidcProviderIds: auth?.oidcProviderIds ?? [],
    });
    setNoStore(c);
    return c.html(html);
  });

  router.post("/sign-in", async (c) => {
    if (!auth) {
      throw new MymeError(
        ErrorCode.UNAUTHORIZED,
        "Sign-in requires the better-auth identity layer to be configured",
      );
    }

    const formData = await c.req.formData();
    const mode = formData.get("mode") === "magic" ? "magic" : "password";
    const returnTo = validateReturnTo(formData.get("return_to"));
    const email = formData.get("email");
    const emailStr = typeof email === "string" ? email.trim() : "";

    const errorRedirect = (errCode: string, modeOverride?: string): Response =>
      c.redirect(
        buildSignInRedirect({
          mode: modeOverride ?? mode,
          returnTo,
          error: errCode,
        }),
        302,
      );

    if (!emailStr) {
      return errorRedirect("missing_field");
    }

    if (mode === "magic") {
      const upstream = new Request(
        new URL("/auth/sign-in/magic-link", c.req.url),
        {
          method: "POST",
          headers: forwardHeaders(
            c.req.raw.headers,
            { "content-type": "application/json" },
            auth.baseURL,
          ),
          body: JSON.stringify({ email: emailStr, callbackURL: returnTo }),
        },
      );
      const response = await auth.handler(upstream);
      if (response.ok) {
        return c.redirect(
          buildSignInRedirect({ mode: "magic", returnTo, sent: true }),
          302,
        );
      }
      return errorRedirect("magic_send_failed");
    }

    const password = formData.get("password");
    const passwordStr = typeof password === "string" ? password : "";
    if (!passwordStr) {
      return errorRedirect("missing_field");
    }

    const upstream = new Request(new URL("/auth/sign-in/email", c.req.url), {
      method: "POST",
      headers: forwardHeaders(
        c.req.raw.headers,
        { "content-type": "application/json" },
        auth.baseURL,
      ),
      body: JSON.stringify({ email: emailStr, password: passwordStr }),
    });
    const response = await auth.handler(upstream);

    if (response.ok) {
      // Forward every Set-Cookie header from Better Auth onto the redirect
      // response. `Headers.getSetCookie()` returns each cookie as a
      // separate string (Node 18.14+ / undici); fall back to a single
      // header otherwise. Browsers honour multiple Set-Cookie via
      // `headers.append`.
      const redirectHeaders = new Headers({ Location: returnTo });
      const setCookies =
        typeof (
          response.headers as Headers & {
            getSetCookie?: () => string[];
          }
        ).getSetCookie === "function"
          ? (
              response.headers as Headers & {
                getSetCookie: () => string[];
              }
            ).getSetCookie()
          : null;
      if (setCookies && setCookies.length > 0) {
        for (const cookie of setCookies) {
          redirectHeaders.append("set-cookie", cookie);
        }
      } else {
        const single = response.headers.get("set-cookie");
        if (single) redirectHeaders.append("set-cookie", single);
      }
      // Wave C PR8 — audit-row on the success path. Don't await:
      // audit failures shouldn't block sign-in. `auth.sign_in.success`
      // shape: `{ email, method }`. `client_ip` auto-stamped from
      // `c.var.clientIp` by middleware contract.
      void storage.audit.log({
        action: "auth.sign_in.success",
        resource_type: "auth_user",
        resource_id: emailStr,
        client_ip: c.var.clientIp ?? null,
        details: { email: emailStr, method: mode },
      });
      return new Response(null, { status: 302, headers: redirectHeaders });
    }

    // Wave C PR8 — audit-row on the failure path. Captures the
    // reason from better-auth's error body where possible.
    void storage.audit.log({
      action: "auth.sign_in.failed",
      resource_type: "auth_user",
      resource_id: emailStr,
      client_ip: c.var.clientIp ?? null,
      details: {
        email: emailStr,
        method: mode,
        reason: "invalid_credentials",
      },
    });
    return errorRedirect("invalid_credentials");
  });

  router.post("/sign-in/provider/:id", async (c) => {
    if (!auth) {
      throw new MymeError(
        ErrorCode.UNAUTHORIZED,
        "OIDC sign-in requires the better-auth identity layer to be configured",
      );
    }
    const providerId = c.req.param("id");
    if (!auth.oidcProviderIds.includes(providerId)) {
      throw new MymeError(
        ErrorCode.NOT_FOUND,
        `Unknown OIDC provider: ${providerId}`,
      );
    }
    const formData = await c.req.formData();
    const returnTo = validateReturnTo(formData.get("return_to"));

    // Better Auth's generic-oauth plugin exposes POST /auth/sign-in/oauth2
    // taking { providerId, callbackURL }. Successful response returns
    // { url, redirect: true } pointing at the provider's authorize URL.
    const upstream = new Request(new URL("/auth/sign-in/oauth2", c.req.url), {
      method: "POST",
      headers: forwardHeaders(
        c.req.raw.headers,
        { "content-type": "application/json" },
        auth.baseURL,
      ),
      body: JSON.stringify({
        providerId,
        callbackURL: returnTo,
      }),
    });
    const response = await auth.handler(upstream);
    if (!response.ok) {
      return c.redirect(
        buildSignInRedirect({
          mode: "password",
          returnTo,
          error: "oauth_failed",
        }),
        302,
      );
    }

    const body = (await response.json()) as { url?: string };
    if (typeof body.url === "string" && body.url.length > 0) {
      return c.redirect(body.url, 302);
    }
    return c.redirect(
      buildSignInRedirect({
        mode: "password",
        returnTo,
        error: "oauth_failed",
      }),
      302,
    );
  });

  // -----------------------------------------------------------------------
  // Sign-up page (HTML) + form-handler wrapper
  // -----------------------------------------------------------------------
  //
  // Conditional surface — the GET handler returns 404 when allowSignup
  // is false. The POST wrapper around Better Auth's POST /auth/sign-up/email
  // mirrors the sign-in form-handler shape: form-encoded body, JSON
  // dispatch, Set-Cookie forwarded onto a 302. autoSignIn is enabled
  // upstream so a successful sign-up lands the user on `return_to`
  // already authenticated.

  router.get("/sign-up", (c) => {
    if (!auth?.allowSignup) {
      throw new MymeError(ErrorCode.NOT_FOUND, "Not found");
    }
    const url = new URL(c.req.url);
    const returnTo = validateReturnTo(url.searchParams.get("return_to"));
    const error = url.searchParams.get("error") ?? undefined;
    setNoStore(c);
    return c.html(renderSignUpPage({ returnTo, error }));
  });

  router.post("/sign-up", async (c) => {
    if (!auth) {
      throw new MymeError(
        ErrorCode.UNAUTHORIZED,
        "Sign-up requires the better-auth identity layer to be configured",
      );
    }
    if (!auth.allowSignup) {
      throw new MymeError(ErrorCode.NOT_FOUND, "Not found");
    }

    const formData = await c.req.formData();
    const returnTo = validateReturnTo(formData.get("return_to"));
    const email = formData.get("email");
    const name = formData.get("name");
    const username = formData.get("username");
    const password = formData.get("password");
    const passwordConfirm = formData.get("password_confirm");
    const emailStr = typeof email === "string" ? email.trim() : "";
    const nameStr = typeof name === "string" ? name.trim() : "";
    const usernameRaw = typeof username === "string" ? username.trim() : "";
    const passwordStr = typeof password === "string" ? password : "";
    const passwordConfirmStr =
      typeof passwordConfirm === "string" ? passwordConfirm : "";

    const errorRedirect = (errCode: string): Response =>
      c.redirect(buildSignUpRedirect({ returnTo, error: errCode }), 302);

    if (
      !emailStr ||
      !nameStr ||
      !usernameRaw ||
      !passwordStr ||
      !passwordConfirmStr
    ) {
      return errorRedirect("missing_field");
    }
    if (passwordStr !== passwordConfirmStr) {
      return errorRedirect("password_mismatch");
    }
    if (passwordStr.length < 8) {
      return errorRedirect("weak_password");
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailStr)) {
      return errorRedirect("email_invalid");
    }

    // T-074: pre-validate username BEFORE creating an auth_user row.
    // Any failure here means we never call Better Auth — no orphan to
    // roll back. Reserved → invalid → collision, in that order so the
    // user gets the most-specific error.
    const usernameLower = usernameRaw.toLowerCase();
    if (isReservedHandle(usernameLower)) {
      return errorRedirect("handle_reserved");
    }
    if (!isValidHandle(usernameLower)) {
      return errorRedirect("handle_invalid");
    }
    // Hosted-mode is the only path where username makes sense — keys
    // mode has no per-user tenant. The signup form is gated behind
    // `allowSignup`, which itself is hosted-mode-only in practice.
    if (storage.users) {
      const collision = await storage.users.getByHandle(usernameLower);
      if (collision) {
        return errorRedirect("handle_taken");
      }
    }

    const upstream = new Request(new URL("/auth/sign-up/email", c.req.url), {
      method: "POST",
      headers: forwardHeaders(
        c.req.raw.headers,
        { "content-type": "application/json" },
        auth.baseURL,
      ),
      body: JSON.stringify({
        email: emailStr,
        password: passwordStr,
        name: nameStr,
      }),
    });
    const response = await auth.handler(upstream);

    if (response.ok) {
      // T-074: provision the Myme tenant + users row atomically with the
      // Better Auth account. Reads the new auth_user.id from the
      // upstream response body. Better Auth returns 200 with
      // `{ token, user: { id, email, ... } }` on success — `token` may
      // be null when requireEmailVerification is on, but `user.id` is
      // always populated.
      //
      // The response body has already been read in some paths below
      // (verification redirect path doesn't); we tee here so the
      // post-tee branches still see a fresh body.
      const responseClone = response.clone();
      let provisioningError: Error | null = null;
      let provisionedAuthUserId: string | null = null;
      if (storage.users && storage.tenants) {
        try {
          const upstreamBody = (await responseClone.json()) as {
            user?: { id?: string };
          };
          const authUserId = upstreamBody.user?.id;
          if (typeof authUserId !== "string" || authUserId.length === 0) {
            throw new Error(
              "Better Auth sign-up response missing user.id; refusing to provision tenant blind",
            );
          }
          provisionedAuthUserId = authUserId;
          // T-074 + Wave C PR2 interaction: with
          // `requireEmailVerification: true`, Better Auth's
          // generic-duplicate-response shape returns the existing
          // user's id (the no-enumeration invariant). If that user
          // already has a Myme `users` row we skip provisioning —
          // they're a returning duplicate and the verify-email page is
          // the right next stop. The handle they typed in this attempt
          // is silently ignored (no-op) since they've already claimed
          // theirs at the original signup.
          const existing = await storage.users.getByAuthUserId(authUserId);
          if (!existing) {
            const tenant = await storage.tenants.create(nameStr);
            await storage.users.create({
              name: nameStr,
              provider: "better-auth",
              provider_id: authUserId,
              tenant_id: tenant.id,
              handle: usernameLower,
              auth_user_id: authUserId,
            });
          }
        } catch (err) {
          provisioningError =
            err instanceof Error ? err : new Error(String(err));
        }
      }
      if (provisioningError) {
        // Best-effort rollback. Better Auth's API exposes
        // `removeUser({ userId })` via its internal API surface. We
        // don't have a typed handle to it from inside this wrapper;
        // log loudly so an operator can clean up the orphan
        // auth_user row manually. The provisioning error is the
        // primary signal — the user sees signup_failed and re-tries
        // with a different (e.g. less collision-prone) input.
        await storage.audit.log({
          action: "auth.sign_up.provision_failed",
          resource_type: "auth_user",
          resource_id: provisionedAuthUserId ?? emailStr,
          client_ip: c.var.clientIp ?? null,
          details: {
            email: emailStr,
            error: provisioningError.message,
          },
        });
        return errorRedirect("signup_failed");
      }

      // Wave C PR8 — audit the sign-up. Don't await: audit failures
      // shouldn't block the user's redirect.
      void storage.audit.log({
        action: "auth.sign_up",
        resource_type: "auth_user",
        resource_id: emailStr,
        client_ip: c.var.clientIp ?? null,
        details: { email: emailStr, username: usernameLower },
      });
      // autoSignIn=true on the auth instance means the response carries
      // a session cookie — UNLESS `requireEmailVerification: true`
      // (Wave C PR2) is set, in which case better-auth returns 200 with
      // `{ token: null, user }` and no Set-Cookie. We branch on the
      // cookie presence: if absent, redirect to the verify-email page
      // so the user can watch for the inbox arrival; if present, land
      // them on `return_to` already authenticated.
      const setCookies =
        typeof (
          response.headers as Headers & {
            getSetCookie?: () => string[];
          }
        ).getSetCookie === "function"
          ? (
              response.headers as Headers & {
                getSetCookie: () => string[];
              }
            ).getSetCookie()
          : null;
      const singleCookie = response.headers.get("set-cookie");
      const cookies =
        setCookies && setCookies.length > 0
          ? setCookies
          : singleCookie
            ? [singleCookie]
            : [];

      if (cookies.length === 0) {
        // Verification-required path. Redirect to the verify-email
        // page with the email pre-filled and return_to threaded
        // through so the user lands on their original destination
        // after clicking the link.
        const params = new URLSearchParams();
        params.set("email", emailStr);
        params.set("return_to", returnTo);
        return c.redirect(`/auth/verify-email?${params.toString()}`, 302);
      }

      const redirectHeaders = new Headers({ Location: returnTo });
      for (const cookie of cookies) {
        redirectHeaders.append("set-cookie", cookie);
      }
      return new Response(null, { status: 302, headers: redirectHeaders });
    }

    // Map Better Auth's error response shape to our user-facing codes.
    // Better Auth returns 422 USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL when
    // the email is taken, and 400 with code ROLE-validation when password
    // is invalid. Read the body once to discriminate.
    let errorCode = "signup_failed";
    try {
      const body = (await response.json()) as { code?: string };
      if (body.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") {
        errorCode = "email_exists";
      } else if (body.code?.toLowerCase().includes("password")) {
        errorCode = "weak_password";
      } else if (body.code?.toLowerCase().includes("email")) {
        errorCode = "email_invalid";
      }
    } catch {
      // Fall through to the generic signup_failed code.
    }
    return errorRedirect(errorCode);
  });

  // -----------------------------------------------------------------------
  // Email verification (Wave C PR2)
  // -----------------------------------------------------------------------
  //
  // Three observable surfaces:
  //   - GET /auth/verify-email?token=…&return_to=…  — token path:
  //     forwards to better-auth's verify-email endpoint which validates
  //     the token, stamps `email_verified=true`, and (because we don't
  //     pass `callbackURL`) returns a JSON body. We render success or
  //     failure as our themed page, forwarding any Set-Cookie better-auth
  //     issued (currently none on the verify endpoint, but
  //     forward-compatible with future better-auth changes).
  //   - GET /auth/verify-email?email=…&return_to=… — pending path:
  //     no token, just landed from a sign-up redirect. Renders the
  //     "check your inbox" page with a resend form. Optional `?sent=1`
  //     swaps to the success-banner variant for resend confirmations.
  //   - POST /auth/verify-email/resend — calls better-auth's
  //     send-verification-email endpoint. Idempotent at the user level
  //     (idempotency key per-token threaded through to audit on the
  //     transport hook). Redirects back with `?sent=1` regardless of
  //     whether the address actually exists, to avoid email enumeration.

  router.get("/verify-email", async (c) => {
    if (!auth) {
      throw new MymeError(
        ErrorCode.UNAUTHORIZED,
        "Email verification requires the better-auth identity layer to be configured",
      );
    }
    const url = new URL(c.req.url);
    const token = url.searchParams.get("token");
    const email = url.searchParams.get("email");
    const returnTo = validateReturnTo(url.searchParams.get("return_to"));
    const sent = url.searchParams.get("sent");
    setNoStore(c);

    if (!token) {
      return c.html(
        renderVerifyEmailPage({
          state: sent === "1" ? "resent" : "pending",
          email,
          returnTo,
        }),
      );
    }

    // Token path. Forward to better-auth's GET /auth/verify-email
    // (we omit `callbackURL` so it returns a JSON body rather than
    // a redirect; we render our own success/failure UI).
    const upstreamUrl = new URL("/auth/verify-email", c.req.url);
    upstreamUrl.searchParams.set("token", token);
    const upstream = new Request(upstreamUrl, {
      method: "GET",
      headers: forwardHeaders(c.req.raw.headers, {}, auth.baseURL),
    });
    const response = await auth.handler(upstream);

    if (response.ok) {
      // Wave C PR8 — audit the successful email verification.
      // resource_id is the token prefix (correlation handle) since
      // we don't have the user_id at this layer.
      void storage.audit.log({
        action: "auth.email.verified",
        resource_type: "auth_user",
        resource_id: token.slice(0, 12),
        client_ip: c.var.clientIp ?? null,
        details: { token_prefix: token.slice(0, 12) },
      });
      // Forward any Set-Cookie better-auth issued onto our response
      // (forward-compatible — the current 1.6.x verify-email doesn't
      // mint a session, but we don't want to silently drop it if a
      // future bump does).
      const headers = new Headers({
        "content-type": "text/html; charset=utf-8",
      });
      const setCookies =
        typeof (response.headers as Headers & { getSetCookie?: () => string[] })
          .getSetCookie === "function"
          ? (
              response.headers as Headers & { getSetCookie: () => string[] }
            ).getSetCookie()
          : null;
      if (setCookies && setCookies.length > 0) {
        for (const cookie of setCookies) headers.append("set-cookie", cookie);
      } else {
        const single = response.headers.get("set-cookie");
        if (single) headers.append("set-cookie", single);
      }
      // No-store on the success render too; the URL carries a
      // single-use token and shouldn't sit in history caches.
      headers.set("cache-control", "no-store, no-cache, private");
      headers.set("pragma", "no-cache");
      return new Response(
        renderVerifyEmailPage({ state: "success", returnTo }),
        { status: 200, headers },
      );
    }

    // Failure path. Map better-auth's error shape to a friendly code.
    let failureCode: "expired" | "invalid" | "unknown" = "unknown";
    try {
      const body = (await response.json()) as { code?: string };
      const code = body.code?.toLowerCase() ?? "";
      if (code.includes("expired")) failureCode = "expired";
      else if (code.includes("invalid") || code.includes("token"))
        failureCode = "invalid";
    } catch {
      // Fall through to "unknown".
    }
    return c.html(
      renderVerifyEmailPage({
        state: "failure",
        email,
        returnTo,
        failureCode,
      }),
    );
  });

  router.post("/verify-email/resend", async (c) => {
    if (!auth) {
      throw new MymeError(
        ErrorCode.UNAUTHORIZED,
        "Email verification requires the better-auth identity layer to be configured",
      );
    }
    const formData = await c.req.formData();
    const email = formData.get("email");
    const returnTo = validateReturnTo(formData.get("return_to"));
    const emailStr = typeof email === "string" ? email.trim() : "";

    if (!emailStr) {
      const params = new URLSearchParams({ return_to: returnTo });
      return c.redirect(`/auth/verify-email?${params.toString()}`, 302);
    }

    // Forward to better-auth's POST /auth/send-verification-email.
    // Soft-fail on errors — we redirect with `?sent=1` regardless so
    // an attacker can't probe whether an address has an account.
    const upstream = new Request(
      new URL("/auth/send-verification-email", c.req.url),
      {
        method: "POST",
        headers: forwardHeaders(
          c.req.raw.headers,
          { "content-type": "application/json" },
          auth.baseURL,
        ),
        body: JSON.stringify({ email: emailStr, callbackURL: returnTo }),
      },
    );
    try {
      await auth.handler(upstream);
    } catch {
      // Swallow — the redirect carries `?sent=1` regardless to keep
      // the soft-fail invariant.
    }

    const params = new URLSearchParams();
    params.set("email", emailStr);
    params.set("return_to", returnTo);
    params.set("sent", "1");
    return c.redirect(`/auth/verify-email?${params.toString()}`, 302);
  });

  // -----------------------------------------------------------------------
  // Forgot password + reset (Wave C PR3 / T-033)
  // -----------------------------------------------------------------------
  //
  // Surfaces:
  //   - GET  /auth/forgot-password           — render the email form
  //   - POST /auth/forgot-password           — soft-fail dispatch to
  //     better-auth's `request-password-reset`. Per-email throttled
  //     (3/hour) AND per-IP throttled (via existing rate-limit
  //     middleware's `pathLimits`). Always 302s to the `sent` state
  //     regardless of whether the address exists, to avoid email
  //     enumeration.
  //   - GET  /auth/reset-password?token=…    — render the new-password
  //     form. Token validity is checked on POST (not GET) — cheap, and
  //     better-auth-style callback redirects have already been bypassed
  //     by our hook constructing the email URL directly.
  //   - POST /auth/reset-password            — validate fields, dispatch
  //     to better-auth's `reset-password`, render success or failure.

  router.get("/forgot-password", (c) => {
    const url = new URL(c.req.url);
    const error = url.searchParams.get("error") as
      | "rate_limited"
      | "email_not_configured"
      | null;
    const sent = url.searchParams.get("sent") === "1";
    const email = url.searchParams.get("email");
    const returnTo = validateReturnTo(url.searchParams.get("return_to"));
    setNoStore(c);
    return c.html(
      renderForgotPasswordPage({
        state: error ? "error" : sent ? "sent" : "form",
        email,
        returnTo,
        errorCode: error ?? undefined,
      }),
    );
  });

  router.post("/forgot-password", async (c) => {
    if (!auth) {
      throw new MymeError(
        ErrorCode.UNAUTHORIZED,
        "Password reset requires the better-auth identity layer to be configured",
      );
    }
    const formData = await c.req.formData();
    const emailRaw = formData.get("email");
    const returnTo = validateReturnTo(formData.get("return_to"));
    const emailStr =
      typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";

    // Empty / malformed email — render the form again with the value
    // erased; no point dispatching upstream.
    if (!emailStr || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailStr)) {
      const params = new URLSearchParams({ return_to: returnTo });
      return c.redirect(`/auth/forgot-password?${params.toString()}`, 302);
    }

    // Per-email throttle. The rate-limit middleware also caps per-IP;
    // this is the parallel cap for the email itself.
    const throttle = await forgotPasswordThrottle.attempt(emailStr);
    if (!throttle.allowed) {
      const params = new URLSearchParams({
        email: emailStr,
        return_to: returnTo,
        error: "rate_limited",
      });
      return c.redirect(`/auth/forgot-password?${params.toString()}`, 302);
    }

    // Dispatch to better-auth. We swallow errors — the soft-fail
    // success render is the canonical path regardless of upstream
    // outcome (no enumeration). The `sendResetPassword` hook itself
    // logs failures and writes to the audit trail.
    try {
      const upstream = new Request(
        new URL("/auth/request-password-reset", c.req.url),
        {
          method: "POST",
          headers: forwardHeaders(
            c.req.raw.headers,
            { "content-type": "application/json" },
            auth.baseURL,
          ),
          body: JSON.stringify({ email: emailStr }),
        },
      );
      await auth.handler(upstream);
    } catch {
      // Soft-fail.
    }

    // Wave C PR8 — audit every reset-request attempt regardless of
    // upstream outcome. Captures the email + IP for rate-monitoring;
    // operators can correlate with `auth.password_reset.completed`
    // to spot abandoned flows.
    void storage.audit.log({
      action: "auth.password_reset.requested",
      resource_type: "auth_user",
      resource_id: emailStr,
      client_ip: c.var.clientIp ?? null,
      details: { email: emailStr },
    });

    const params = new URLSearchParams({
      email: emailStr,
      return_to: returnTo,
      sent: "1",
    });
    return c.redirect(`/auth/forgot-password?${params.toString()}`, 302);
  });

  router.get("/reset-password", (c) => {
    if (!auth) {
      throw new MymeError(
        ErrorCode.UNAUTHORIZED,
        "Password reset requires the better-auth identity layer to be configured",
      );
    }
    const url = new URL(c.req.url);
    const token = url.searchParams.get("token");
    const returnTo = validateReturnTo(url.searchParams.get("return_to"));
    setNoStore(c);

    // No token means the user landed here without clicking a link.
    // Send them to forgot-password to start over.
    if (!token) {
      return c.redirect("/auth/forgot-password", 302);
    }

    return c.html(renderResetPasswordPage({ state: "form", token, returnTo }));
  });

  router.post("/reset-password", async (c) => {
    if (!auth) {
      throw new MymeError(
        ErrorCode.UNAUTHORIZED,
        "Password reset requires the better-auth identity layer to be configured",
      );
    }
    const formData = await c.req.formData();
    const token = formData.get("token");
    const password = formData.get("password");
    const passwordConfirm = formData.get("password_confirm");
    const returnTo = validateReturnTo(formData.get("return_to"));
    const tokenStr = typeof token === "string" ? token : "";
    const passwordStr = typeof password === "string" ? password : "";
    const passwordConfirmStr =
      typeof passwordConfirm === "string" ? passwordConfirm : "";

    // Form-side validation. Re-render with an in-form banner so the
    // user doesn't lose the in-progress reset.
    const renderForm = (
      formError: "missing_field" | "password_mismatch" | "weak_password",
    ): Response =>
      c.html(
        renderResetPasswordPage({
          state: "form",
          token: tokenStr,
          returnTo,
          formError,
        }),
      );

    if (!tokenStr || !passwordStr || !passwordConfirmStr) {
      return renderForm("missing_field");
    }
    if (passwordStr !== passwordConfirmStr) {
      return renderForm("password_mismatch");
    }
    if (passwordStr.length < 8) {
      return renderForm("weak_password");
    }

    // Dispatch to better-auth's POST /auth/reset-password.
    const upstream = new Request(new URL("/auth/reset-password", c.req.url), {
      method: "POST",
      headers: forwardHeaders(
        c.req.raw.headers,
        { "content-type": "application/json" },
        auth.baseURL,
      ),
      body: JSON.stringify({ newPassword: passwordStr, token: tokenStr }),
    });
    const response = await auth.handler(upstream);

    if (response.ok) {
      // Wave C PR8 — audit the successful reset.
      // `revokeSessionsOnPasswordReset: true` already nuked any other
      // sessions for this user. Audit row captures the action + IP;
      // we don't have the user_id at this layer (better-auth
      // performed the reset internally) so resource_id is the token
      // prefix as a correlation handle.
      void storage.audit.log({
        action: "auth.password_reset.completed",
        resource_type: "auth_user",
        resource_id: tokenStr.slice(0, 12),
        client_ip: c.var.clientIp ?? null,
        details: { token_prefix: tokenStr.slice(0, 12) },
      });
      // Success — render the success page. The user has no active
      // session now and must sign in fresh.
      return c.html(renderResetPasswordPage({ state: "success", returnTo }));
    }

    // Map better-auth's error shape to our friendly failure code.
    let failureCode: "expired" | "invalid" | "unknown" = "unknown";
    try {
      const body = (await response.json()) as { code?: string };
      const code = body.code?.toLowerCase() ?? "";
      if (code.includes("expired")) failureCode = "expired";
      else if (code.includes("invalid") || code.includes("token"))
        failureCode = "invalid";
    } catch {
      // Fall through to "unknown".
    }
    return c.html(renderResetPasswordPage({ state: "failure", failureCode }));
  });

  // -----------------------------------------------------------------------
  // Security page + session/grant revocation (Wave C PR7 / T-031)
  // -----------------------------------------------------------------------
  //
  // Surfaces:
  //   - GET  /auth/security                — auth-gated. Lists the
  //     user's connected apps + active sessions with revoke buttons.
  //   - POST /auth/grants/:id/revoke       — form-friendly counterpart
  //     to the existing API DELETE /auth/grants/:id. The HTML page
  //     forms POST here; redirects back to /auth/security with a
  //     notice on success.
  //   - POST /auth/sessions/:id/revoke     — form-friendly per-session
  //     revoke. Looks up the session id in the user's list-sessions
  //     output, extracts its token, forwards to better-auth's
  //     POST /auth/revoke-session.
  //   - POST /auth/sessions/sign-out-all   — revokes every session
  //     (including current). Forwards to better-auth's
  //     POST /auth/revoke-sessions, then redirects to /auth/sign-in.

  router.get("/security", async (c) => {
    const gated = await requireConsentSession(c);
    if (gated instanceof Response) return gated;
    setNoStore(c);
    // requireConsentSession throws when auth is undefined, so reaching
    // this point guarantees auth is defined — narrow it for TS.
    if (!auth) throw new Error("unreachable: auth defined after gated");

    const sessionUser = gated.session.user;
    const currentSessionId = gated.session.session.id;

    // 1. Forward GET /auth/list-sessions internally to get this
    //    user's active sessions. Cookies thread through so
    //    better-auth resolves to the right user.
    let sessions: SecurityPageSession[] = [];
    try {
      const listReq = new Request(new URL("/auth/list-sessions", c.req.url), {
        method: "GET",
        headers: forwardHeaders(c.req.raw.headers, {}, auth.baseURL),
      });
      const listRes = await auth.handler(listReq);
      if (listRes.ok) {
        const data = (await listRes.json()) as {
          id: string;
          createdAt: string | Date;
          updatedAt: string | Date;
          ipAddress?: string | null;
          userAgent?: string | null;
        }[];
        sessions = data.map((s) => ({
          id: s.id,
          created_at:
            typeof s.createdAt === "string"
              ? s.createdAt
              : s.createdAt.toISOString(),
          last_active_at:
            typeof s.updatedAt === "string"
              ? s.updatedAt
              : s.updatedAt.toISOString(),
          is_current: s.id === currentSessionId,
          ip_address: s.ipAddress ?? null,
          user_agent: s.userAgent ?? null,
        }));
      }
    } catch {
      // Soft-fail — render the page without the sessions list rather
      // than 500. Operators see the underlying log if it's a real
      // outage.
    }

    // 2. List grants for this user's tenant. In keys mode (no
    //    storage.users), grants are tenant-less and we list them
    //    that way; this matches the pattern in /auth/grants and the
    //    existing DELETE handler.
    let tenantId: string | undefined;
    if (storage.users) {
      // T-074: lookup by Better Auth user id (the canonical bridge).
      const userRow = await storage.users.getByAuthUserId(sessionUser.id);
      tenantId = userRow?.tenant_id;
    }
    const grantItems = await storage.items.list({
      type: "system.connection",
      state: "active",
      tenantId,
    });
    // T-131: per-grant client-name lookup from the plugin's
    // auth_oauth_client table. Worst-case N small queries; for the
    // page-load scale this is fine and avoids the prior batch-list
    // pattern which reads every client across every tenant. If the
    // page grows hot, swap for a single IN-clause batch read.
    const grants: SecurityPageGrant[] = [];
    for (const item of grantItems.data) {
      const props = item.properties;
      if (props.kind !== "app") continue;
      if (props.status !== "active") continue;
      const clientId =
        typeof props.client_id === "string" ? props.client_id : "";
      const clientName =
        clientId && typeof storage.oauthProvider?.getClientName === "function"
          ? ((await storage.oauthProvider.getClientName(clientId)) ?? clientId)
          : clientId;
      grants.push({
        id: item.id,
        client_name: clientName,
        client_id: clientId,
        scopes: Array.isArray(props.scopes) ? (props.scopes as string[]) : [],
        granted_at:
          typeof props.granted_at === "string" ? props.granted_at : "",
        last_used_at:
          typeof props.last_used_at === "string" ? props.last_used_at : null,
      });
    }

    // 3. Optional flash notice from `?notice=...`.
    const url = new URL(c.req.url);
    const notice = parseNotice(url.searchParams.get("notice"));

    return c.html(
      renderSecurityPage({
        email: sessionUser.email,
        grants,
        sessions,
        notice,
      }),
    );
  });

  // Form-friendly grant revoke. Mirrors the DELETE /auth/grants/:id
  // logic but renders a redirect back to /auth/security with a flash
  // notice instead of a 204 body.
  router.post("/grants/:id/revoke", async (c) => {
    const gated = await requireConsentSession(c);
    if (gated instanceof Response) return gated;
    const sessionUser = gated.session.user;

    let tenantId: string | undefined;
    if (storage.users) {
      // T-074: lookup by Better Auth user id (the canonical bridge).
      const userRow = await storage.users.getByAuthUserId(sessionUser.id);
      tenantId = userRow?.tenant_id;
    }
    const id = c.req.param("id");
    const item = await storage.items.get(id, tenantId);
    if (item?.type !== "system.connection") {
      return c.redirect("/auth/security?notice=grant_not_found", 302);
    }
    const props = item.properties;
    if (props.kind !== "app") {
      return c.redirect("/auth/security?notice=grant_not_found", 302);
    }
    const now = new Date().toISOString();
    await storage.items.update(
      id,
      { properties: { ...props, status: "revoked", revoked_at: now } },
      tenantId,
    );
    // T-131: cascade-revoke via plugin tables (see DELETE /grants/:id for
    // the rationale). Falls through silently if the grant predates the
    // projection wiring — the system.connection state flip is still the
    // authoritative user-facing signal.
    const clientId =
      typeof props.client_id === "string" ? props.client_id : undefined;
    const authUserId =
      typeof props.user_id === "string" ? props.user_id : undefined;
    if (
      clientId &&
      authUserId &&
      typeof storage.oauthProvider?.revokeTokensForGrant === "function"
    ) {
      await storage.oauthProvider.revokeTokensForGrant(clientId, authUserId);
    }
    // T-131: audit emission (see DELETE /grants/:id for rationale).
    void storage.audit.log({
      tenant_id: tenantId ?? null,
      action: "auth.grant.revoked",
      resource_type: "oauth_grant",
      resource_id: clientId ?? id,
      client_ip: c.var.clientIp ?? null,
      details: {
        client_id: clientId,
        user_id: authUserId,
        grant_item_id: id,
      },
    });
    return c.redirect("/auth/security?notice=grant_revoked", 302);
  });

  router.post("/sessions/:id/revoke", async (c) => {
    const gated = await requireConsentSession(c);
    if (gated instanceof Response) return gated;
    if (!auth) throw new Error("unreachable: auth defined after gated");
    const id = c.req.param("id");
    const currentSessionId = gated.session.session.id;
    if (id === currentSessionId) {
      // Refuse to revoke the current session through this path —
      // the user should use Sign out everywhere instead, which
      // signs them out cleanly. Defence-in-depth: the form button
      // for the current session is rendered as disabled.
      return c.redirect("/auth/security?notice=cannot_revoke_current", 302);
    }
    // Look up the session by id in the user's list to extract the
    // token (better-auth's revoke endpoint takes a token, not an id).
    let token: string | null = null;
    try {
      const listReq = new Request(new URL("/auth/list-sessions", c.req.url), {
        method: "GET",
        headers: forwardHeaders(c.req.raw.headers, {}, auth.baseURL),
      });
      const listRes = await auth.handler(listReq);
      if (listRes.ok) {
        const data = (await listRes.json()) as {
          id: string;
          token: string;
        }[];
        const match = data.find((s) => s.id === id);
        if (match) token = match.token;
      }
    } catch {
      return c.redirect("/auth/security?notice=session_revoke_failed", 302);
    }
    if (!token) {
      return c.redirect("/auth/security?notice=session_not_found", 302);
    }
    const revokeReq = new Request(new URL("/auth/revoke-session", c.req.url), {
      method: "POST",
      headers: forwardHeaders(
        c.req.raw.headers,
        { "content-type": "application/json" },
        auth.baseURL,
      ),
      body: JSON.stringify({ token }),
    });
    const revokeRes = await auth.handler(revokeReq);
    if (!revokeRes.ok) {
      return c.redirect("/auth/security?notice=session_revoke_failed", 302);
    }
    return c.redirect("/auth/security?notice=session_revoked", 302);
  });

  router.post("/sessions/sign-out-all", async (c) => {
    const gated = await requireConsentSession(c);
    if (gated instanceof Response) return gated;
    if (!auth) throw new Error("unreachable: auth defined after gated");
    const revokeReq = new Request(new URL("/auth/revoke-sessions", c.req.url), {
      method: "POST",
      headers: forwardHeaders(
        c.req.raw.headers,
        { "content-type": "application/json" },
        auth.baseURL,
      ),
    });
    const revokeRes = await auth.handler(revokeReq);
    // Regardless of upstream outcome, the current session is now
    // cooked (or about to be). Redirect to /auth/sign-in.
    void revokeRes;
    return c.redirect("/auth/sign-in", 302);
  });

  // -----------------------------------------------------------------------
  // Passkey enrol (Wave C PR6 / T-034)
  // -----------------------------------------------------------------------
  //
  // GET /auth/passkey/enroll — auth-gated HTML page that runs the
  // WebAuthn registration ceremony in the browser. Better-auth's
  // passkey plugin provides the raw endpoints (`/passkey/generate-
  // register-options`, `/passkey/verify-registration`, etc.); this
  // page just stitches the ceremony around them.
  //
  // Passkey sign-in (the auth side of the same plugin) is exposed
  // as a button on `/auth/sign-in` that calls
  // `MymePasskey.signIn()` from the same static script.

  router.get("/passkey/enroll", async (c) => {
    const gated = await requireConsentSession(c);
    if (gated instanceof Response) return gated;
    setNoStore(c);
    return c.html(renderPasskeyEnrollPage({ email: gated.session.user.email }));
  });

  // -----------------------------------------------------------------------
  // Device Authorization Grant (RFC 8628)
  // -----------------------------------------------------------------------
  //
  // Three observable surfaces:
  //   - POST /auth/device (JSON)   — initiate a flow; returns device_code +
  //     user_code + verification_uri. The CLI / Swift SDK call this.
  //   - POST /auth/device (form)   — the user submits their user_code from
  //     the verification page; if valid, redirect to /auth/device/consent.
  //   - POST /auth/device/token    — polled by the client until the user
  //     approves; returns the standard OAuth token response on success.
  //   - GET /auth/device           — verification HTML form (optionally
  //     pre-filled via ?user_code=…).
  //   - GET /auth/device/consent?user_code=… — consent screen, gated on a
  //     better-auth session (redirects to /auth/sign-in if absent).
  //   - POST /auth/device/consent  — approve/deny submission.

  // Shared device-flow init handler. Reachable from JSON callers (the
  // Myme CLI / SDK shape) and from RFC 8628 §3.1 form-encoded callers
  // (the protocol-canonical shape, T-190). Both produce the same
  // device-code envelope.
  const initDeviceFlow = async (
    c: Context,
    clientId: string | null,
    rawScope: string,
  ): Promise<Response> => {
    const scope = rawScope.trim();
    if (!clientId || !scope) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "client_id and scope are required",
      );
    }
    // T-131: client lookup migrated from the dropped `oauth_clients`
    // table to the plugin's `auth_oauth_client` table.
    const client = await storage.oauthProvider?.getClient(clientId);
    if (!client) {
      throw new MymeError(ErrorCode.INVALID_CLIENT, "Unknown client_id");
    }
    // Validate every requested scope against the registry. Reject
    // outright on any unknown scope so we don't store a code that
    // can't be approved.
    const requestedScopes = scope.split(" ").filter(Boolean);
    const expanded = expandWildcardScopes(requestedScopes, knownTypes);
    const parsed = expanded.map(parseScope).filter((s) => s !== null);
    if (parsed.length === 0) {
      throw new MymeError(ErrorCode.INVALID_SCOPE, "No valid scopes requested");
    }

    const deviceCodeRaw = generateToken(DEVICE_CODE_PREFIX);
    const deviceCodeHash = sha256(deviceCodeRaw);
    const userCode = generateUserCode();
    const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_MS).toISOString();
    const intervalSeconds = DEVICE_CODE_DEFAULT_INTERVAL_SECONDS;

    await storage.oauth.createDeviceCode({
      deviceCodeHash,
      userCode,
      clientId,
      scope: requestedScopes.join(" "),
      expiresAt,
      intervalSeconds,
    });

    const verificationBase = auth?.baseURL ?? new URL(c.req.url).origin;
    const verificationUri = `${verificationBase}/auth/device`;
    const verificationUriComplete = `${verificationUri}?user_code=${encodeURIComponent(userCode)}`;
    return c.json({
      device_code: deviceCodeRaw,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: verificationUriComplete,
      expires_in: DEVICE_CODE_TTL_MS / 1000,
      interval: intervalSeconds,
    });
  };

  router.post("/device", async (c) => {
    const contentType = c.req.header("content-type") ?? "";

    // -------------------- JSON init --------------------
    // Myme's own CLI / SDK use this shape; not RFC-mandated but
    // operationally convenient.
    if (contentType.includes("application/json")) {
      let body: { client_id?: unknown; scope?: unknown };
      try {
        body = await c.req.json();
      } catch {
        throw new MymeError(ErrorCode.VALIDATION_ERROR, "JSON body required");
      }
      const clientId =
        typeof body.client_id === "string" ? body.client_id : null;
      const scope = typeof body.scope === "string" ? body.scope : "";
      return initDeviceFlow(c, clientId, scope);
    }

    // -------------------- Form-encoded --------------------
    // Two distinct operations share the form-encoded surface:
    //
    //   1. **Init** — RFC 8628 §3.1. Body carries `client_id` (+
    //      `scope`). Any client following the spec literally lands
    //      here.
    //   2. **User-code submission** — Myme's verification form. Body
    //      carries `user_code`.
    //
    // Disambiguate by inspecting the body. A request with neither
    // field falls through to the user-code branch and gets the
    // existing `missing_code` redirect — same behaviour as before.
    const formData = await c.req.formData();
    const formClientId = formData.get("client_id");
    if (typeof formClientId === "string" && formClientId !== "") {
      const formScopeRaw = formData.get("scope");
      const scope = typeof formScopeRaw === "string" ? formScopeRaw : "";
      return initDeviceFlow(c, formClientId, scope);
    }

    // -------------------- Form submit user_code --------------------
    const submittedRaw = formData.get("user_code");
    const submitted =
      typeof submittedRaw === "string"
        ? submittedRaw.trim().toUpperCase().replace(/\s+/g, "")
        : "";
    if (!submitted) {
      return c.redirect(`/auth/device?error=missing_code`, 302);
    }
    const normalised = normaliseUserCode(submitted);
    const row = await storage.oauth.findDeviceCodeByUserCode(normalised);
    if (!row) {
      return c.redirect(
        `/auth/device?error=invalid_code&user_code=${encodeURIComponent(submitted)}`,
        302,
      );
    }
    if (row.status !== "pending") {
      return c.redirect(
        `/auth/device?error=already_resolved&user_code=${encodeURIComponent(submitted)}`,
        302,
      );
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return c.redirect(`/auth/device?error=expired_code`, 302);
    }
    return c.redirect(
      `/auth/device/consent?user_code=${encodeURIComponent(normalised)}`,
      302,
    );
  });

  router.get("/device", (c) => {
    const url = new URL(c.req.url);
    const rawCode = url.searchParams.get("user_code") ?? "";
    const error = url.searchParams.get("error") ?? undefined;

    // T-093 follow-on: if the URL carries a user_code (i.e. the user
    // followed `verification_uri_complete`) and there's no error to
    // surface, jump straight to the consent screen — skipping the
    // manual "Continue" click on a form that's already pre-filled.
    // The consent route 302s to /auth/sign-in if there's no session
    // yet (preserving the user_code via return_to), so this stays
    // safe — no auto-approval, just one fewer tap. Falls through to
    // the form if the code is empty/garbled or an error is being
    // surfaced.
    const normalised = normaliseUserCode(
      rawCode.trim().toUpperCase().replace(/\s+/g, ""),
    );
    if (!error && normalised && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(normalised)) {
      return c.redirect(
        `/auth/device/consent?user_code=${encodeURIComponent(normalised)}`,
        302,
      );
    }
    setNoStore(c);
    return c.html(renderDevicePage({ prefilled: rawCode, error }));
  });

  router.get("/device/consent", async (c) => {
    const sessionResult = await requireConsentSession(c);
    if (sessionResult instanceof Response) return sessionResult;
    const url = new URL(c.req.url);
    const userCodeRaw = url.searchParams.get("user_code") ?? "";
    const userCode = normaliseUserCode(userCodeRaw.trim().toUpperCase());
    if (!userCode) {
      return c.redirect("/auth/device?error=missing_code", 302);
    }
    const row = await storage.oauth.findDeviceCodeByUserCode(userCode);
    if (!row) {
      return c.redirect("/auth/device?error=invalid_code", 302);
    }
    if (row.status !== "pending") {
      return c.redirect(
        `/auth/device?error=already_resolved&user_code=${encodeURIComponent(userCode)}`,
        302,
      );
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return c.redirect(`/auth/device?error=expired_code`, 302);
    }
    // T-131: client lookup migrated to plugin tables.
    const client = await storage.oauthProvider?.getClient(row.client_id);
    if (!client) {
      throw new MymeError(ErrorCode.INVALID_CLIENT, "Unknown client_id");
    }

    // Render the same consent template as /auth/authorize. The submit
    // target is /auth/device/consent (not /auth/authorize), and the
    // hidden user_code field replaces the OAuth code-flow params.
    const requestedScopes = row.scopes;
    const expanded = expandWildcardScopes(requestedScopes, knownTypes);
    const parsedScopes = expanded
      .map(parseScope)
      .filter(
        (s): s is NonNullable<ReturnType<typeof parseScope>> => s !== null,
      );
    const descriptions: Record<string, string> = {};
    for (const s of parsedScopes) {
      const typeEntry = TYPE_REGISTRY.get(s.typePattern);
      if (typeEntry?.description) {
        descriptions[s.typePattern] = typeEntry.description;
      } else {
        const fallback =
          METADATA_SCOPE_DESCRIPTIONS[s.typePattern] ??
          // T-074: OIDC literals (openid / profile / email).
          OIDC_SCOPE_DESCRIPTIONS[s.typePattern];
        if (fallback) descriptions[s.typePattern] = fallback;
      }
    }

    setNoStore(c);
    return c.html(
      renderDeviceConsentScreen({
        clientName: client.name ?? client.clientId,
        scopes: parsedScopes,
        userCode,
        descriptions,
      }),
    );
  });

  router.post("/device/consent", async (c) => {
    const sessionResult = await requireConsentSession(c);
    if (sessionResult instanceof Response) return sessionResult;

    const formData = await c.req.formData();
    const userCodeRaw = formData.get("user_code");
    const userCode =
      typeof userCodeRaw === "string"
        ? normaliseUserCode(userCodeRaw.trim().toUpperCase())
        : "";
    const decision = formData.get("decision");
    if (!userCode || (decision !== "approve" && decision !== "deny")) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "user_code and decision are required",
      );
    }
    const row = await storage.oauth.findDeviceCodeByUserCode(userCode);
    if (!row) {
      throw new MymeError(ErrorCode.NOT_FOUND, "Unknown user_code");
    }
    if (row.status !== "pending") {
      return c.redirect(
        `/auth/device?error=already_resolved&user_code=${encodeURIComponent(userCode)}`,
        302,
      );
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return c.redirect(`/auth/device?error=expired_code`, 302);
    }

    if (decision === "deny") {
      await storage.oauth.denyDeviceCode(row.id);
      setNoStore(c);
      return c.html(renderDeviceDecisionPage({ approved: false }));
    }

    // Approve: create (or update) the system.connection (kind: app)
    // projection through ItemStore (F15 upsert) and flip the
    // device-code row to approved.
    const grant = await createUserAppGrant(
      storage,
      sessionResult.session.user,
      row.client_id,
      row.scopes,
      "myme/oauth/device",
    );
    const ok = await storage.oauth.approveDeviceCode(row.id, grant.id);
    if (!ok) {
      // Race: someone else flipped it in between. Surface as already-resolved.
      return c.redirect(
        `/auth/device?error=already_resolved&user_code=${encodeURIComponent(userCode)}`,
        302,
      );
    }
    // F16: emit `auth.grant.created` audit row for the device-flow
    // consent approval (CLAUDE.md's audit-row table claims this fires;
    // pre-fix it didn't). `source: "device"` distinguishes from the
    // code-flow path which uses the implicit default (source absent).
    // Resolve tenant_id for the audit row from the same users-table
    // lookup createUserAppGrant did — duplicated cheaply here to avoid
    // changing the helper's signature.
    let auditTenantId: string | null = null;
    if (storage.users) {
      const userRow = await storage.users.getByAuthUserId(
        sessionResult.session.user.id,
      );
      auditTenantId = userRow?.tenant_id ?? null;
    }
    void storage.audit.log({
      tenant_id: auditTenantId,
      action: "auth.grant.created",
      resource_type: "oauth_grant",
      resource_id: row.client_id,
      client_ip: c.var.clientIp ?? null,
      details: {
        client_id: row.client_id,
        user_id: sessionResult.session.user.id,
        scopes: row.scopes,
        grant_item_id: grant.id,
        source: "device",
        // `created: false` means re-consent (item already existed) —
        // useful for the operator trail to distinguish first-time
        // approvals from re-approvals of an existing grant.
        created: grant.created,
      },
    });
    setNoStore(c);
    return c.html(renderDeviceDecisionPage({ approved: true }));
  });

  router.post("/device/token", async (c) => {
    const formData = await c.req.formData();
    const grantType = formData.get("grant_type");
    const deviceCodeRaw = formData.get("device_code");
    const clientId = formData.get("client_id");

    if (
      grantType !== "urn:ietf:params:oauth:grant-type:device_code" ||
      typeof deviceCodeRaw !== "string" ||
      typeof clientId !== "string"
    ) {
      return c.json(
        {
          error: "invalid_request",
          error_description:
            "grant_type, device_code, and client_id are required",
        },
        400,
      );
    }

    const row = await storage.oauth.findDeviceCodeByHash(sha256(deviceCodeRaw));
    if (row?.client_id !== clientId) {
      return c.json(
        { error: "invalid_grant", error_description: "Unknown device_code" },
        400,
      );
    }

    if (new Date(row.expires_at).getTime() < Date.now()) {
      return c.json(
        { error: "expired_token", error_description: "device_code expired" },
        400,
      );
    }

    if (row.status === "denied") {
      return c.json(
        {
          error: "access_denied",
          error_description: "User denied the request",
        },
        400,
      );
    }

    if (row.status === "pending") {
      // Slow-down detection: if the client polled inside the interval
      // window, return slow_down + bumped interval.
      const now = new Date();
      if (row.last_polled_at) {
        const elapsed = now.getTime() - new Date(row.last_polled_at).getTime();
        if (elapsed < row.interval_seconds * 1000) {
          await storage.oauth.markDeviceCodePolled(row.id, now.toISOString());
          return c.json(
            {
              error: "slow_down",
              error_description: "Polling too fast — wait longer",
            },
            400,
          );
        }
      }
      await storage.oauth.markDeviceCodePolled(row.id, now.toISOString());
      return c.json(
        {
          error: "authorization_pending",
          error_description: "User has not yet approved",
        },
        400,
      );
    }

    // status === "approved" — issue tokens against the connection grant.
    if (!row.connection_item_id) {
      // Invariant violation: status was flipped to approved without a
      // connection_item_id. Surface as 500 with a clear message.
      throw new Error(
        "Approved device-code is missing connection_item_id (invariant violation)",
      );
    }

    // T-131: terminal token issuance. The plugin owns the canonical
    // token storage tables (`auth_oauth_access_token`,
    // `auth_oauth_refresh_token`); we mint into them directly so the
    // bearer middleware resolves device-flow tokens identically to
    // authorization-code-flow tokens. The hash function (`hashApiKey`)
    // is the same one the plugin's `storeTokens.hash` is wired to.
    //
    // **Prefix-stripped hash, matching the plugin convention.** The
    // plugin strips `prefix.opaqueAccessToken` / `prefix.refreshToken`
    // BEFORE calling its hasher (`index.mjs:419` for issuance,
    // `:858`/`:2266` for lookup). To stay symmetric — so the bearer
    // middleware finds device-flow tokens by computing the same hash
    // — we strip here too. Without this, device-flow access tokens
    // would 401 on every request because the middleware's lookup hash
    // wouldn't match the stored one.
    const accessRaw = generateToken(ACCESS_TOKEN_PREFIX);
    const refreshRaw = generateToken(REFRESH_TOKEN_PREFIX);
    const accessBare = accessRaw.slice(ACCESS_TOKEN_PREFIX.length);
    const refreshBare = refreshRaw.slice(REFRESH_TOKEN_PREFIX.length);
    const accessHash = hashApiKey(accessBare, salt);
    const refreshHash = hashApiKey(refreshBare, salt);

    // Resolve the underlying system.connection (grant) so we can pull
    // tenant_id + the scopes the user actually approved. The grant
    // properties already carry the scope set; we read them as the
    // authoritative input to the token-mint.
    const deviceGrant = await storage.items.get(row.connection_item_id);
    const grantProps = deviceGrant?.properties ?? {};
    const grantScopes = Array.isArray(grantProps.scopes)
      ? (grantProps.scopes as string[])
      : [];
    const grantClientId =
      typeof grantProps.client_id === "string"
        ? grantProps.client_id
        : row.client_id;
    const grantUserId =
      typeof grantProps.user_id === "string" ? grantProps.user_id : undefined;
    if (!grantUserId) {
      // System.connection projection lands the user_id property; if it
      // hasn't yet, fail loud rather than silently issue an orphan token.
      throw new Error(
        "Device-flow grant missing user_id property (projection not run?)",
      );
    }
    if (typeof storage.oauthProvider?.mintTokenPair !== "function") {
      throw new Error("oauthProvider store not wired");
    }
    await storage.oauthProvider.mintTokenPair({
      accessTokenHash: accessHash,
      refreshTokenHash: refreshHash,
      clientId: grantClientId,
      authUserId: grantUserId,
      referenceId: deviceGrant?.tenant_id ?? null,
      scopes: grantScopes,
      accessTtlMs: ACCESS_TOKEN_TTL_MS,
    });

    // T-098: stamp last_used_at on the underlying grant — best-effort.
    await stampOAuthGrantLastUsed(
      storage,
      row.connection_item_id,
      deviceGrant?.tenant_id ?? undefined,
    );

    return c.json({
      access_token: accessRaw,
      refresh_token: refreshRaw,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      scope: grantScopes.join(" "),
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Device Authorization Grant — local helpers
// ---------------------------------------------------------------------------

const DEVICE_CODE_PREFIX = "myme_dc_";
const DEVICE_CODE_TTL_MS = 600_000; // 10 minutes
const DEVICE_CODE_DEFAULT_INTERVAL_SECONDS = 5;

/** Alphabet for user_code — restricted to avoid I/O/0/1/U/V ambiguity.
 *  24 chars × 8 positions = ~110 billion. Plenty for 10-min TTL. */
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTWXYZ23456789";
/** 8 alphanum chars, hyphenated XXXX-XXXX. */
function generateUserCode(): string {
  const bytes = randomBytes(8);
  const chars: string[] = [];
  for (const b of bytes) {
    const idx = b % USER_CODE_ALPHABET.length;
    chars.push(USER_CODE_ALPHABET.charAt(idx));
  }
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** Normalise a user-submitted code to the storage shape: uppercase,
 *  hyphenated XXXX-XXXX. Accepts the user typing without the hyphen. */
function normaliseUserCode(input: string): string {
  const stripped = input.replace(/-/g, "").toUpperCase();
  if (stripped.length !== 8) return input.toUpperCase();
  return `${stripped.slice(0, 4)}-${stripped.slice(4)}`;
}

/** Build a redirect URL back to the sign-up page with error + return_to. */
function buildSignUpRedirect(params: {
  returnTo: string;
  error?: string;
}): string {
  const search = new URLSearchParams();
  if (params.error) search.set("error", params.error);
  if (params.returnTo && params.returnTo !== "/") {
    search.set("return_to", params.returnTo);
  }
  const query = search.toString();
  return `/auth/sign-up${query ? `?${query}` : ""}`;
}

/** Build a redirect URL back to the sign-in page with the right query
 *  shape (mode, error, sent, return_to). All values are encoded. */
function buildSignInRedirect(params: {
  mode: string;
  returnTo: string;
  error?: string;
  sent?: boolean;
}): string {
  const search = new URLSearchParams();
  if (params.mode === "magic") search.set("mode", "magic");
  if (params.error) search.set("error", params.error);
  if (params.sent) search.set("sent", "1");
  if (params.returnTo && params.returnTo !== "/") {
    search.set("return_to", params.returnTo);
  }
  const query = search.toString();
  return `/auth/sign-in${query ? `?${query}` : ""}`;
}

/** Forward selected headers (origin, cookie) from the inbound request
 *  onto the upstream Better Auth dispatch. Origin matters for Better
 *  Auth's trustedOrigins check; cookie matters when re-signing-in
 *  while a stale session cookie is present. Other headers (host,
 *  content-length) are recomputed by the constructor.
 *
 *  When the inbound `Origin` is missing or the literal string `"null"`
 *  (browsers serialize Origin as `"null"` for navigations under
 *  privacy-strict referrer policies, sandboxed iframes, etc.), fall
 *  back to `fallbackOrigin`. The dispatch is server-internal — Better
 *  Auth's CSRF check is on the OUTER (browser→server) request; the
 *  authoritative origin for the upstream dispatch is the auth instance
 *  itself.
 */
/** Wave C PR7 — map the `?notice=` query param on /auth/security to
 *  the flash banner the page renders. Unknown codes resolve to
 *  `undefined` (no banner) rather than 500ing. */
function parseNotice(
  raw: string | null,
): { kind: "success" | "error"; text: string } | undefined {
  if (!raw) return undefined;
  const messages: Record<string, { kind: "success" | "error"; text: string }> =
    {
      grant_revoked: {
        kind: "success",
        text: "App access revoked. The app will no longer be able to access your data.",
      },
      grant_not_found: {
        kind: "error",
        text: "That app was already revoked or no longer exists.",
      },
      session_revoked: {
        kind: "success",
        text: "Session signed out. The device will need to sign in again.",
      },
      session_not_found: {
        kind: "error",
        text: "That session was already signed out or no longer exists.",
      },
      session_revoke_failed: {
        kind: "error",
        text: "Couldn't sign out that session. Try again in a moment.",
      },
      cannot_revoke_current: {
        kind: "error",
        text: "Use Sign out everywhere to revoke the current session.",
      },
    };
  return messages[raw];
}

function forwardHeaders(
  src: Headers,
  base: Record<string, string>,
  fallbackOrigin?: string,
): Headers {
  const out = new Headers(base);
  const passthrough = ["origin", "cookie", "user-agent", "accept-language"];
  for (const name of passthrough) {
    const value = src.get(name);
    if (value) out.set(name, value);
  }
  const incomingOrigin = out.get("origin");
  if (fallbackOrigin && (!incomingOrigin || incomingOrigin === "null")) {
    out.set("origin", fallbackOrigin);
  }
  return out;
}

// ---------------------------------------------------------------------------
// /.well-known/oauth-authorization-server — discovery doc
// ---------------------------------------------------------------------------
