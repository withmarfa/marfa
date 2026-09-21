import type { Context } from "hono";
import { Hono } from "hono";
import { MarfaError, ErrorCode, parseScope } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requirePermission, requireAuth } from "../middleware/auth.js";
import { buildScopeDescriptions } from "./auth-consent.js";
import { getPermissionBundles } from "../config.js";
import type { Storage } from "../storage/interface.js";
import type {
  DeviceCodeRefusal,
  MarfaAuth,
  MarfaAuthSession,
  MarfaAuthSessionUser,
} from "../auth/instance.js";
import {
  renderSignInPage,
  synthesizeOauthReturnTo,
  validateReturnTo,
} from "./sign-in-page.js";
import { renderSignedOutPage } from "./signed-out-page.js";
import { PerEmailThrottle } from "../auth/per-email-throttle.js";
import { withConsentLock } from "../auth/consent-lock.js";
import {
  auditGrantRevoked,
  revokeProjectedGrant,
} from "../auth/grant-lifecycle.js";
import {
  renderDevicePage,
  renderDeviceConsentScreen,
  renderDeviceDecisionPage,
} from "./device-pages.js";
import { setNoStore } from "./no-store.js";
import { forwardHeaders } from "./forward-headers.js";
import { publish } from "../pubsub.js";
import type { OidcSigner } from "../auth/oidc-signing.js";

/**
 * Persist (or refresh) a `kind: app` connection through `ItemStore`. Routes
 * through `ItemStore.create` on first consent and `ItemStore.update` on
 * re-consent so the row gets full ItemStore treatment: search indexing, metadata-row insertion, versions snapshot on
 * re-consent, the `created`/`updated` event emission, and `source` /
 * `origin` stamping. Returns the connection-item id, whether the call
 * created vs updated the projection, and the scope list the record now
 * holds, which on re-consent is the union rather than the request, so the
 * caller's audit row can report both without recomputing it.
 *
 * Uses `findGrantItemId` to detect the re-consent case and routes through
 * `items.update` (same shape as the code-flow consent's
 * `projectGrantOnConsent`). Status flips to "active" + `revoked_at` is
 * cleared on re-consent to avoid stale-revoked projections. The scopes it
 * writes there are the standing grant plus this approval, never less: an
 * untick on the device screen reaches the token this device is issued, which
 * the plugin mints for the code's own narrowed scope, rather than the record.
 * A revoked grant is not a standing one, so it contributes nothing and the
 * record comes back at the approval alone.
 *
 * **`source` is the device literal and not the wider union it used to
 * declare.** There is one caller. The merge rule inside is specific to the
 * device surface, and the authorize surface has the deliberate opposite
 * contract: a narrowing there is a decision the user made and revokes the
 * tokens carrying what was dropped. Advertising this
 * function as serving both would let a future authorize caller pick it up
 * and silently disable that revoke.
 */
async function createUserAppGrant(
  storage: Storage,
  consentingUser: MarfaAuthSessionUser,
  clientId: string,
  scopes: string[],
  source: "marfa/oauth/device",
): Promise<{
  id: string;
  created: boolean;
  scopes: string[];
}> {
  const now = new Date().toISOString();

  // Detect re-consent — update in place if a projection exists, else insert.
  let existingItemId: string | null = null;
  if (typeof storage.oauthProvider?.findGrantItemId === "function") {
    existingItemId = await storage.oauthProvider.findGrantItemId({
      clientId,
      authUserId: consentingUser.id,
    });
  }

  if (existingItemId) {
    // Re-consent: flip status back to "active" + clear revoked_at; same
    // rationale as projectGrantOnConsent in auth-consent.ts.
    const existing = await storage.items.get(existingItemId);
    if (!existing) {
      // Race — findGrantItemId saw a row but a concurrent delete
      // raced. Fall through to insert.
    } else {
      // Union rather than overwrite. This screen offers per-scope toggles,
      // so a narrower set arriving here may be the client asking for less or
      // the person unticking a row and nothing at this call site can tell
      // them apart. The record keeps the standing grant either way,
      // deliberately; what the untick reaches is the token this device is
      // issued.
      //
      // **A revoked grant contributes nothing to that merge, because the
      // rule is about a STANDING grant and a revoked one is not standing.**
      // `findGrantItemId` matches on (client, user) and has no status
      // predicate, so it hands back a revoked row as readily as a live one,
      // and `revokeProjectedGrant` above leaves `scopes` verbatim on the row
      // it flips. Merging against that set folds a scope the user explicitly
      // withdrew back into the record and flips the record active holding
      // it — access restored by a login whose consent screen never showed
      // it. Re-establishing at the request is the whole of the fix: the
      // re-consent still reactivates the row, and it comes back at exactly
      // what this approval asked for.
      //
      // **Both axes, because both read surfaces filter on both.**
      // `GET /grants` and the security page each list with `state: "active"`
      // and then skip a row whose `properties.status` is not "active", so a
      // row failing either axis is beyond the Disconnect button while the
      // token step below still mints against it.
      //
      // **The lookup is the first fence now, and this is the second.**
      // `findGrantItemId` carries its own `state = 'active'` predicate, so a
      // row sitting at `state: "revoked"` no longer reaches this branch at
      // all — the approval falls through to the fresh insert below and the
      // unreachable row is left where it is. That predicate lives in the
      // store rather than here because the code-flow twin
      // (`projectGrantOnConsent` in `auth-consent.ts`) resolves through the
      // same method and had the identical defect. This read stays because
      // it guards the axis the lookup does not: a row the store admits can
      // still hold `status: "revoked"`, and merging against a withdrawn
      // scope set is what the clause below refuses.
      //
      // Tested FOR "active" on both rather than against "revoked", which
      // decides the absent and unrecognized cases the safe way round: a
      // state or status this code cannot read is not evidence the user
      // granted anything, so the approval re-establishes at its own request
      // instead of resurrecting scopes nobody can account for.
      const standingScopes =
        existing.state === "active" &&
        existing.properties.status === "active" &&
        Array.isArray(existing.properties.scopes)
          ? (existing.properties.scopes as string[])
          : [];
      const mergedScopes = [...new Set([...standingScopes, ...scopes])];
      const updated = await storage.items.update(existingItemId, {
        properties: {
          scopes: mergedScopes,
          status: "active",
          granted_at: now,
          revoked_at: undefined,
        },
      });
      if (!("error" in updated)) {
        const metadata = await storage.metadata.get(updated.id);
        await publish({
          type: "updated",
          item: updated,
          metadata,
        });
        return {
          id: updated.id,
          created: false,
          scopes: mergedScopes,
        };
      }
    }
  }

  // First-time consent: insert a fresh row. No tier named: `tier` is a
  // server-owned field on a `system.*` row (`_tier-rules.ts`), and every
  // writer of one leaves it to the store the way `POST /items` does.
  const item = await storage.items.create({
    type: "system.connection",
    state: "active",
    properties: {
      kind: "app",
      client_id: clientId,
      // Store the consenting auth_user id so the revoke cascade
      // (`revokeTokensForGrant(clientId, userId)`) can find the user.
      user_id: consentingUser.id,
      scopes,
      status: "active",
      granted_at: now,
    },
    source,
  });
  const metadata = await storage.metadata.get(item.id);
  await publish({ type: "created", item, metadata });
  return { id: item.id, created: true, scopes };
}

/**
 * Note on the signature: the @better-auth/oauth-provider plugin owns
 * token issuance + id_token signing, with its own salt + signer wired
 * through `instance.ts`. `oidcSigner` is threaded into `authRoutes` by
 * app.ts and is read by nothing here. This package is private and both
 * callers are in this repository, so the parameter buys nothing and is
 * carried only until the module it names goes.
 */
export function authRoutes(
  storage: Storage,
  auth?: MarfaAuth,
  oidcSigner?: OidcSigner,
): Hono<AppEnv> {
  void oidcSigner;
  const router = new Hono<AppEnv>();

  // Per-`user_code` failed-attempt throttle on the device-flow
  // verification form (`POST /auth/device` user-code submission). The
  // per-IP cap in `middleware/rate-limit.ts` bounds a single client
  // guessing codes, but a distributed guesser spreading attempts across
  // many IPs would slip under it. This counter is keyed on the submitted
  // `user_code` itself (independent of IP) and denies once a code has
  // accumulated too many failed lookups — so a brute-force sweep against
  // the short user-code range is capped per code across every process
  // pointed at the database. Only
  // failed submissions increment; a valid code that advances to consent
  // never touches the counter, so the legitimate flow is unaffected.
  // `PerEmailThrottle` is a generic keyed-counter over
  // `storage.rateLimits`; reused here with a device-code key prefix.
  const deviceUserCodeThrottle = new PerEmailThrottle(storage, {
    family: "device-user-code",
    keyPrefix: "device-user-code:",
    limit: DEVICE_USER_CODE_MAX_ATTEMPTS,
    windowMs: 60 * 60 * 1000,
  });

  /**
   * Gate `/auth/authorize` on a Better Auth cookie session. Every caller must
   * be signed in before the consent screen renders or processes a decision.
   * Unauthenticated requests are redirected to `/auth/sign-in` with the
   * original URL preserved as `return_to` so the sign-in flow can pick up
   * where the OAuth flow left off.
   *
   * Returns the active session on success; the caller responds to a
   * `null` return by issuing the redirect (no further work to do).
   */
  async function requireConsentSession(
    c: Context<AppEnv>,
  ): Promise<{ kind: "session"; session: MarfaAuthSession } | Response> {
    if (!auth) {
      // Better-auth isn't mounted on this instance. Without an identity
      // layer the consent screen can't authenticate a user — refuse
      // outright rather than silently accept.
      throw new MarfaError(
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
  // /auth/tokens (GET / DELETE / PATCH) handlers are not present.
  //
  // Under @better-auth/oauth-provider tokens are short-lived (1h default),
  // rotate on every refresh, and are revoked at the grant level
  // (`/oauth2/revoke` for a single token-in-hand; `/auth/grants/:id/revoke`
  // for the whole grant). Individual-token management had no CLI / SDK /
  // sandbox consumers.
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
    // Listing every app the owner authorized, and revoking one, are
    // operations on other principals' access — the same standing as the key
    // management routes beside them.
    requireAuth(c);
    // Revoking another app's access is exactly the authority a person would
    // want to have been asked about, and `grants.manage` is the row they
    // tick to grant it. There is nothing else to reach this on: no door admits
    // on rank, and a signed-in app holds what its grant carries.
    requirePermission(c, "grants.manage");
    const items = await storage.items.list({
      type: "system.connection",
      state: "active",
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
    // The same axis as `GET /grants`: `grants.manage` to act at all.
    requireAuth(c);
    requirePermission(c, "grants.manage");
    const id = c.req.param("id");
    const item = await storage.items.get(id);
    if (item?.type !== "system.connection") {
      throw new MarfaError(ErrorCode.OAUTH_GRANT_NOT_FOUND, "Grant not found");
    }
    const props = item.properties;
    if (props.kind !== "app") {
      throw new MarfaError(ErrorCode.OAUTH_GRANT_NOT_FOUND, "Grant not found");
    }
    // Cascade-revoke through the plugin's tables. The system.connection
    // properties carry `client_id` + `user_id` — use those to delete
    // every access + refresh token for this grant and drop the consent
    // row so the next /authorize prompt re-consents.
    const clientId =
      typeof props.client_id === "string" ? props.client_id : undefined;
    const authUserId =
      typeof props.user_id === "string" ? props.user_id : undefined;
    await revokeProjectedGrant(storage, {
      itemId: id,
      properties: props,
      clientId,
      authUserId,
      // Opt-in, and never inferred. A caller here has nobody to ask, so the
      // keys the app minted survive unless this door was told to take them.
      revokeKeys: asksToRevokeKeys(c.req.query("revoke_keys")),
    });
    auditGrantRevoked(storage, {
      clientId,
      authUserId,
      grantItemId: id,
      clientIp: c.var.clientIp ?? null,
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
  // to Better Auth's JSON API (`POST /auth/sign-in/email`). Better Auth's
  // response is translated back into a 302 redirect so the no-JavaScript
  // path works — Set-Cookie headers from a successful sign-in are
  // forwarded intact onto the redirect response.

  router.get("/sign-in", (c) => {
    const url = new URL(c.req.url);
    const error = url.searchParams.get("error") ?? undefined;

    // Two paths feed `return_to`:
    //
    //  1. Explicit `return_to` query param. Set by Marfa's own
    //     `requireConsentSession` redirect (the well-behaved
    //    consent-gate path).
    //  2. Bare OAuth params on the URL (`response_type`, `client_id`,
    //     `sig`, etc.) with no `return_to` wrapping. The
    //     @better-auth/oauth-provider plugin's `loginPage` config
    //     redirects unauthenticated users at `/auth/oauth2/authorize`
    //     here by appending the verified-query parameters directly
    //     onto `/auth/sign-in`. Nothing carries params in that shape
    //     through a form submit, so without a hidden `return_to` field
    //     the user lands on `/` after the credential check.
    //     Detect that shape and synthesize `return_to=/auth/authorize?<full original query>`
    //     so the existing form-round-trip path takes over.
    let returnTo = validateReturnTo(url.searchParams.get("return_to"));
    if (returnTo === "/" && url.searchParams.has("response_type")) {
      returnTo = synthesizeOauthReturnTo(url.searchParams);
    }

    const html = renderSignInPage({ returnTo, error });
    setNoStore(c);
    return c.html(html);
  });

  router.post("/sign-in", async (c) => {
    if (!auth) {
      throw new MarfaError(
        ErrorCode.UNAUTHORIZED,
        "Sign-in requires the better-auth identity layer to be configured",
      );
    }

    const formData = await c.req.formData();
    const returnTo = validateReturnTo(formData.get("return_to"));
    const email = formData.get("email");
    const emailStr = typeof email === "string" ? email.trim() : "";

    const errorRedirect = (errCode: string): Response =>
      c.redirect(buildSignInRedirect({ returnTo, error: errCode }), 302);

    if (!emailStr) {
      return errorRedirect("missing_field");
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
      // header otherwise. Browsers honor multiple Set-Cookie via
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
      void storage.audit.log({
        action: "auth.sign_in.success",
        resource_type: "auth_user",
        resource_id: emailStr,
        client_ip: c.var.clientIp ?? null,
        details: { email: emailStr, method: "password" },
      });
      return new Response(null, { status: 302, headers: redirectHeaders });
    }

    void storage.audit.log({
      action: "auth.sign_in.failed",
      resource_type: "auth_user",
      resource_id: emailStr,
      client_ip: c.var.clientIp ?? null,
      details: {
        email: emailStr,
        method: "password",
        reason: "invalid_credentials",
      },
    });
    return errorRedirect("invalid_credentials");
  });

  // Browser logout. The plugin owns the whole of it — validating the id token,
  // matching the return URI, ending the session — and this wrapper adds one
  // thing: a page for the case where the plugin ends the session and then has
  // nowhere to send the person, which it answers with an empty 200. That
  // renders as a blank tab, which reads as a failure even though the logout
  // succeeded. Registered ahead of the catch-all so it sees the response
  // first; every other outcome is passed through untouched.
  router.get("/oauth2/end-session", async (c) => {
    if (!auth) {
      throw new MarfaError(
        ErrorCode.UNAUTHORIZED,
        "Sign-out requires the better-auth identity layer to be configured",
      );
    }
    const upstream = new Request(c.req.url, {
      method: "GET",
      headers: forwardHeaders(c.req.raw.headers, {}, auth.baseURL),
    });
    const response = await auth.handler(upstream);

    const body = response.status === 200 ? await response.clone().text() : null;
    if (body !== null && body.trim().length === 0) {
      const headers = new Headers({
        "content-type": "text/html; charset=utf-8",
      });
      // Same shape as the other wrappers here: getSetCookie keeps multiple
      // cookies separate, since a coalesced header is not a valid cookie.
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
      headers.set("cache-control", "no-store, no-cache, private");
      headers.set("pragma", "no-cache");
      return new Response(renderSignedOutPage(), { status: 200, headers });
    }
    return response;
  });

  // -----------------------------------------------------------------------
  // Device Authorization Grant (RFC 8628) — the human half
  // -----------------------------------------------------------------------
  //
  // The provider's device plugin owns the codes: `POST /auth/device/code`
  // mints them, `POST /auth/oauth2/token` with the device grant exchanges an
  // approved one, and the plugin's own verify, approve and deny endpoints
  // move the row. Marfa fronts the pages a person meets and calls those
  // endpoints in-process, so the consent screen, its per-scope toggles, the
  // grant projection and the audit row stay Marfa's:
  //   - GET /auth/device            — verification form (optionally pre-filled
  //                                   via ?user_code=…)
  //   - POST /auth/device           — the person submits their user_code; a
  //                                   live one redirects to the consent screen
  //   - GET /auth/device/consent    — consent screen, gated on a session; the
  //                                   plugin's verify claims the code for the
  //                                   person on the way in
  //   - POST /auth/device/consent   — approve with the ticked scopes, or deny

  const requireDeviceAuth = (): MarfaAuth => {
    if (!auth) {
      throw new MarfaError(
        ErrorCode.UNAUTHORIZED,
        "Device flow requires the better-auth identity layer to be configured",
      );
    }
    return auth;
  };

  /** The page error the plugin's refusal maps to. */
  const pageErrorFor = (reason: DeviceCodeRefusal): string =>
    reason === "expired_code"
      ? "expired_code"
      : reason === "already_resolved"
        ? "already_resolved"
        : "invalid_code";

  router.post("/device", async (c) => {
    const formData = await c.req.formData();
    const submittedRaw = formData.get("user_code");
    const submitted =
      typeof submittedRaw === "string" ? normalizeUserCode(submittedRaw) : "";
    if (!submitted) {
      return c.redirect(`/auth/device?error=missing_code`, 302);
    }

    // Per-`user_code` failed-attempt throttle (independent of IP).
    // Register every failed submission against the submitted code and
    // refuse once the code crosses the cap, so a distributed guesser
    // can't sweep the user-code range by rotating IPs under the per-IP
    // limit. A failure that crosses the cap — and any later attempt on
    // an already-poisoned code — surfaces `too_many_attempts`. A valid
    // code advances to consent below WITHOUT incrementing, so the
    // legitimate one-shot flow never trips the throttle.
    const failAttempt = async (errorCode: string): Promise<Response> => {
      const throttle = await deviceUserCodeThrottle.attempt(submitted);
      if (!throttle.allowed) {
        return c.redirect(
          `/auth/device?error=too_many_attempts&user_code=${encodeURIComponent(submitted)}`,
          302,
        );
      }
      return c.redirect(
        `/auth/device?error=${errorCode}&user_code=${encodeURIComponent(submitted)}`,
        302,
      );
    };

    // Asked without the request's cookies, so a code is neither claimed nor
    // moved by the check: the claim happens on the consent screen, once the
    // person has signed in.
    const verdict = await requireDeviceAuth().deviceVerify(
      submitted,
      new Headers(),
    );
    if (!verdict.ok) return failAttempt(pageErrorFor(verdict.reason));
    if (verdict.status !== "pending") return failAttempt("already_resolved");
    return c.redirect(
      `/auth/device/consent?user_code=${encodeURIComponent(submitted)}`,
      302,
    );
  });

  router.get("/device", (c) => {
    const url = new URL(c.req.url);
    const rawCode = url.searchParams.get("user_code") ?? "";
    const error = url.searchParams.get("error") ?? undefined;

    // If the URL carries a user_code (i.e. the user followed
    // `verification_uri_complete`) and there's no error to surface,
    // jump straight to the consent screen — skipping the manual
    // "Continue" click on a form that's already pre-filled. The
    // consent route 302s to /auth/sign-in if there's no session yet
    // (preserving the user_code via return_to), so this is safe —
    // no auto-approval, just one fewer tap. Falls through to the form
    // if the code is empty/garbled or an error is being surfaced.
    const normalized = normalizeUserCode(rawCode);
    if (!error && /^[A-Z0-9]{8}$/.test(normalized)) {
      return c.redirect(
        `/auth/device/consent?user_code=${encodeURIComponent(normalized)}`,
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
    const userCode = normalizeUserCode(url.searchParams.get("user_code") ?? "");
    if (!userCode) {
      return c.redirect("/auth/device?error=missing_code", 302);
    }
    // Verified with the session's cookies, which is what claims a pending
    // code for this person: the plugin approves only a code its owner has
    // claimed, and the owner is whoever the verification step saw first.
    // Everyone else is answered the status alone.
    const verdict = await requireDeviceAuth().deviceVerify(
      userCode,
      c.req.raw.headers,
    );
    if (!verdict.ok) {
      return c.redirect(
        `/auth/device?error=${pageErrorFor(verdict.reason)}`,
        302,
      );
    }
    if (verdict.status !== "pending") {
      return c.redirect(
        `/auth/device?error=already_resolved&user_code=${encodeURIComponent(userCode)}`,
        302,
      );
    }
    if (verdict.clientId === undefined) {
      return c.redirect(
        `/auth/device?error=another_account&user_code=${encodeURIComponent(userCode)}`,
        302,
      );
    }
    // Client lookup reads the plugin's auth_oauth_client table.
    const client = await storage.oauthProvider?.getClient(verdict.clientId);
    if (!client) {
      throw new MarfaError(ErrorCode.INVALID_CLIENT, "Unknown client_id");
    }

    // Render the same consent template as /auth/authorize. The submit
    // target is /auth/device/consent (not /auth/authorize), and the
    // hidden user_code field replaces the OAuth code-flow params.
    //
    // The stored literals render as they will be granted: a wildcard is
    // one row covering its whole pattern, never expanded against the
    // static registry — expansion showed concrete types the grant does
    // not enumerate, and dropped `user.*` entirely because runtime
    // types are not in the registry to expand against.
    const parsedScopes = scopeList(verdict.scope)
      .map(parseScope)
      .filter(
        (s): s is NonNullable<ReturnType<typeof parseScope>> => s !== null,
      );
    // The same copy `/auth/authorize` renders, from the same function, so
    // which answer a person gets does not depend on which screen the flow
    // put them on.
    const descriptions = buildScopeDescriptions(parsedScopes);

    setNoStore(c);
    return c.html(
      renderDeviceConsentScreen({
        clientName: client.name ?? client.clientId,
        scopes: parsedScopes,
        userCode,
        descriptions,
        // The screen decides its own ticks from these, the same way the
        // authorize screen does. Passed rather than read inside the
        // renderer so both surfaces resolve the bundle set at their own
        // call site, which is the standing convention for this pair.
        bundles: getPermissionBundles(),
      }),
    );
  });

  router.post("/device/consent", async (c) => {
    const sessionResult = await requireConsentSession(c);
    if (sessionResult instanceof Response) return sessionResult;
    const deviceAuth = requireDeviceAuth();

    const formData = await c.req.formData();
    const userCodeRaw = formData.get("user_code");
    const userCode =
      typeof userCodeRaw === "string" ? normalizeUserCode(userCodeRaw) : "";
    const decision = formData.get("decision");
    if (!userCode || (decision !== "approve" && decision !== "deny")) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "user_code and decision are required",
      );
    }
    const verdict = await deviceAuth.deviceVerify(userCode, c.req.raw.headers);
    if (!verdict.ok) {
      if (verdict.reason === "expired_code") {
        return c.redirect(`/auth/device?error=expired_code`, 302);
      }
      throw new MarfaError(ErrorCode.NOT_FOUND, "Unknown user_code");
    }
    if (verdict.status !== "pending") {
      return c.redirect(
        `/auth/device?error=already_resolved&user_code=${encodeURIComponent(userCode)}`,
        302,
      );
    }
    if (verdict.clientId === undefined) {
      return c.redirect(
        `/auth/device?error=another_account&user_code=${encodeURIComponent(userCode)}`,
        302,
      );
    }
    const clientId = verdict.clientId;
    const requestedScopes = scopeList(verdict.scope);

    // The ticked set, intersected with what the device asked for.
    //
    // **An intersection rather than a substitution**, because this form is a
    // browser surface and its fields are whoever's browser it is to edit. A
    // hand-edited submission must not grant an app more than the client
    // requested or more than the screen displayed, and the stored row is what
    // every later reader treats as the request.
    //
    // **Nothing ticked is a denial**, the same rule the authorize screen
    // applies to a zero-scope accept and for the same reason: a grant of
    // nothing is not a grant, and recording one leaves a projection and a
    // consent row standing for an app that can do nothing with them. It also
    // keeps the two surfaces answering one question the same way.
    const requestedScopeSet = new Set(requestedScopes);
    const approvedScopes = [
      ...new Set(
        formData
          .getAll("scopes")
          .filter((v): v is string => typeof v === "string")
          .filter((v) => requestedScopeSet.has(v)),
      ),
    ];

    if (decision === "deny" || approvedScopes.length === 0) {
      const denied = await deviceAuth.deviceDeny(userCode, c.req.raw.headers);
      if (!denied.ok) {
        return c.redirect(
          `/auth/device?error=${pageErrorFor(denied.reason)}&user_code=${encodeURIComponent(userCode)}`,
          302,
        );
      }
      setNoStore(c);
      return c.html(renderDeviceDecisionPage({ approved: false }));
    }

    // Approve: upsert the system.connection projection, narrow the code to
    // the ticked set, and approve it through the plugin.
    //
    // The upsert resolves the projection, reads it, and writes it back
    // active with this request's scopes — a read-modify-write on the same
    // record the consent decision, the silent re-authorization, and the
    // revoke path all write, so it takes the same lock they do. Left
    // outside it, a revoke running concurrently can land its whole
    // cascade between this read and this write, and the write then puts
    // the grant back to active with `revoked_at` cleared: an end state
    // neither ordering of the two user actions would produce.
    //
    // **The approval is inside the lock too, and that is the half that
    // matters.** The revoke's sweep deletes the device codes this person
    // claimed for this client, and it runs inside this same lock. With the
    // approval outside it, a revoke could take the lock the moment the grant
    // write released it, sweep a code still pending, and release; the
    // approval that followed would then mint against a grant just revoked.
    // Inside, the two orderings are the only two outcomes: approval first,
    // and the sweep finds and deletes the approved code; revoke first, and
    // the approval creates a fresh grant and approves against that.
    //
    // **The narrowing precedes the approval.** The plugin approves a code as
    // it was requested and issues the token for the row's scope, so the row
    // has to read the ticked set before the status flips. A narrowing that
    // finds the row no longer pending is a race with a deny in another tab,
    // and is told it did not take effect.
    const { grant, ok } = await withConsentLock(
      clientId,
      sessionResult.session.user.id,
      async () => {
        const provider = storage.oauthProvider;
        const created = await createUserAppGrant(
          storage,
          sessionResult.session.user,
          clientId,
          approvedScopes,
          "marfa/oauth/device",
        );
        const narrowed =
          typeof provider?.narrowDeviceCodeScope === "function"
            ? await provider.narrowDeviceCodeScope(userCode, approvedScopes)
            : false;
        if (!narrowed) return { grant: created, ok: false };
        const approved = await deviceAuth.deviceApprove(
          userCode,
          c.req.raw.headers,
        );
        if (!approved.ok) return { grant: created, ok: false };
        // The plugin's half of the grant. This surface never passes through
        // the plugin's consent endpoint, so without this write a device
        // grant had a projection and no consent row, and neither consent
        // check (the plugin's exact-membership skip, Marfa's coverage check
        // behind it) could see it: every later browser authorize for the
        // same app rendered consent afresh. Written with the projection's
        // merged set, because the projection is the grant and the row
        // mirrors it. Inside the lock so a revoke cannot land between the
        // two halves, and only once the code is approved.
        if (provider && typeof provider.upsertConsent === "function") {
          await provider.upsertConsent({
            clientId,
            authUserId: sessionResult.session.user.id,
            scopes: created.scopes,
          });
        }
        return { grant: created, ok: true };
      },
    );
    if (!ok) {
      // Race: someone else flipped it in between. Surface as already-resolved.
      return c.redirect(
        `/auth/device?error=already_resolved&user_code=${encodeURIComponent(userCode)}`,
        302,
      );
    }
    void storage.audit.log({
      action: "auth.grant.created",
      resource_type: "oauth_grant",
      resource_id: clientId,
      client_ip: c.var.clientIp ?? null,
      details: {
        client_id: clientId,
        user_id: sessionResult.session.user.id,
        // Three halves, because two of them can differ in each direction
        // and none alone answers the question an operator brings to this
        // row. `scopes` is what this device asked for. The screen offers
        // those as toggles, so `approved_scopes` is what the person actually
        // ticked, which can be narrower. And an approval merges into the
        // standing grant rather than replacing it, so `resulting_scopes` is
        // the record afterwards, which can be wider than either. On a
        // first-time approval where nothing was unticked, all three are the
        // same list.
        scopes: requestedScopes,
        approved_scopes: approvedScopes,
        resulting_scopes: grant.scopes,
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

  return router;
}

// ---------------------------------------------------------------------------
// Device Authorization Grant — local helpers
// ---------------------------------------------------------------------------

/** Failed `user_code` submissions allowed per code before the device
 *  verification form refuses further attempts. Defends the short
 *  user-code range against a distributed brute force that would slip
 *  under the per-IP rate limit. */
const DEVICE_USER_CODE_MAX_ATTEMPTS = 5;

/** Normalize a user-submitted code the way the plugin does before it looks
 *  one up: every non-alphanumeric stripped, upper-cased. Accepts the person
 *  typing a hyphen or a space into the code their device showed. */
function normalizeUserCode(input: string): string {
  return input.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

/** The scope list a device code carries, as the plugin stores it. */
function scopeList(scope: string | undefined): string[] {
  return (scope ?? "").split(" ").filter((s) => s.length > 0);
}

/** Build a redirect URL back to the sign-in page with the right query
 *  shape (error, return_to). All values are encoded. */
function buildSignInRedirect(params: {
  returnTo: string;
  error?: string;
}): string {
  const search = new URLSearchParams();
  if (params.error) search.set("error", params.error);
  if (params.returnTo && params.returnTo !== "/") {
    search.set("return_to", params.returnTo);
  }
  const query = search.toString();
  return `/auth/sign-in${query ? `?${query}` : ""}`;
}

/**
 * Whether a caller asked for the app's keys to go with its grant. An
 * affirmative value, and nothing else: `?revoke_keys=1` and
 * `?revoke_keys=true` sweep, anything else leaves the keys alone.
 */
function asksToRevokeKeys(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  return raw === "1" || raw === "true";
}
