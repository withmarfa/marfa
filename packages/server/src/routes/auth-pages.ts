import { containsProfileEmailWrite } from "../auth/profile-scope.js";
import { contentSecurityPolicy } from "./content-security-policy.js";
import { requireSecureOwnerTransport } from "../auth/owner-browser.js";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
import type { Context } from "hono";
import { createOpenAPIRouter } from "../openapi.js";
import { appKindOf } from "../auth/connected-apps.js";
import { narrowAppGrant } from "../auth/grant-narrowing.js";
import {
  listGrantsRoute,
  deleteGrantRoute,
  narrowGrantRoute,
} from "./grant-schemas.js";
import { readInstanceName } from "../instance-name.js";
import {
  MarfaError,
  ErrorCode,
  needsRecentSignIn,
  parseScope,
} from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requirePermission,
  requireDirectAuthority,
  requireRecentOwnerAuthentication,
  authorityId,
} from "../middleware/auth.js";
import {
  appBehindReturnTo,
  buildScopeDescriptions,
  resolveTypeLabels,
  resolveWildcardExpansions,
} from "./auth-consent.js";
import { getPermissionBundles } from "../config.js";
import type { Storage } from "../storage/interface.js";
import { writeItem } from "../storage/item-write.js";
import { browserWriter, requestWriter } from "../auth/version-writer.js";
import type {
  DeviceCodeRefusal,
  MarfaAuth,
  MarfaAuthSession,
} from "../auth/instance.js";
import { renderForgotPasswordPage } from "./forgot-password-page.js";
import { renderSignInPage } from "./sign-in-page.js";
import { synthesizeOauthReturnTo, validateReturnTo } from "./sign-in-return.js";
import { parseWaitSeconds } from "../pages/lockout.js";
import { renderSignedOutPage } from "./signed-out-page.js";
import { renderSignedInPage } from "./signed-in-page.js";
import { prefersHtml } from "./http-error-page.js";
import {
  KeyedThrottle,
  admitThroughLanes,
  secondsUntilReset,
} from "../auth/keyed-throttle.js";
import { addressBucket } from "../middleware/client-ip.js";
import { withConsentLock } from "../auth/consent-lock.js";
import { webOriginsOf } from "../auth/web-origins.js";
import {
  listActiveAppGrants,
  revokeProjectedGrant,
} from "../auth/grant-lifecycle.js";
import {
  bundlePublishedScopes,
  catchUpClientScopeCeiling,
} from "../auth/ceiling-catchup.js";
import { renderDevicePage } from "./device-pages.js";
import {
  renderDeviceConsentScreen,
  renderDeviceDecisionPage,
} from "./device-approval.js";
import { resolveSelection } from "./access-model.js";
import { chooseTypesFor } from "./access-types.js";
import { setNoStore } from "./no-store.js";
import { confirmGateFor } from "./confirm-gate.js";
import { forwardHeaders } from "./forward-headers.js";

/**
 * Persist (or refresh) a `kind: app` connection through `writeItem`, which
 * creates it on first consent and updates it on re-consent, so the row gets
 * what every item write gets: validation, search indexing, metadata-row
 * insertion, a versions snapshot on re-consent, and `source` stamping. Returns the connection-item id, whether the call
 * created vs updated the projection, and the scope list the record now
 * holds, which on re-consent is the union rather than the request, so the
 * caller's audit row can report both without recomputing it.
 *
 * Uses `findGrantItemId` to detect the re-consent case and updates through
 * `writeItem` (same shape as the code-flow consent's
 * `projectGrantOnConsent`). Status flips to "active" + `revoked_at` is
 * cleared on re-consent to avoid stale-revoked projections. The scopes it
 * writes there are the standing grant plus this approval, never less. A
 * lower level chosen on the device page narrows only the token this device
 * is issued, which the plugin mints for the code's narrowed scope, not the
 * record. A revoked grant is not a standing one, so it contributes nothing
 * and the record comes back at the approval alone.
 *
 * **`source` is the device literal.** The authorize surface writes its
 * projection through `projectGrantOnConsent`, which stamps its own.
 */
async function createUserAppGrant(
  storage: Storage,
  consenting: MarfaAuthSession,
  clientId: string,
  scopes: string[],
  source: "marfa/oauth/device",
): Promise<{
  id: string;
  created: boolean;
  scopes: string[];
}> {
  // eslint-disable-next-line no-restricted-syntax -- the sign-in pages move onto the clock with the rest of that surface
  const now = new Date().toISOString();
  const consentingUser = consenting.user;
  const by = browserWriter(
    consenting.session.id,
    consenting.session.userAgent ?? null,
  );

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
    // rationale as projectGrantOnConsent in auth/grant-lifecycle.ts.
    const existing = await storage.items.get(existingItemId);
    if (!existing) {
      // Race — findGrantItemId saw a row but a concurrent delete
      // raced. Fall through to insert.
    } else {
      // Union rather than overwrite. This screen offers a level for each type,
      // so a narrower set arriving here may be the client asking for less or
      // the person choosing a lower level and nothing at this call site can tell
      // them apart. The record keeps the standing grant either way,
      // deliberately; what the lower level reaches is the token this device is
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
      // **Both axes, because every read surface filters on both.**
      // `GET /auth/grants`, `GET /owner/sign-ins` and the Connected apps page list with
      // `state: "active"` and then skip a row whose `properties.status` is
      // not "active", so a row failing either axis is beyond the Disconnect
      // button while the token step below still mints against it.
      //
      // **The lookup is the first fence now, and this is the second.**
      // `findGrantItemId` carries its own `state = 'active'` predicate, so a
      // row sitting at `state: "revoked"` no longer reaches this branch at
      // all — the approval falls through to the fresh insert below and the
      // unreachable row is left where it is. That predicate lives in the
      // store rather than here because the code-flow twin
      // (`projectGrantOnConsent` in `auth/grant-lifecycle.ts`) resolves
      // through the same method and had the identical defect. This read stays because
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
      const written = await writeItem(
        storage,
        { kind: "platform", by },
        {
          op: "update",
          id: existingItemId,
          properties: {
            scopes: mergedScopes,
            status: "active",
            granted_at: now,
            revoked_at: undefined,
          },
        },
      );
      if (written.outcome === "updated") {
        const updated = written.item;
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
  const { item } = await writeItem(
    storage,
    { kind: "platform", by },
    {
      op: "create",
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
    },
  );
  return { id: item.id, created: true, scopes };
}

/**
 * Token issuance and id_token signing belong to the
 * @better-auth/oauth-provider plugin, with its own salt and signer wired
 * through `instance.ts`. Nothing here signs anything.
 */
export function authRoutes(storage: Storage, auth?: MarfaAuth) {
  const router = createOpenAPIRouter<AppEnv>();
  router.openAPIRegistry.registerPath(listGrantsRoute);
  router.openAPIRegistry.registerPath(deleteGrantRoute);

  // Each lane counts every door before looking up a code, including successful
  // lookups: a sweep may try each code only once. Owner authority comes from
  // the middleware's live session check, never from a cookie's presence.
  const deviceCodePerAddress = new KeyedThrottle(storage, {
    family: "device-user-code-address",
    limit: DEVICE_CODE_ADDRESS_LIMIT,
    windowMs: DEVICE_CODE_WINDOW_MS,
  });
  const deviceCodePerInstance = new KeyedThrottle(storage, {
    family: "device-user-code-instance",
    limit: DEVICE_CODE_INSTANCE_LIMIT,
    windowMs: DEVICE_CODE_WINDOW_MS,
  });
  const deviceCodePerOwner = new KeyedThrottle(storage, {
    family: "device-user-code-owner",
    limit: DEVICE_CODE_ADDRESS_LIMIT,
    windowMs: DEVICE_CODE_WINDOW_MS,
  });
  const deviceCodeOwnerInstance = new KeyedThrottle(storage, {
    family: "device-user-code-owner-instance",
    limit: DEVICE_CODE_INSTANCE_LIMIT,
    windowMs: DEVICE_CODE_WINDOW_MS,
  });

  type CodeLookupAdmission =
    { allowed: true } | { allowed: false; retryAfter: number };
  const refusal = (
    admitted: { allowed: true } | { allowed: false; resetAt: number },
  ): CodeLookupAdmission =>
    admitted.allowed
      ? admitted
      : { allowed: false, retryAfter: secondsUntilReset(admitted.resetAt) };

  /** Counts a lookup, and when a lane refuses it, says when another will be
   *  allowed: the latest end among the lanes that are spent. */
  const admitCodeLookup = async (
    c: Context<AppEnv>,
  ): Promise<CodeLookupAdmission> => {
    const authority = c.get("authority");
    if (authority?.kind === "owner") {
      // The transaction revalidates the admitted authority under the write lock,
      // so ending a session cannot race the owner lane's counter writes.
      return storage.runInTransaction(async () =>
        refusal(
          await admitThroughLanes([
            { throttle: deviceCodePerOwner, key: authority.userId },
            { throttle: deviceCodeOwnerInstance, key: "all" },
          ]),
        ),
      );
    }
    const ip = c.var.clientIp;
    // Over-cap callers cannot spend the rest of their lane's aggregate budget.
    return refusal(
      await admitThroughLanes([
        {
          throttle: deviceCodePerAddress,
          key: ip ? addressBucket(ip) : "unknown",
        },
        { throttle: deviceCodePerInstance, key: "all" },
      ]),
    );
  };

  /** The redirect to the code page for a lookup a lane refused. */
  const lookupRefused = (
    c: Context<AppEnv>,
    refusal: { retryAfter: number },
    userCode?: string,
  ): Response =>
    c.redirect(
      `/auth/device?${new URLSearchParams({
        error: "too_many_attempts",
        retry_after: String(refusal.retryAfter),
        ...(userCode ? { user_code: userCode } : {}),
      }).toString()}`,
      302,
    );

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
      requireDirectAuthority(c);
      return { kind: "session", session };
    }
    const url = new URL(c.req.url);
    const returnTo = `${url.pathname}${url.search}`;
    const signInPath = `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`;
    return c.redirect(signInPath, 302);
  }

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
    // Revoking another app's access is exactly the authority a person would
    // want to have been asked about, and `grants.manage` is the row they
    // tick to grant it. There is nothing else to reach this on: no door admits
    // on rank, and a signed-in app holds what its grant carries.
    requirePermission(c, "grants.manage");
    const grants: {
      id: string;
      kind: string;
      client_id: string;
      client_name: string | null;
      origins: string[];
      scopes: string[];
      status: string;
      granted_at: string;
      last_used_at: string | null;
    }[] = [];
    for (const item of await listActiveAppGrants(storage)) {
      const props = item.properties;
      const clientId =
        typeof props.client_id === "string" ? props.client_id : "";
      const client =
        clientId === ""
          ? null
          : ((await storage.oauthProvider?.getClient(clientId)) ?? null);
      grants.push({
        id: item.id,
        kind: appKindOf(client).kind,
        client_id: clientId,
        client_name: client?.name ?? null,
        origins: client === null ? [] : webOriginsOf(client),
        scopes: Array.isArray(props.scopes) ? (props.scopes as string[]) : [],
        status: typeof props.status === "string" ? props.status : "active",
        granted_at:
          typeof props.granted_at === "string" ? props.granted_at : "",
        last_used_at:
          typeof props.last_used_at === "string" ? props.last_used_at : null,
      });
    }
    return c.json({ data: grants, next_cursor: null });
  });

  router.openapi(narrowGrantRoute, async (c) => {
    requireRecentOwnerAuthentication(c);
    const { id } = c.req.valid("param");
    const { scopes, expected_scopes } = c.req.valid("json");
    const owner = await storage.owner?.find();
    const result = await narrowAppGrant(
      storage,
      owner?.id ?? null,
      id,
      expected_scopes,
      scopes,
      {
        keyId: authorityId(c),
        clientIp: c.var.clientIp ?? null,
        writer: requestWriter(c),
      },
    );
    return c.json({ scopes: result }, 200);
  });

  router.delete("/grants/:id", async (c) => {
    // The same axis as `GET /grants`: `grants.manage` to act at all.
    requirePermission(c, "grants.manage");
    if (c.get("authority")?.kind === "owner")
      requireRecentOwnerAuthentication(c);
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
      clientId,
      authUserId,
      by: requestWriter(c),
      // Opt-in, and never inferred. A caller here has nobody to ask, so the
      // keys the app minted survive unless this door was told to take them.
      revokeKeys: asksToRevokeKeys(c.req.query("revoke_keys")),
      audit: {
        key_id: authorityId(c),
        action: "auth.grant.revoked",
        resource_type: "oauth_grant",
        resource_id: clientId ?? id,
        client_ip: c.var.clientIp ?? null,
        details: {
          client_id: clientId,
          user_id: authUserId,
          grant_item_id: id,
        },
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
  // to Better Auth's JSON API (`POST /auth/sign-in/email`). Better Auth's
  // response is translated back into a 302 redirect so the no-JavaScript
  // path works — Set-Cookie headers from a successful sign-in are
  // forwarded intact onto the redirect response.

  router.get("/sign-in", async (c) => {
    c.header(
      "Content-Security-Policy",
      `${contentSecurityPolicy(c.var.cspNonce)}; connect-src 'self'`,
    );
    requireSecureOwnerTransport(auth ?? { baseURL: c.var.config.authBaseUrl });
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
    let returnTo = validateReturnTo(
      url.searchParams.get("return_to"),
      c.var.config.authBaseUrl,
    );
    if (returnTo === "/" && url.searchParams.has("response_type")) {
      returnTo = synthesizeOauthReturnTo(url.searchParams);
    }

    setNoStore(c);

    // Somebody already signed in is told so, rather than shown a form that
    // reads as though nobody were. Without an identity layer there is no
    // session to look for and the form is all there is.
    //
    // Not when an authorization sent them: the plugin sends a signed-in
    // person here to sign in afresh (`prompt=login`, an unsatisfied
    // `max_age`), and only a new session satisfies it. A page with no form
    // would send them round the same loop for ever.
    const sentByAuthorization =
      new URL(returnTo, "http://localhost").pathname === "/auth/authorize";
    const session = auth ? await auth.getSession(c.req.raw.headers) : null;
    if (
      session &&
      !sentByAuthorization &&
      url.searchParams.get("prompt") !== "login"
    ) {
      return c.html(
        renderSignedInPage({
          instanceName: await readInstanceName(storage.settings),
          nonce: c.var.cspNonce,
          email: session.user.email,
          continueTo: returnTo,
        }),
      );
    }

    // The app is named only once its request is verified, and only an
    // authorization can have sent the person here.
    const app = auth
      ? await appBehindReturnTo({ auth, storage }, returnTo)
      : null;
    const email = url.searchParams.get("email") ?? undefined;
    return c.html(
      renderSignInPage({
        instanceName: await readInstanceName(storage.settings),
        nonce: c.var.cspNonce,
        address: new URL(c.var.config.authBaseUrl).host,
        returnTo,
        error,
        retryAfter: parseWaitSeconds(url.searchParams.get("retry_after")),
        email,
        app: app ?? undefined,
      }),
    );
  });

  // Where "Forgot password?" leads. Marfa has no reset by email, so the page
  // says how to recover on the machine; it is fixed and needs no session.
  router.get("/forgot-password", (c) => {
    setNoStore(c);
    return c.html(renderForgotPasswordPage(c.var.cspNonce));
  });

  router.post("/sign-in", async (c) => {
    requireSecureOwnerTransport(auth ?? { baseURL: c.var.config.authBaseUrl });
    if (!auth) {
      throw new MarfaError(
        ErrorCode.UNAUTHORIZED,
        "Sign-in requires the better-auth identity layer to be configured",
      );
    }

    const formData = await c.req.formData();
    const returnTo = validateReturnTo(
      formData.get("return_to"),
      c.var.config.authBaseUrl,
    );
    const email = formData.get("email");
    const emailStr = typeof email === "string" ? email.trim() : "";

    // Carried back so the form is not emptied by a wrong password.
    const errorRedirect = (errCode: string, retryAfter?: string): Response =>
      c.redirect(
        buildSignInRedirect({
          returnTo,
          error: errCode,
          email: emailStr,
          retryAfter,
        }),
        302,
      );

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
    const response = await auth.handler(upstream, c.var.clientIp ?? null);

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
      return new Response(null, { status: 302, headers: redirectHeaders });
    }

    // A 429 is a limit, the per-address one or the per-account one in
    // `auth/sign-in-throttle.ts`, and the password was never judged. Its
    // `Retry-After` is the latest end among the limits that are spent.
    if (response.status === 429)
      return errorRedirect(
        "too_many_attempts",
        response.headers.get("retry-after") ?? undefined,
      );
    return errorRedirect("invalid_credentials");
  });

  // Browser logout. The plugin owns the whole of it — validating the id token,
  // matching the return URI, ending the session — and this wrapper adds two
  // pages: one for a browser with no session and no id token hint, which has
  // nothing to end, and one for the case where the plugin ends the session and
  // then has nowhere to send the person, which it answers with an empty 200.
  // That renders as a blank tab, which reads as a failure even though the
  // logout succeeded. Registered ahead of the catch-all so it sees the response
  // first; every other outcome is passed through untouched.
  router.get("/oauth2/end-session", async (c) => {
    if (!auth) {
      throw new MarfaError(
        ErrorCode.UNAUTHORIZED,
        "Sign-out requires the better-auth identity layer to be configured",
      );
    }
    // Somebody following a logout link with nothing to end has already got
    // what they came for. A browser navigation with no session and no hint
    // naming one is told so on a page; the provider has nothing to confirm,
    // and without the headers below it answers a browser in JSON.
    const navigating = prefersHtml(c.req.header("accept"));
    if (
      navigating &&
      !c.req.query("id_token_hint") &&
      !(await auth.getSession(c.req.raw.headers))
    ) {
      setNoStore(c);
      return c.html(renderSignedOutPage(c.var.cspNonce));
    }
    const upstream = new Request(c.req.url, {
      method: "GET",
      headers: forwardHeaders(c.req.raw.headers, {}, auth.baseURL, true),
    });
    const response = await auth.handler(upstream, c.var.clientIp ?? null);

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
      return new Response(renderSignedOutPage(c.var.cspNonce), {
        status: 200,
        headers,
      });
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
  // endpoints in-process, so the consent screen, its per-scope controls, the
  // grant projection and the audit row stay Marfa's:
  //   - GET /auth/device            — verification form (optionally pre-filled
  //                                   via ?user_code=…)
  //   - POST /auth/device           — the person submits their user_code; a
  //                                   live one redirects to the consent screen
  //   - GET /auth/device/consent    — consent screen, gated on a session; the
  //                                   plugin's verify claims the code for the
  //                                   person on the way in
  //   - POST /auth/device/consent   — approve with the chosen scopes, or deny

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

    const admission = await admitCodeLookup(c);
    if (!admission.allowed) return lookupRefused(c, admission, submitted);
    const refuseCode = (errorCode: string): Response =>
      c.redirect(
        `/auth/device?error=${errorCode}&user_code=${encodeURIComponent(submitted)}`,
        302,
      );

    // Asked without the request's cookies, so a code is neither claimed nor
    // moved by the check: the claim happens on the consent screen, once the
    // person has signed in.
    const verdict = await requireDeviceAuth().deviceVerify(
      submitted,
      new Headers(),
    );
    if (!verdict.ok) return refuseCode(pageErrorFor(verdict.reason));
    if (verdict.status !== "pending") return refuseCode("already_resolved");
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
    return c.html(
      renderDevicePage({
        prefilled: rawCode,
        error,
        retryAfter: parseWaitSeconds(url.searchParams.get("retry_after")),
        nonce: c.var.cspNonce,
      }),
    );
  });

  router.get("/device/consent", async (c) => {
    const sessionResult = await requireConsentSession(c);
    if (sessionResult instanceof Response) return sessionResult;
    const url = new URL(c.req.url);
    const userCode = normalizeUserCode(url.searchParams.get("user_code") ?? "");
    if (!userCode) {
      return c.redirect("/auth/device?error=missing_code", 302);
    }
    const admission = await admitCodeLookup(c);
    if (!admission.allowed) return lookupRefused(c, admission);
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
    if (containsProfileEmailWrite(verdict.scope))
      return c.text("Invalid scope: profile.email:write", 400);
    const parsedScopes = scopeList(verdict.scope)
      .map(parseScope)
      .filter(
        (s): s is NonNullable<ReturnType<typeof parseScope>> => s !== null,
      );
    const priorScopes = await storage.oauthProvider?.getPriorConsent(
      client.clientId,
      sessionResult.session.user.id,
    );
    // The same copy `/auth/authorize` renders, from the same function, so
    // which answer a person gets does not depend on which screen the flow
    // put them on.
    const descriptions = buildScopeDescriptions(parsedScopes);
    // Before the page is shown, so the reaper keeps the client while the
    // owner decides, however old its registration is.
    await storage.oauthProvider?.markClientOffered(client.clientId);

    const chooseTypes = await chooseTypesFor(
      storage,
      verdict.clientId,
      scopeList(verdict.scope),
    );
    setNoStore(c);
    return c.html(
      renderDeviceConsentScreen({
        instanceName: await readInstanceName(storage.settings),
        nonce: c.var.cspNonce,
        clientName: client.name ?? client.clientId,
        webOrigins: webOriginsOf(client),
        scopes: parsedScopes,
        userCode,
        priorScopes,
        descriptions,
        typeLabels: await resolveTypeLabels(storage, [
          ...scopeList(verdict.scope),
          ...(priorScopes ?? []),
        ]),
        signedInAs: sessionResult.session.user.email,
        // The same enumeration of an open-ended pattern the authorize screen
        // shows, so the reach reads the same on both.
        wildcardExpansions: await resolveWildcardExpansions(
          storage,
          parsedScopes,
        ),
        chooseTypes,
        bundles: getPermissionBundles(),
        confirmGate: confirmGateFor(
          c,
          client.name ?? client.clientId,
          scopeList(verdict.scope),
          priorScopes,
          chooseTypes,
        ),
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
    const admission = await admitCodeLookup(c);
    if (!admission.allowed) return lookupRefused(c, admission);
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
    if (
      containsProfileEmailWrite(requestedScopes) ||
      containsProfileEmailWrite(formData.getAll("scopes"))
    )
      return c.text("Invalid scope: profile.email:write", 400);

    // A denial reads no choice. An approval is read against what the device
    // asked for and what the app holds, inside the consent lock below.
    if (decision === "deny") {
      const denied = await deviceAuth.deviceDeny(userCode, c.req.raw.headers);
      if (!denied.ok) {
        return c.redirect(
          `/auth/device?error=${pageErrorFor(denied.reason)}&user_code=${encodeURIComponent(userCode)}`,
          302,
        );
      }
      setNoStore(c);
      return c.html(
        renderDeviceDecisionPage({
          approved: false,
          nonce: c.var.cspNonce,
        }),
      );
    }
    const submitted = formData
      .getAll("scopes")
      .filter((v): v is string => typeof v === "string");
    const typeValues = formData
      .getAll("types")
      .filter((v): v is string => typeof v === "string");

    // Approve: upsert the system.connection projection, narrow the code to
    // the chosen set, and approve it through the plugin.
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
    // has to read the chosen set before the status flips. A narrowing that
    // finds the row no longer pending is a race with a deny in another tab,
    // and is told it did not take effect.
    const outcome = await withConsentLock(
      clientId,
      sessionResult.session.user.id,
      () =>
        runAuditedTransaction(
          storage,
          async () => {
            const provider = storage.oauthProvider;
            const prior =
              (await provider?.getPriorConsent(
                clientId,
                sessionResult.session.user.id,
              )) ?? [];
            // What the person chose is what the device asked for, narrowed,
            // and read on the consent the commit sees: a value the code did
            // not carry is a form edited to ask for more than the screen
            // showed, and nothing from it is granted. Nothing newly chosen is
            // a denial, the same rule the authorize screen applies, because a
            // grant of nothing leaves a projection and a consent row standing
            // for a device that can do nothing with them.
            const selection = resolveSelection(
              requestedScopes,
              submitted,
              prior,
              {
                values: typeValues,
                offered: (
                  await chooseTypesFor(storage, clientId, requestedScopes)
                ).map((type) => type.id),
              },
            );
            if (!selection.ok) return { kind: "refused" } as const;
            if (!selection.chosen) return { kind: "nothing" } as const;
            const approvedScopes = selection.scopes;
            if (needsRecentSignIn(approvedScopes, prior))
              requireRecentOwnerAuthentication(c);
            // The write the device's initiation could not make: nobody was
            // signed in then. Inside the approval's transaction, so an
            // approval that does not take writes nothing, and strict because
            // the widening is part of what the approval records: a failure
            // here fails the approval rather than leaving the registration
            // behind what the person approved. The exchange itself is not
            // what needs it; the poll hook offers the code's scopes to the
            // plugin as initiation did (`guardDeviceCodeGrant`).
            const stored = await provider?.getClient(clientId);
            if (stored) {
              await catchUpClientScopeCeiling({
                storage,
                clientId,
                requested: approvedScopes,
                ceiling: stored.scopes,
                bundleScopes: bundlePublishedScopes(getPermissionBundles()),
                surface: "device",
                strict: true,
                covered: true,
              });
            }
            const created = await createUserAppGrant(
              storage,
              sessionResult.session,
              clientId,
              approvedScopes,
              "marfa/oauth/device",
            );
            const narrowed =
              typeof provider?.narrowDeviceCodeScope === "function"
                ? await provider.narrowDeviceCodeScope(userCode, approvedScopes)
                : false;
            if (!narrowed) throw new DeviceApprovalRefused();
            const approved = await deviceAuth.deviceApprove(
              userCode,
              c.req.raw.headers,
            );
            if (!approved.ok) throw new DeviceApprovalRefused();
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
            return {
              kind: "approved",
              grant: created,
              approvedScopes,
            } as const;
          },
          (result) => {
            if (result.kind !== "approved") return null;
            const { grant, approvedScopes } = result;
            return {
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
                // those as controls, so `approved_scopes` is what the person actually
                // chose, which can be narrower. And an approval merges into the
                // standing grant rather than replacing it, so `resulting_scopes` is
                // the record afterwards, which can be wider than either. On a
                // first-time approval where nothing was lowered, all three are the
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
            };
          },
        ),
    ).catch((error: unknown) => {
      if (error instanceof DeviceApprovalRefused)
        return { kind: "raced" } as const;
      throw error;
    });
    if (outcome instanceof Response) return outcome;
    if (outcome.kind === "refused")
      return c.text(
        "The decision names a scope the device did not ask for",
        400,
      );
    if (outcome.kind === "nothing") {
      const denied = await deviceAuth.deviceDeny(userCode, c.req.raw.headers);
      if (!denied.ok) {
        return c.redirect(
          `/auth/device?error=${pageErrorFor(denied.reason)}&user_code=${encodeURIComponent(userCode)}`,
          302,
        );
      }
      setNoStore(c);
      return c.html(
        renderDeviceDecisionPage({
          approved: false,
          nonce: c.var.cspNonce,
        }),
      );
    }
    if (outcome.kind === "raced") {
      // Race: someone else flipped it in between. Surface as already-resolved.
      return c.redirect(
        `/auth/device?error=already_resolved&user_code=${encodeURIComponent(userCode)}`,
        302,
      );
    }
    setNoStore(c);
    return c.html(
      renderDeviceDecisionPage({
        approved: true,
        nonce: c.var.cspNonce,
      }),
    );
  });

  return router;
}

// ---------------------------------------------------------------------------
// Device Authorization Grant — local helpers
// ---------------------------------------------------------------------------

class DeviceApprovalRefused extends Error {}

/** Device code lookups one anonymous address or verified owner may make per window. */
export const DEVICE_CODE_ADDRESS_LIMIT = 10;

/** Device code lookups each lane takes across the instance per window. */
export const DEVICE_CODE_INSTANCE_LIMIT = 100;

const DEVICE_CODE_WINDOW_MS = 15 * 60 * 1000;

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
 *  shape (error, retry_after, email, return_to). All values are encoded. */
function buildSignInRedirect(params: {
  returnTo: string;
  error?: string;
  email?: string;
  retryAfter?: string;
}): string {
  const search = new URLSearchParams();
  if (params.error) search.set("error", params.error);
  if (params.retryAfter) search.set("retry_after", params.retryAfter);
  if (params.email) search.set("email", params.email);
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
