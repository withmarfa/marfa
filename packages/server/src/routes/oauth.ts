import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  MymeError,
  ErrorCode,
  parseScope,
  expandWildcardScopes,
  TYPE_REGISTRY,
} from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin, requireAuth, hashApiKey } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type {
  MymeAuth,
  MymeAuthSession,
  MymeAuthSessionUser,
} from "../auth/instance.js";
import { renderConsentScreen } from "./consent.js";
import { renderSignInPage, validateReturnTo } from "./sign-in-page.js";
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
import { constantTimeEqual } from "../utils/crypto.js";
import { publish } from "../pubsub.js";

const ACCESS_TOKEN_PREFIX = "myme_at_";
const REFRESH_TOKEN_PREFIX = "myme_rt_";
const ACCESS_TOKEN_TTL_MS = 3600_000; // 1 hour
const CODE_TTL_MS = 600_000; // 10 minutes

/**
 * Plain-English descriptions for the metadata-layer sub-resource scopes.
 * Type scopes pull their descriptions from `TYPE_REGISTRY`; these don't
 * correspond to a registered type, so they live alongside the route.
 */
const METADATA_SCOPE_DESCRIPTIONS: Record<string, string> = {
  metadata: "Read or write any metadata-layer resource",
  "metadata.types": "Register and update custom data types in your workspace",
};

function generateToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("hex")}`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

/**
 * Persist a user-app-grant connection through `ItemStore.create` so the
 * row gets full ItemStore treatment: `tenant_id` stamping (T-004), search
 * indexing, metadata-row insertion (so subsequent setTags / setExtension
 * actually write), the `created` event emission, and `source` / `origin`
 * stamping (T-005). Returns the new connection-item id.
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
  cycle: AppEnv["Variables"]["cycle"],
): Promise<{ id: string }> {
  let tenantId: string | undefined;
  if (storage.users) {
    const user = await storage.users.getByEmail(consentingUser.email);
    tenantId = user?.tenant_id;
    if (!tenantId) {
      throw new MymeError(
        ErrorCode.UNAUTHORIZED,
        "No Myme tenant is provisioned for this account; complete onboarding first",
      );
    }
  }
  const now = new Date().toISOString();
  const item = await storage.items.create(
    {
      type: "system.connection",
      tier: "library",
      state: "active",
      properties: {
        kind: "user-app-grant",
        client_id: clientId,
        scopes,
        status: "active",
        granted_at: now,
      },
      source,
      origin: "user",
    },
    tenantId,
  );
  const metadata = await storage.metadata.get(item.id);
  await publish({ type: "created", item, metadata, tenantId, ...cycle });
  return { id: item.id };
}

export function authRoutes(
  storage: Storage,
  salt: string,
  auth?: MymeAuth,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const knownTypes = Array.from(TYPE_REGISTRY.keys());

  // Wave C PR3 / T-033: per-email throttle on `/auth/forgot-password`.
  // 3 requests per email per hour. Sits on top of the per-IP rate
  // limit configured in `middleware/rate-limit.ts` — per-IP bounds a
  // noisy client; per-email bounds the address itself so a burst from
  // many IPs can't drown one user's inbox. In-memory only; multi-
  // instance deployments would need a shared counter (deferred).
  const forgotPasswordThrottle = new PerEmailThrottle({
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
  // Client registration
  // -----------------------------------------------------------------------

  router.post("/clients", async (c) => {
    requireAdmin(c);
    const body = await c.req.json();
    if (!body.name || !body.redirect_uris?.length) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "name and redirect_uris are required",
      );
    }
    const client = await storage.oauth.createClient({
      name: body.name,
      redirect_uris: body.redirect_uris,
    });
    return c.json(client, 201);
  });

  router.get("/clients", async (c) => {
    requireAdmin(c);
    const clients = await storage.oauth.listClients();
    return c.json(clients);
  });

  // -----------------------------------------------------------------------
  // Authorization flow
  // -----------------------------------------------------------------------

  router.get("/authorize", async (c) => {
    const gated = await requireConsentSession(c);
    if (gated instanceof Response) return gated;

    const clientId = c.req.query("client_id");
    const responseType = c.req.query("response_type");
    const scope = c.req.query("scope");
    const redirectUri = c.req.query("redirect_uri");
    const codeChallenge = c.req.query("code_challenge");
    const codeChallengeMethod = c.req.query("code_challenge_method");
    const state = c.req.query("state") ?? "";

    if (
      !clientId ||
      responseType !== "code" ||
      !scope ||
      !redirectUri ||
      !codeChallenge
    ) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Missing required parameters: client_id, response_type=code, scope, redirect_uri, code_challenge",
      );
    }
    if (codeChallengeMethod && codeChallengeMethod !== "S256") {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Only S256 code_challenge_method is supported",
      );
    }

    const client = await storage.oauth.getClient(clientId);
    if (!client) {
      throw new MymeError(ErrorCode.INVALID_CLIENT, "Unknown client_id");
    }
    if (!client.redirect_uris.includes(redirectUri)) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "redirect_uri not registered for this client",
      );
    }

    // Parse and expand scopes
    const requestedScopes = scope.split(" ");
    const expanded = expandWildcardScopes(requestedScopes, knownTypes);
    const parsed = expanded.map(parseScope).filter((s) => s !== null);

    if (parsed.length === 0) {
      throw new MymeError(
        ErrorCode.INVALID_SCOPE,
        "No valid scopes in request",
      );
    }

    // Build the plain-English description map. Type scopes look up
    // the type registry's `description` field; metadata sub-resources
    // (`metadata.types`, future entries) carry their own canonical
    // strings — they're not items in TYPE_REGISTRY. Missing entries
    // fall back to the literal scope at render time.
    const descriptions: Record<string, string> = {};
    for (const scope of parsed) {
      if (descriptions[scope.typePattern] !== undefined) continue;
      if (scope.kind === "metadata") {
        const desc = METADATA_SCOPE_DESCRIPTIONS[scope.typePattern];
        if (desc) descriptions[scope.typePattern] = desc;
        continue;
      }
      const schema = TYPE_REGISTRY.get(scope.typePattern);
      if (schema?.description) {
        descriptions[scope.typePattern] = schema.description;
      }
    }

    // Wave C PR5 / T-032: re-consent diff. Look for an existing
    // `system.connection user-app-grant` for `(user, client_id)`.
    // The grant carries a literal scope set; we hand it to
    // `renderConsentScreen` as `priorScopes` and the renderer
    // switches to the diff variant. When there's no prior grant
    // (first-time consent) `priorScopes` stays undefined and the
    // renderer falls through to the flat read/write split.
    //
    // User → tenant binding only works in hosted mode (when
    // storage.users is wired). In keys mode there's no per-user
    // tenant — we'd potentially leak across users on a multi-user
    // self-host. Limit reconsent diff to hosted mode for now; keys
    // mode keeps the flat shape.
    const consentingUser = gated.session.user;
    let priorScopes: string[] | undefined;
    if (storage.users) {
      const userRow = await storage.users.getByEmail(consentingUser.email);
      if (userRow?.tenant_id) {
        const items = await storage.items.list({
          type: "system.connection",
          state: "active",
          tenantId: userRow.tenant_id,
        });
        // Multiple grants for the same client are unusual but possible
        // (legacy revoke + re-grant cycles). Pick the most-recently
        // granted active one — items.list returns by created_at desc by
        // default, so the first match wins.
        for (const item of items.data) {
          const props = item.properties;
          if (props.kind !== "user-app-grant") continue;
          if (props.status !== "active") continue;
          if (props.client_id !== clientId) continue;
          if (Array.isArray(props.scopes)) {
            priorScopes = (props.scopes as string[]).slice();
            break;
          }
        }
      }
    }

    // Render consent screen
    const html = renderConsentScreen({
      clientName: client.name,
      scopes: parsed,
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod: codeChallengeMethod ?? "S256",
      state,
      responseType,
      descriptions,
      priorScopes,
    });

    setNoStore(c);
    return c.html(html);
  });

  router.post("/authorize", async (c) => {
    const gated = await requireConsentSession(c);
    if (gated instanceof Response) return gated;

    const formData = await c.req.parseBody({ all: true });
    const action = formData.action as string;
    const clientId = formData.client_id as string;
    const redirectUri = formData.redirect_uri as string;
    const codeChallenge = formData.code_challenge as string;
    const codeChallengeMethod =
      (formData.code_challenge_method as string) || "S256";
    const state = (formData.state as string) || "";

    if (!clientId || !redirectUri || !codeChallenge) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Missing form parameters",
      );
    }

    // Denial
    if (action === "deny") {
      const url = new URL(redirectUri);
      url.searchParams.set("error", "access_denied");
      if (state) url.searchParams.set("state", state);
      return c.redirect(url.toString());
    }

    // Approval — collect granted scopes
    const rawScopes = formData.scopes;
    const grantedScopes: string[] = Array.isArray(rawScopes)
      ? (rawScopes as string[])
      : rawScopes
        ? [rawScopes as string]
        : [];

    if (grantedScopes.length === 0) {
      throw new MymeError(
        ErrorCode.INVALID_SCOPE,
        "At least one scope must be granted",
      );
    }

    // Create grant (routed through ItemStore.create — T-005) and authorization code.
    const grant = await createUserAppGrant(
      storage,
      gated.session.user,
      clientId,
      grantedScopes,
      "myme/oauth/authorize",
      c.var.cycle,
    );
    const rawCode = randomBytes(32).toString("hex");
    const codeHash = hashApiKey(rawCode, salt);
    const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

    await storage.oauth.createCode(
      grant.id,
      codeHash,
      codeChallenge,
      codeChallengeMethod,
      redirectUri,
      expiresAt,
    );

    const url = new URL(redirectUri);
    url.searchParams.set("code", rawCode);
    if (state) url.searchParams.set("state", state);
    return c.redirect(url.toString());
  });

  // -----------------------------------------------------------------------
  // Token endpoint (public — no auth required for token exchange)
  // -----------------------------------------------------------------------

  router.post("/token", async (c) => {
    const body = await c.req.json();
    const grantType = body.grant_type;

    if (grantType === "authorization_code") {
      return handleCodeExchange(c, body, storage, salt);
    }
    if (grantType === "refresh_token") {
      return handleRefresh(c, body, storage, salt);
    }

    throw new MymeError(ErrorCode.VALIDATION_ERROR, "Unsupported grant_type");
  });

  // -----------------------------------------------------------------------
  // Token management (authenticated)
  // -----------------------------------------------------------------------

  router.get("/tokens", async (c) => {
    requireAuth(c);
    const tokens = await storage.oauth.listTokens();
    return c.json(tokens);
  });

  router.delete("/tokens/:id", async (c) => {
    requireAuth(c);
    await storage.oauth.revokeToken(c.req.param("id"));
    return c.body(null, 204);
  });

  router.patch("/tokens/:id", async (c) => {
    requireAuth(c);
    const body = await c.req.json();
    if (!body.scopes) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "scopes is required");
    }
    await storage.oauth.reduceTokenScope(c.req.param("id"), body.scopes);
    return c.json({ status: "ok" });
  });

  // -----------------------------------------------------------------------
  // /auth/grants — typed query into system.connection items
  //
  // The user's "approved apps" surface. Reads system.connection items
  // with kind: user-app-grant. DELETE flips status → revoked and
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
      if (props.kind !== "user-app-grant") continue;
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
      throw new MymeError(ErrorCode.NOT_FOUND, "Grant not found");
    }
    const props = item.properties;
    if (props.kind !== "user-app-grant") {
      throw new MymeError(ErrorCode.NOT_FOUND, "Grant not found");
    }
    const now = new Date().toISOString();
    await storage.items.update(
      id,
      {
        properties: { ...props, status: "revoked", revoked_at: now },
      },
      tenantId,
    );
    // Cascade-revoke every token + code issued under this connection.
    await storage.oauth.revokeGrantTokens(id);
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
    const returnTo = validateReturnTo(url.searchParams.get("return_to"));
    const error = url.searchParams.get("error") ?? undefined;
    const magicLinkSent = url.searchParams.get("sent") === "1";

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
      return new Response(null, { status: 302, headers: redirectHeaders });
    }

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
    const password = formData.get("password");
    const passwordConfirm = formData.get("password_confirm");
    const emailStr = typeof email === "string" ? email.trim() : "";
    const nameStr = typeof name === "string" ? name.trim() : "";
    const passwordStr = typeof password === "string" ? password : "";
    const passwordConfirmStr =
      typeof passwordConfirm === "string" ? passwordConfirm : "";

    const errorRedirect = (errCode: string): Response =>
      c.redirect(buildSignUpRedirect({ returnTo, error: errCode }), 302);

    if (!emailStr || !nameStr || !passwordStr || !passwordConfirmStr) {
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
  //     (Resend dedupe via per-token idempotency key set on the
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
    const throttle = forgotPasswordThrottle.attempt(emailStr);
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
      // Success — render the success page. `revokeSessionsOnPasswordReset:
      // true` already nuked any other sessions for this user; the
      // user has no active session now and must sign in fresh.
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
      const userRow = await storage.users.getByEmail(sessionUser.email);
      tenantId = userRow?.tenant_id;
    }
    const grantItems = await storage.items.list({
      type: "system.connection",
      state: "active",
      tenantId,
    });
    // Resolve client names in one batch — list every oauth client and
    // map by id. The list is small (typically tens) so the batch
    // fetch is cheaper than per-grant lookups.
    const clients = await storage.oauth.listClients();
    const clientById = new Map<string, string>();
    for (const cli of clients) clientById.set(cli.id, cli.name);

    const grants: SecurityPageGrant[] = [];
    for (const item of grantItems.data) {
      const props = item.properties;
      if (props.kind !== "user-app-grant") continue;
      if (props.status !== "active") continue;
      const clientId =
        typeof props.client_id === "string" ? props.client_id : "";
      grants.push({
        id: item.id,
        client_name: clientById.get(clientId) ?? clientId,
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
      const userRow = await storage.users.getByEmail(sessionUser.email);
      tenantId = userRow?.tenant_id;
    }
    const id = c.req.param("id");
    const item = await storage.items.get(id, tenantId);
    if (item?.type !== "system.connection") {
      return c.redirect("/auth/security?notice=grant_not_found", 302);
    }
    const props = item.properties;
    if (props.kind !== "user-app-grant") {
      return c.redirect("/auth/security?notice=grant_not_found", 302);
    }
    const now = new Date().toISOString();
    await storage.items.update(
      id,
      { properties: { ...props, status: "revoked", revoked_at: now } },
      tenantId,
    );
    await storage.oauth.revokeGrantTokens(id);
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

  router.post("/device", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      // -------------------- Initiate flow --------------------
      let body: { client_id?: unknown; scope?: unknown };
      try {
        body = await c.req.json();
      } catch {
        throw new MymeError(ErrorCode.VALIDATION_ERROR, "JSON body required");
      }
      const clientId =
        typeof body.client_id === "string" ? body.client_id : null;
      const scope = typeof body.scope === "string" ? body.scope.trim() : "";
      if (!clientId || !scope) {
        throw new MymeError(
          ErrorCode.VALIDATION_ERROR,
          "client_id and scope are required",
        );
      }
      const client = await storage.oauth.getClient(clientId);
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
        throw new MymeError(
          ErrorCode.INVALID_SCOPE,
          "No valid scopes requested",
        );
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
    }

    // -------------------- Form submit user_code --------------------
    const formData = await c.req.formData();
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
    const prefilled = url.searchParams.get("user_code") ?? "";
    const error = url.searchParams.get("error") ?? undefined;
    setNoStore(c);
    return c.html(renderDevicePage({ prefilled, error }));
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
    const client = await storage.oauth.getClient(row.client_id);
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
        const fallback = METADATA_SCOPE_DESCRIPTIONS[s.typePattern];
        if (fallback) descriptions[s.typePattern] = fallback;
      }
    }

    setNoStore(c);
    return c.html(
      renderDeviceConsentScreen({
        clientName: client.name,
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

    // Approve: create a system.connection (kind: user-app-grant) routed
    // through ItemStore.create (T-005) and flip the device-code row to
    // approved.
    const grant = await createUserAppGrant(
      storage,
      sessionResult.session.user,
      row.client_id,
      row.scopes,
      "myme/oauth/device",
      c.var.cycle,
    );
    const ok = await storage.oauth.approveDeviceCode(row.id, grant.id);
    if (!ok) {
      // Race: someone else flipped it in between. Surface as already-resolved.
      return c.redirect(
        `/auth/device?error=already_resolved&user_code=${encodeURIComponent(userCode)}`,
        302,
      );
    }
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

    const accessRaw = generateToken(ACCESS_TOKEN_PREFIX);
    const refreshRaw = generateToken(REFRESH_TOKEN_PREFIX);
    const accessHash = sha256(accessRaw);
    const refreshHash = sha256(refreshRaw);
    const accessExpiresAt = new Date(
      Date.now() + ACCESS_TOKEN_TTL_MS,
    ).toISOString();
    const refreshExpiresAt = new Date(
      Date.now() + 30 * 24 * 3600_000,
    ).toISOString();

    const accessToken = await storage.oauth.createToken(
      row.connection_item_id,
      accessHash,
      "access",
      accessExpiresAt,
    );
    await storage.oauth.createToken(
      row.connection_item_id,
      refreshHash,
      "refresh",
      refreshExpiresAt,
    );

    return c.json({
      access_token: accessRaw,
      refresh_token: refreshRaw,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      scope: accessToken.scopes.join(" "),
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

export function discoveryRoutes(baseUrl: string): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get("/oauth-authorization-server", (c) => {
    return c.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/auth/authorize`,
      token_endpoint: `${baseUrl}/auth/token`,
      registration_endpoint: `${baseUrl}/auth/clients`,
      grant_types_supported: ["authorization_code", "refresh_token"],
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });
  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function handleCodeExchange(
  c: { json: (data: unknown, status?: number) => Response },
  body: Record<string, string>,
  storage: Storage,
  salt: string,
): Promise<Response> {
  const { code, code_verifier, redirect_uri } = body;

  if (!code || !code_verifier || !redirect_uri) {
    throw new MymeError(
      ErrorCode.VALIDATION_ERROR,
      "code, code_verifier, and redirect_uri are required",
    );
  }

  const codeHash = hashApiKey(code, salt);
  const codeRecord = await storage.oauth.consumeCode(codeHash);

  if (!codeRecord) {
    throw new MymeError(
      ErrorCode.INVALID_GRANT,
      "Invalid, expired, or already-used authorization code",
    );
  }

  // Verify redirect_uri matches
  if (codeRecord.redirect_uri !== redirect_uri) {
    throw new MymeError(
      ErrorCode.VALIDATION_ERROR,
      "redirect_uri does not match",
    );
  }

  // PKCE verification: SHA256(code_verifier) must equal code_challenge.
  // Compared with timing-safe equality — the attacker controls one side
  // (code_verifier) and the challenge is derived deterministically from
  // a server-issued secret, so any byte-level timing leak is exploitable.
  const computedChallenge = sha256(code_verifier);
  if (!constantTimeEqual(computedChallenge, codeRecord.code_challenge)) {
    throw new MymeError(ErrorCode.INVALID_GRANT, "PKCE verification failed");
  }

  // Issue tokens
  const accessRaw = generateToken(ACCESS_TOKEN_PREFIX);
  const refreshRaw = generateToken(REFRESH_TOKEN_PREFIX);
  const accessHash = hashApiKey(accessRaw, salt);
  const refreshHash = hashApiKey(refreshRaw, salt);
  const accessExpiresAt = new Date(
    Date.now() + ACCESS_TOKEN_TTL_MS,
  ).toISOString();
  const refreshExpiresAt = new Date(
    Date.now() + 90 * 24 * 3600_000,
  ).toISOString(); // 90 days

  const accessToken = await storage.oauth.createToken(
    codeRecord.connection_item_id,
    accessHash,
    "access",
    accessExpiresAt,
  );
  await storage.oauth.createToken(
    codeRecord.connection_item_id,
    refreshHash,
    "refresh",
    refreshExpiresAt,
  );

  return c.json({
    access_token: accessRaw,
    refresh_token: refreshRaw,
    token_type: "bearer",
    expires_in: 3600,
    scope: accessToken.scopes.join(" "),
  });
}

async function handleRefresh(
  c: { json: (data: unknown, status?: number) => Response },
  body: Record<string, string>,
  storage: Storage,
  salt: string,
): Promise<Response> {
  const { refresh_token } = body;

  if (!refresh_token) {
    throw new MymeError(
      ErrorCode.VALIDATION_ERROR,
      "refresh_token is required",
    );
  }

  const refreshHash = hashApiKey(refresh_token, salt);
  const refreshRecord = await storage.oauth.validateToken(refreshHash);

  if (refreshRecord?.token_type !== "refresh") {
    throw new MymeError(ErrorCode.INVALID_GRANT, "Invalid refresh token");
  }

  // Mark refresh token as used (single-use rotation)
  const wasUnused = await storage.oauth.markRefreshUsed(refreshRecord.id);
  if (!wasUnused) {
    // Replay detected — revoke all tokens for this grant
    await storage.oauth.revokeGrantTokens(refreshRecord.connection_item_id);
    throw new MymeError(
      ErrorCode.TOKEN_REUSE_DETECTED,
      "Refresh token reuse detected, all tokens revoked",
    );
  }

  // Issue new token pair
  const accessRaw = generateToken(ACCESS_TOKEN_PREFIX);
  const newRefreshRaw = generateToken(REFRESH_TOKEN_PREFIX);
  const accessHash = hashApiKey(accessRaw, salt);
  const newRefreshHash = hashApiKey(newRefreshRaw, salt);
  const accessExpiresAt = new Date(
    Date.now() + ACCESS_TOKEN_TTL_MS,
  ).toISOString();
  const refreshExpiresAt = new Date(
    Date.now() + 90 * 24 * 3600_000,
  ).toISOString();

  const accessToken = await storage.oauth.createToken(
    refreshRecord.connection_item_id,
    accessHash,
    "access",
    accessExpiresAt,
  );
  await storage.oauth.createToken(
    refreshRecord.connection_item_id,
    newRefreshHash,
    "refresh",
    refreshExpiresAt,
  );

  return c.json({
    access_token: accessRaw,
    refresh_token: newRefreshRaw,
    token_type: "bearer",
    expires_in: 3600,
    scope: accessToken.scopes.join(" "),
  });
}
