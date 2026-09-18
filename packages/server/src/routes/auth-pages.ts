import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import { MarfaError, ErrorCode, parseScope } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireSpacePermission,
  requireAuth,
  hashApiKey,
  stampOAuthGrantLastUsed,
} from "../middleware/auth.js";
import {
  mergeDeviceApprovalScopes,
  intersectDeviceScopes,
} from "./device-scope-merge.js";
import { buildScopeDescriptions } from "./auth-consent.js";
import {
  buildAllowedScopes,
  REFRESH_TOKEN_PREFIX,
} from "../auth/oauth-provider.js";
import {
  bundlePublishedScopes,
  catchUpClientScopeCeiling,
} from "../auth/ceiling-catchup.js";
import { getPermissionBundles } from "../config.js";
import type { Storage } from "../storage/interface.js";
import type {
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
import { log } from "../middleware/logger.js";
import type { OidcSigner } from "../auth/oidc-signing.js";

const ACCESS_TOKEN_PREFIX = "marfa_at_";
const ACCESS_TOKEN_TTL_MS = 3600_000; // 1 hour

function generateToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("hex")}`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

/**
 * Persist (or refresh) a `kind: app` connection through `ItemStore`. Routes
 * through `ItemStore.create` on first consent and `ItemStore.update` on
 * re-consent so the row gets full ItemStore treatment: search indexing, metadata-row insertion, versions snapshot on
 * re-consent, the `created`/`updated` event emission, and `source` /
 * `origin` stamping. Returns the connection-item id, whether the call
 * created vs updated the projection, and the scope list the record now
 * holds, which on re-consent is the merge rather than the request, so the
 * caller's audit row can report both without recomputing it.
 *
 * Uses `findGrantItemId` to detect the re-consent case and routes through
 * `items.update` (same shape as the code-flow consent's
 * `projectGrantOnConsent`). Status flips to "active" + `revoked_at` is
 * cleared on re-consent to avoid stale-revoked projections. The scopes it
 * writes there are the merge described in `device-scope-merge.ts`, not the
 * request. That merge may widen a standing grant and never shrinks one, even
 * though the device screen now offers per-scope toggles: an untick there
 * reaches the token this device is issued rather than the record, for the
 * reasons at that function. A revoked grant is not a standing one, so it
 * merges against nothing and the record comes back at the approval alone.
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
      // Merge rather than overwrite. `device-scope-merge.ts` carries the
      // reasoning, and it moved: this screen once confirmed a list rather
      // than offering one to edit, and now offers per-scope toggles, so a
      // narrower set arriving here may be the client asking for less or the
      // person unticking a row and nothing at this call site can tell them
      // apart. The record keeps the standing grant either way, deliberately;
      // what the untick reaches is the token this device is issued.
      //
      // **A revoked grant contributes nothing to that merge, because the
      // rule is about a STANDING grant and a revoked one is not standing.**
      // `findGrantItemId` matches on (space, client, user) and has no status
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
      // `connections/revoked-connection.ts` carries the relationship
      // between the two axes and which disagreements are legitimate.
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
      const mergedScopes = mergeDeviceApprovalScopes(standingScopes, scopes);
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

  // First-time consent: insert a fresh row.
  const item = await storage.items.create({
    type: "system.connection",
    tier: "library",
    state: "active",
    properties: {
      kind: "app",
      client_id: clientId,
      // Store the consenting auth_user id so cascade revoke
      // (/auth/grants/:id/revoke → revokeTokensForGrant(clientId, userId))
      // and the device-flow terminal step (which needs (clientId, userId)
      // to mint tokens against the plugin's tables) can find the user.
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
 * through `instance.ts`. `salt` + `oidcSigner` are threaded into
 * `authRoutes` by app.ts for the surfaces this file still serves —
 * device flow uses `salt` for hashing, and `oidcSigner` is reserved
 * for future ID-token-related claims.
 */
export function authRoutes(
  storage: Storage,
  salt: string,
  auth?: MarfaAuth,
  oidcSigner?: OidcSigner,
): Hono<AppEnv> {
  // `salt` is consumed by the device-flow terminal step (hashes
  // minted tokens with the same `hashApiKey(token, salt)` as the
  // bearer middleware). `oidcSigner` is currently unused after the
  // OAuth-protocol delete; kept on the signature for caller stability.
  void oidcSigner;
  const router = new Hono<AppEnv>();
  // The requestable-scope set, shared with the code flow. A snapshot of
  // registry keys cannot validate device requests: `user.*` types are
  // per-space and never enumerate in the static registry, so expanding a
  // wildcard against it silently dropped the scope. The allowlist carries
  // wildcards as first-class literals instead.
  const allowedScopes = new Set(buildAllowedScopes());

  // Per-`user_code` failed-attempt throttle on the device-flow
  // verification form (`POST /auth/device` user-code submission). The
  // per-IP cap in `middleware/rate-limit.ts` bounds a single client
  // guessing codes, but a distributed guesser spreading attempts across
  // many IPs would slip under it. This counter is keyed on the submitted
  // `user_code` itself (independent of IP) and denies once a code has
  // accumulated too many failed lookups — so a brute-force sweep against
  // the short user-code space is capped per code, cluster-wide. Only
  // failed submissions increment; a valid code that advances to consent
  // never touches the counter, so the legitimate flow is unaffected.
  // `PerEmailThrottle` is a generic keyed-counter over
  // `storage.rateLimits`; reused here with a device-code key space.
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
    // Listing every app a space authorized, and revoking one, are
    // operations on other principals' access — the same standing as the key
    // management routes beside them. Two axes: the permission says who may
    // act, the space fence below says where.
    requireAuth(c);
    // Revoking another app's access is exactly the authority a person would
    // want to have been asked about, and `space.app_grants` is the row they
    // tick to grant it. There is nothing else to reach this on: no door admits
    // on rank, and a signed-in app holds what its grant carries.
    requireSpacePermission(c, "space.app_grants");
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
    // The same axis as `GET /grants`: `space.app_grants` to act at all.
    requireAuth(c);
    requireSpacePermission(c, "space.app_grants");
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
  // Marfa CLI / SDK shape) and from RFC 8628 §3.1 form-encoded callers
  // (the protocol-canonical shape). Both produce the same device-code
  // envelope.
  const initDeviceFlow = async (
    c: Context,
    clientId: string | null,
    rawScope: string,
  ): Promise<Response> => {
    const scope = rawScope.trim();
    if (!clientId || !scope) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "client_id and scope are required",
      );
    }
    // Client lookup reads the plugin's `auth_oauth_client` table.
    const client = await storage.oauthProvider?.getClient(clientId);
    if (!client) {
      throw new MarfaError(ErrorCode.INVALID_CLIENT, "Unknown client_id");
    }
    // A client that did not register the device grant may not run it.
    //
    // The plugin enforces this on its own token paths, through
    // `clientAllowsGrant` inside `validateClientCredentials`. The device
    // flow is Marfa's own state machine and reaches none of that, which is
    // why the check has to be restated here rather than inherited — and
    // why it has to read `grant_types` the same way, or the platform holds
    // two answers to one question.
    if (!clientAllowsDeviceGrant(client.grantTypes)) {
      throw new MarfaError(
        ErrorCode.INVALID_CLIENT,
        "This client is not registered for the device grant",
      );
    }
    const requestedScopes = scope.split(" ").filter(Boolean);
    if (requestedScopes.length === 0) {
      throw new MarfaError(
        ErrorCode.INVALID_SCOPE,
        "No valid scopes requested",
      );
    }
    // The first ceiling, on a pass of its own: what the platform offers at
    // all. The stored grant is the literal set and consent approves it
    // verbatim, so a scope that slipped through here would be granted
    // unseen — any disallowed scope refuses the whole request.
    //
    // Nothing that writes may run above this loop. Initiation is
    // unauthenticated, and the catch-up below is a persistent write to a
    // stored registration row. Interleaving the two lets a caller who has
    // proved nothing move stored state with input this server has not
    // accepted: the request still refuses, and the row it was refused
    // against keeps the widening. That row is also what this client is
    // given when it omits `scope` entirely, so the next consent screen
    // would open pre-ticked with what the refused request named.
    for (const requested of requestedScopes) {
      if (!allowedScopes.has(requested)) {
        throw new MarfaError(
          ErrorCode.INVALID_SCOPE,
          `Scope not available: ${requested}`,
        );
      }
    }
    // The second ceiling: what this client registered for. The plugin
    // resolves it as `client.scopes ?? opts.scopes` on the
    // authorization-code path; this path never read it, so a client
    // registered for one scope could open a device flow asking for every
    // scope on the platform, with only a person reading the consent screen
    // carefully in the way.
    //
    // It refuses rather than narrowing, which is the opposite of what the
    // authorize surface does and deliberately so. There, the error rides a
    // redirect the app may never render and a human is stood in front of
    // it, so narrowing is what lets a stale request still succeed. Here the
    // response goes straight back to the machine that made the request,
    // which can read it. Handing back a device code for less than was asked
    // for, without saying so, turns a two-line fix at the client into a
    // token that quietly does not do what the client was built for.
    //
    // Refusing is only defensible while the ceiling being compared against
    // is current, and the stored row is not: it is a registration-time
    // snapshot of an allowlist that moves whenever the type registry does.
    // So it gets the same catch-up the authorize surface performs, before
    // the loop below compares against it. Without that, a client registered
    // for a bundle-published wildcard was refused a scope beneath it,
    // terminally, for a registration that plainly covered it.
    //
    // Making the comparison below coverage-aware instead is the repair that
    // looks right and is not. It would leave this surface reading a ceiling
    // one way while every other reader of the same row reads it exactly, and
    // two surfaces answering one question two different ways is what the
    // comment in `narrowAuthorizeScopes` exists to prevent. Breadth belongs
    // in what gets written, not in what gets compared.
    const bundles = getPermissionBundles();
    const clientCeiling = await catchUpClientScopeCeiling({
      storage,
      clientId,
      requested: requestedScopes,
      ceiling: client.scopes,
      bundleScopes: bundlePublishedScopes(bundles),
      surface: "device",
    });
    for (const requested of requestedScopes) {
      if (clientCeiling !== null && !clientCeiling.includes(requested)) {
        throw new MarfaError(
          ErrorCode.INVALID_SCOPE,
          `Scope not registered for this client: ${requested}`,
        );
      }
    }
    // **There was a third check here, and it is retired rather than
    // weakened.** It refused any scope only an off-by-default bundle offers,
    // because the approval screen confirmed a scope list with no per-scope
    // toggle: on a screen with no tick there was nothing for "leaving it
    // alone grants nothing" to mean, so approving handed over in one click
    // exactly what the flag exists to withhold.
    //
    // That screen has toggles now, and it reads the same rule the authorize
    // screen reads. So the premise the refusal rested on is gone, and
    // keeping it would be the harm rather than the guard: the CLI signs in
    // through this flow and nothing else, and the MCP server has no consent
    // surface at all — it reads the token the CLI stored. Refusing here
    // would leave both permanently unable to hold a space permission, which
    // is a lockout dressed as least privilege.
    //
    // Withholding now happens where a person can act on it: the scope
    // arrives unticked, and `POST /auth/device/consent` grants the ticked
    // set rather than the requested one.

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
    // Marfa's own CLI / SDK use this shape; not RFC-mandated but
    // operationally convenient.
    if (contentType.includes("application/json")) {
      let body: { client_id?: unknown; scope?: unknown };
      try {
        body = await c.req.json();
      } catch {
        throw new MarfaError(ErrorCode.VALIDATION_ERROR, "JSON body required");
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
    //   2. **User-code submission** — Marfa's verification form. Body
    //      carries `user_code`.
    //
    // Disambiguate by inspecting the body. A request with neither
    // field falls through to the user-code branch and gets the
    // existing `missing_code` redirect — same behavior as before.
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
    const normalized = normalizeUserCode(submitted);

    // Per-`user_code` failed-attempt throttle (independent of IP).
    // Register every failed submission against the submitted code and
    // refuse once the code crosses the cap, so a distributed guesser
    // can't sweep the user-code space by rotating IPs under the per-IP
    // limit. A failure that crosses the cap — and any later attempt on
    // an already-poisoned code — surfaces `too_many_attempts`. A valid
    // code advances to consent below WITHOUT incrementing, so the
    // legitimate one-shot flow never trips the throttle.
    const failAttempt = async (errorCode: string): Promise<Response> => {
      const throttle = await deviceUserCodeThrottle.attempt(normalized);
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

    const row = await storage.oauth.findDeviceCodeByUserCode(normalized);
    if (!row) {
      return failAttempt("invalid_code");
    }
    if (row.status !== "pending") {
      return failAttempt("already_resolved");
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return failAttempt("expired_code");
    }
    return c.redirect(
      `/auth/device/consent?user_code=${encodeURIComponent(normalized)}`,
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
    const normalized = normalizeUserCode(
      rawCode.trim().toUpperCase().replace(/\s+/g, ""),
    );
    if (!error && normalized && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(normalized)) {
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
    const userCodeRaw = url.searchParams.get("user_code") ?? "";
    const userCode = normalizeUserCode(userCodeRaw.trim().toUpperCase());
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
    // Client lookup reads the plugin's auth_oauth_client table.
    const client = await storage.oauthProvider?.getClient(row.client_id);
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
    const parsedScopes = row.scopes
      .map(parseScope)
      .filter(
        (s): s is NonNullable<ReturnType<typeof parseScope>> => s !== null,
      );
    // The same copy `/auth/authorize` renders, from the same function. Two
    // maps stood here and agreed with that screen about types while
    // contradicting it about metadata and wildcards, so which answer a
    // person got depended on which screen the device flow had put them on.
    //
    // It also reverses the precedence this loop carried: curated copy now
    // wins over the type registry's description. That is what the other
    // screen has always shown, and the registry's is written for a developer
    // reading API docs rather than for an owner approving a grant.
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

    const formData = await c.req.formData();
    const userCodeRaw = formData.get("user_code");
    const userCode =
      typeof userCodeRaw === "string"
        ? normalizeUserCode(userCodeRaw.trim().toUpperCase())
        : "";
    const decision = formData.get("decision");
    if (!userCode || (decision !== "approve" && decision !== "deny")) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "user_code and decision are required",
      );
    }
    const row = await storage.oauth.findDeviceCodeByUserCode(userCode);
    if (!row) {
      throw new MarfaError(ErrorCode.NOT_FOUND, "Unknown user_code");
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
    const requestedScopeSet = new Set(row.scopes);
    const approvedScopes = [
      ...new Set(
        formData
          .getAll("scopes")
          .filter((v): v is string => typeof v === "string")
          .filter((v) => requestedScopeSet.has(v)),
      ),
    ];

    if (decision === "deny" || approvedScopes.length === 0) {
      await storage.oauth.denyDeviceCode(row.id);
      setNoStore(c);
      return c.html(renderDeviceDecisionPage({ approved: false }));
    }

    // Approve: upsert the system.connection projection and flip the
    // device-code row.
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
    // **The binding is inside the lock too, and that is the half that was
    // missing.** The revoke's sweep is `deleteDeviceCodesForGrant`, keyed on
    // `connection_item_id`, and it runs inside this same lock. With the bind
    // outside it, a revoke could take the lock the moment the grant write
    // released it, run its entire cascade past a code whose grant reference
    // was still null — matching nothing — and release; the bind then attached
    // that code to a grant that had just been revoked. Revocation deletes
    // device codes rather than flipping their status, so the `status =
    // 'pending'` predicate the bind runs under was still satisfied and the
    // write succeeded.
    //
    // Inside, the two orderings are the only two outcomes. Approval first:
    // the code is bound before the sweep runs, so the sweep finds and deletes
    // it. Revoke first: the cascade completes against nothing, and the
    // approval that follows creates a fresh grant and binds to that.
    const { grant, ok } = await withConsentLock(
      row.client_id,
      sessionResult.session.user.id,
      async () => {
        const provider = storage.oauthProvider;
        const created = await createUserAppGrant(
          storage,
          sessionResult.session.user,
          row.client_id,
          approvedScopes,
          "marfa/oauth/device",
        );
        const bound = await storage.oauth.approveDeviceCode(
          row.id,
          created.id,
          approvedScopes,
        );
        // The plugin's half of the grant. This surface never passes through
        // the plugin's consent endpoint, so without this write a device
        // grant had a projection and no consent row, and neither consent
        // check (the plugin's exact-membership skip, Marfa's coverage check
        // behind it) could see it: every later browser authorize for the
        // same app rendered consent afresh. Written with the projection's
        // merged set, because the projection is the grant and the row
        // mirrors it: a row standing alone after a failed projection write
        // is narrowed here to what the person just approved, which is less
        // access rather than more, and the browser asks again for the rest.
        // Inside the lock so a revoke cannot land between the two halves,
        // and only once the code is bound: an approval that
        // lost to a deny in another tab is told it did not take effect, and
        // must not leave a row that answers the next browser authorize with
        // a code and no screen. The trade: a throw from this write now lands
        // after the bind, so the device gets its tokens on the next poll
        // while the person sees an error and no `auth.grant.created` row is
        // written. That is a projection without a row, the state this
        // change repairs, and the next approval repairs it again; the other
        // order wrote a row for an approval that never took effect.
        if (bound && provider && typeof provider.upsertConsent === "function") {
          await provider.upsertConsent({
            clientId: row.client_id,
            authUserId: sessionResult.session.user.id,
            scopes: created.scopes,
          });
        }
        return { grant: created, ok: bound };
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
      resource_id: row.client_id,
      client_ip: c.var.clientIp ?? null,
      details: {
        client_id: row.client_id,
        user_id: sessionResult.session.user.id,
        // Three halves now, because two of them can differ in each
        // direction and none alone answers the question an operator brings
        // to this row. `scopes` is what this device asked for. The screen
        // offers those as toggles, so `approved_scopes` is what the person
        // actually ticked, which can be narrower — a narrowing is otherwise
        // invisible, and it is the whole reason the initiation refusal could
        // be retired. And an approval merges into the standing grant rather
        // than replacing it, so `resulting_scopes` is the record afterwards,
        // which can be wider than either. On a first-time approval where
        // nothing was unticked, all three are the same list.
        scopes: row.scopes,
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

  router.post("/device/token", async (c) => {
    const formData = await c.req.formData();
    const grantType = formData.get("grant_type");
    const deviceCodeRaw = formData.get("device_code");
    const clientId = formData.get("client_id");

    if (
      grantType !== DEVICE_CODE_GRANT_TYPE ||
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

    // A code is exchanged once. The client stops polling on success per RFC
    // 8628 §3.5, so a second poll is a code that has left the device: a log,
    // a shared terminal, a replayed request. `invalid_grant` per RFC 6749
    // §5.2, the same answer a revoked grant gets, so the two are not told
    // apart from outside.
    if (row.status === "redeemed") {
      log("info", "device token refused: code already exchanged", {
        client_id: row.client_id,
      });
      return c.json(
        {
          error: "invalid_grant",
          error_description: "The device code is invalid, expired, or revoked.",
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
      // The foreign key is `onDelete: "set null"`, so hard-purging the grant
      // item through `DELETE /items/:id/purge` leaves an approved code
      // pointing at nothing. That is a grant that no longer exists rather
      // than an invariant this code can vouch for, and the caller gets the
      // same refusal a revoked grant gets.
      log("info", "device token refused: grant no longer exists", {
        client_id: row.client_id,
      });
      return c.json(
        {
          error: "invalid_grant",
          error_description: "The device code is invalid, expired, or revoked.",
        },
        400,
      );
    }

    // Terminal token issuance. The plugin owns the canonical token
    // storage tables (`auth_oauth_access_token`,
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
    const accessBare = accessRaw.slice(ACCESS_TOKEN_PREFIX.length);
    const accessHash = hashApiKey(accessBare, salt);

    // Resolve the grant to extract the approved scopes.
    // Type check is defense-in-depth: connection_item_id comes from a
    // server-controlled row, but a future approve-handler change could
    // stamp a wrong id and silently mint an orphan token without it.
    const deviceGrant = await storage.items.get(row.connection_item_id);
    if (deviceGrant?.type !== "system.connection") {
      throw new Error(
        "Device-flow grant resolves to non-system.connection item (projection drift?)",
      );
    }
    const grantProps = deviceGrant.properties;

    // Both lifecycle axes, before anything is minted against the record.
    //
    // Revocation leaves the scope list verbatim on the row it flips, so
    // every scope check below a revoked grant still passes and the poll
    // hands back a working pair for the rest of the device code's TTL, and
    // where `offline_access` was approved, a refresh token minted after the
    // revoke cascade already ran, which nothing subsequently invalidates. A
    // bounded window becomes indefinite access through ordinary rotation,
    // while the user's security page reports the app as disconnected the
    // whole time.
    //
    // Revocation now deletes the codes too, so in the ordinary case this
    // never fires. It is kept for the same reason the authorization-code
    // guard is: the deletion alone is a sweep, and a sweep has a window.
    // A code bound to the grant after the sweep passed over it survives
    // one and misses the other, and the approval that binds it runs
    // outside the consent lock the revoke holds.
    //
    // **Both axes, because a grant needs both to be reachable.** `state` is
    // the item's lifecycle axis and `properties.status` is the type's own,
    // and `connections/revoked-connection.ts` carries why the two cannot
    // legitimately disagree. Both read surfaces require both before showing
    // a grant to its owner, so a row active on one axis alone is one no
    // person can revoke through the interface built for revoking it, and
    // minting against it is what makes that state worth having.
    //
    // Tested FOR "active" rather than against "revoked": a state this code
    // cannot read is not evidence the user granted anything.
    //
    // `invalid_grant`, per RFC 6749 §5.2, and the same answer the
    // authorization-code guard gives for the same fact on the code path.
    if (deviceGrant.state !== "active" || grantProps.status !== "active") {
      log("info", "device token refused: grant revoked", {
        client_id: row.client_id,
      });
      return c.json(
        {
          error: "invalid_grant",
          error_description: "The device code is invalid, expired, or revoked.",
        },
        400,
      );
    }

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

    // What this device asked for, and never the whole standing grant.
    //
    // The two used to be the same set: an approval overwrote the record
    // with the device request, so reading the record back was reading the
    // request. Now that an approval merges into a standing grant instead of
    // replacing it, the record can hold scopes this device never asked for
    // and its screen never showed: the browser's own consent, for the same
    // client and user. Minting from the record would hand a CLI the web
    // app's access on the strength of a login, and hand it a refresh token
    // whenever the browser had once asked to stay signed in.
    //
    // Filtered against the grant rather than taken raw, because the record
    // is still the authority and a device code outlives its approval by up
    // to the rest of its TTL. A narrowing on the consent screen inside that
    // window rewrites the scope list, and the poll that follows reads the
    // rewritten one, so it cannot hand back a scope that was dropped. The
    // intersection is the only reading that holds both ends: never more
    // than was asked for, never more than the scope list reaches.
    //
    // **Revocation is not this filter's job and never was.** Filtering
    // against a revoked record would still mint, because revocation leaves
    // the scope list intact. The lifecycle guard above is what refuses that
    // grant outright, and it runs before this line so the intersection is
    // only ever computed against a grant that is live on both axes.
    //
    // **Computed on effective permissions, because a coverage test per
    // literal is not an intersection.** Scope resolution gives an exact type
    // id precedence over a wildcard spanning it, so coverage is not
    // reflexive on a pinned set: `["core.*:write", "core.note:read"]` does
    // not cover `core.*:write`, a literal it contains. A device asking for a
    // wildcard alongside a narrower pin was therefore issued the pin alone,
    // though the user had approved both and the grant reached both, and it
    // was handed a narrower `scope` string rather than an error.
    // `intersectDeviceScopes` is the merge's sibling and takes the minimum
    // where that takes the maximum; the reasoning is at the function.
    const issuedScopes = intersectDeviceScopes(row.scopes, grantScopes);

    // `offline_access` is what buys a refresh token, here as everywhere else.
    //
    // The library issues one only for a grant carrying the scope, and its
    // rotation is reached only for tokens it issued that way: rotating
    // revokes the presented token and links the replacement into the same
    // family, which is what lets a replayed token be spotted and the chain
    // terminated. This route writes its own rows and so sits outside that,
    // and minting unconditionally produced a refresh token nothing could
    // ever rotate — a credential with no expiry and no way to go stale, on
    // grants belonging to devices signed in once and left alone.
    //
    // Issuing only on `offline_access` closes it by removing the credential
    // rather than by reimplementing rotation, and it makes the two paths
    // agree: a client that wants to stay signed in asks for the scope, and
    // the consent screen already renders it as a line the user approves.
    const staysSignedIn = issuedScopes.includes("offline_access");
    const refreshRaw = staysSignedIn
      ? generateToken(REFRESH_TOKEN_PREFIX)
      : undefined;
    const refreshHash =
      refreshRaw === undefined
        ? undefined
        : hashApiKey(refreshRaw.slice(REFRESH_TOKEN_PREFIX.length), salt);

    // Spend the code before minting against it. The flip is conditional on
    // the row still reading approved, so two polls racing for one code see
    // one winner and the other is refused rather than both minting a pair.
    // Before rather than after the mint, because a code spent by a mint that
    // then failed costs the device a restart, while a mint that succeeded
    // ahead of a flip that then failed would have handed out a pair the
    // code could still be exchanged for again.
    const spent = await storage.oauth.redeemDeviceCode(row.id);
    if (!spent) {
      log("info", "device token refused: code exchanged concurrently", {
        client_id: row.client_id,
      });
      return c.json(
        {
          error: "invalid_grant",
          error_description: "The device code is invalid, expired, or revoked.",
        },
        400,
      );
    }

    await storage.oauthProvider.mintTokenPair({
      accessTokenHash: accessHash,
      refreshTokenHash: refreshHash,
      clientId: grantClientId,
      authUserId: grantUserId,
      scopes: issuedScopes,
      accessTtlMs: ACCESS_TOKEN_TTL_MS,
    });

    // Stamp last_used_at on the underlying grant — best-effort.
    await stampOAuthGrantLastUsed(storage, row.connection_item_id);

    return c.json({
      access_token: accessRaw,
      ...(refreshRaw !== undefined && { refresh_token: refreshRaw }),
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      scope: issuedScopes.join(" "),
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Device Authorization Grant — local helpers
// ---------------------------------------------------------------------------

/**
 * RFC 8628 device-code grant type literal.
 *
 * Exported because four places had their own copy of this string and a
 * typo in any one of them fails in a way that reads as a protocol
 * disagreement rather than a spelling mistake.
 */
export const DEVICE_CODE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:device_code";

/**
 * Whether a client's registered `grant_types` admit the device grant.
 *
 * An absent or empty registration means `authorization_code` and nothing
 * else, per RFC 7591 §2, which is also how the OAuth plugin reads it in
 * `clientAllowsGrant`. Reading it as "declared nothing, so allow anything"
 * would be more permissive here than on every path the plugin owns, and a
 * platform that answers one question two ways is the shape this lane spent
 * its time removing.
 */
export function clientAllowsDeviceGrant(
  grantTypes: readonly string[] | null,
): boolean {
  const declared =
    grantTypes && grantTypes.length > 0 ? grantTypes : ["authorization_code"];
  return declared.includes(DEVICE_CODE_GRANT_TYPE);
}

const DEVICE_CODE_PREFIX = "marfa_dc_";
const DEVICE_CODE_TTL_MS = 600_000; // 10 minutes
const DEVICE_CODE_DEFAULT_INTERVAL_SECONDS = 5;
/** Failed `user_code` submissions allowed per code before the device
 *  verification form refuses further attempts. Defends the short
 *  user-code space against a distributed brute force that would slip
 *  under the per-IP rate limit. */
const DEVICE_USER_CODE_MAX_ATTEMPTS = 5;

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

/** Normalize a user-submitted code to the storage shape: uppercase,
 *  hyphenated XXXX-XXXX. Accepts the user typing without the hyphen. */
function normalizeUserCode(input: string): string {
  const stripped = input.replace(/-/g, "").toUpperCase();
  if (stripped.length !== 8) return input.toUpperCase();
  return `${stripped.slice(0, 4)}-${stripped.slice(4)}`;
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
