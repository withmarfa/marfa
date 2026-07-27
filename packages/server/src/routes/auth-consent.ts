/**
 * `/auth/authorize` consent page (Hono route).
 *
 * Replaces the homegrown GET/POST `/auth/authorize` handlers that lived
 * in `routes/auth-pages.ts`. The @better-auth/oauth-provider plugin's
 * `consentPage: "/auth/authorize"` config redirects unauthenticated /
 * unaccepted authorization requests here with the **full signed
 * authorize-request query string** as the URL's search part:
 *
 *   `/auth/authorize?response_type=code&client_id=...&redirect_uri=...
 *   &scope=...&state=...&code_challenge=...&code_challenge_method=S256
 *   &exp=<ts>&sig=<hmac>`
 *
 * (No pre-minted code — the plugin signs the params and forwards.
 * Verified in @better-auth/oauth-provider@1.6.13 —
 * `redirectWithPromptCode` + `signParams`.)
 *
 * This route:
 *   - verifies that signature before anything else, including before
 *     rendering: a consent screen composed from a request nobody signed
 *     is an attacker-authored page served by the real issuer on the real
 *     origin, and refusing the submit afterwards does not take it back
 *   - extracts `client_id` + `scope` from the verified parameter set for
 *     rendering
 *   - keeps the signed parameter set as `oauthQuery` so the consent form
 *     can POST it back to `/auth/oauth2/consent` unchanged (the plugin's
 *     before-hook re-verifies the sig). Marfa's own display-only
 *     parameters are lifted off first — the signature covers every other
 *     key, so a parameter added to the URL for the page's benefit has to
 *     be one this route knows to remove
 *   - looks up the user's prior consent for the re-consent diff
 *   - **skips the consent screen** when that prior consent already covers
 *     every requested scope (and the request doesn't carry
 *     `prompt=consent`): the accept is performed server-side against the
 *     plugin's `/oauth2/consent` and the browser 302s straight back to
 *     the client with a code. Without this, every fresh sign-in
 *     re-renders consent — the plugin's own already-consented check only
 *     runs at `/oauth2/authorize`, and the post-sign-in `return_to`
 *     lands here without passing back through it.
 *   - handles `prompt=none` per OIDC: silent code when the grant covers
 *     the request, `error=login_required` with no session, and
 *     `error=consent_required` when the grant doesn't cover the request —
 *     never a rendered page
 *   - renders via the existing `renderConsentScreen` otherwise
 *
 * The decision handler (`POST /auth/authorize/decision`) proxies to
 * `/auth/oauth2/consent` with `{ accept, scope?, oauth_query }`. The
 * plugin verifies the sig, upserts its own `oauthConsent` row, mints the
 * code, and returns a JSON redirect body
 * `{ redirect: true, url: "<redirect_uri>?code=..." }`. Only after that
 * redirect is confirmed as a code-bearing callback to the registered
 * client does the handler project the `system.connection { kind: "app" }`
 * row and emit `auth.grant.created`.
 *
 * Auth gating: the plugin only redirects here when the user is already
 * signed in (it redirects to `loginPage: "/auth/sign-in"` first). If
 * a no-session request lands here directly, we bounce to sign-in with
 * a return_to so the round-trip works — except under `prompt=none`,
 * which forbids showing the user anything and gets `login_required`
 * returned to the client instead.
 *
 * What a silent re-authorization does and does not change: it mints a
 * code for the scopes the client asked for, emits `auth.grant.reused`,
 * and leaves both records of the grant alone — the projected
 * `system.connection` row is not rewritten, and the plugin's own
 * narrowing of `auth_oauth_consent.scopes` is undone. Narrowing a grant
 * is a deliberate act; a client asking for less than it was given is
 * not the user withdrawing the rest.
 */

import { Hono } from "hono";
import { makeSignature, constantTimeEqual } from "better-auth/crypto";
import type { ParsedScope } from "@withmarfa/shared";
import {
  parseScope,
  isValidScope,
  TYPE_REGISTRY,
  EDGE_TYPE_REGISTRY,
} from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { MarfaAuth } from "../auth/instance.js";
import { renderConsentScreen } from "./consent.js";
import { setNoStore, withNoStore } from "./no-store.js";
import { forwardHeaders } from "./forward-headers.js";
import { publish } from "../pubsub.js";
import { log } from "../middleware/logger.js";

/**
 * Query parameter carrying a consent-page error banner code back from the
 * decision handler.
 *
 * Marfa-owned and Marfa-named: the plugin signs an exact parameter set,
 * and the round trip has to carry the signed query back untouched, so a
 * parameter added for the page's own use must be one this route knows to
 * lift off before handing the query back. It also has to be a name the
 * plugin will never sign — `error` alone is an OAuth response parameter
 * and reserving it here would be reserving somebody else's word.
 */
const CONSENT_ERROR_PARAM = "marfa_consent_error";

/** Every parameter this route adds to its own URL. Stripped before the
 *  query is handed back to the plugin. */
const CONSENT_DISPLAY_PARAMS = [CONSENT_ERROR_PARAM] as const;

/**
 * Raised when a consent narrowed the granted scopes but the access tokens
 * carrying the removed ones could not be revoked.
 *
 * Distinct from every other projection failure because the caller has to
 * treat it differently: a projection that fails to write leaves the user
 * with a stale record of a grant that is otherwise correct, while a
 * narrowing that fails to revoke leaves live credentials for permissions
 * the user believes they have taken away.
 */
class NarrowingNotEnforced extends Error {
  constructor(override readonly cause: unknown) {
    super("consent narrowing could not revoke the wider-scope tokens");
    this.name = "NarrowingNotEnforced";
  }
}

interface ConsentRouteDeps {
  storage: Storage;
  auth: MarfaAuth | undefined;
  /**
   * Operator-allowed origins (`CORS_ORIGINS`). Combined with the origin of
   * `authBaseUrl` to form the allowlist the consent decision handler checks
   * the request `Origin` / `Referer` against — independent defense beneath
   * SameSite=Lax + the downstream better-auth Origin check.
   */
  corsOrigins: readonly string[];
  /** Issuer URL the auth surface is reached at (`MARFA_AUTH_BASE_URL`). */
  authBaseUrl: string;
}

/**
 * Derive the origin (scheme + host + port) of `authBaseUrl`. Returns
 * `undefined` for an unparseable value so a misconfigured base URL doesn't
 * throw inside the request path — the allowlist simply omits it.
 */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the request's effective origin for the CSRF check: the `Origin`
 * header when present, else the origin of the `Referer` URL. Returns
 * `undefined` when neither is present (a same-origin form POST may omit
 * both) or when `Referer` is unparseable.
 */
function requestOrigin(headers: Headers): string | undefined {
  const origin = headers.get("origin");
  if (origin) return origin;
  const referer = headers.get("referer");
  if (referer) return originOf(referer);
  return undefined;
}

export function authConsentRoutes(deps: ConsentRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Origin allowlist for the consent decision CSRF guard: every operator
  // CORS origin plus the auth issuer's own origin (a same-origin POST from
  // the rendered consent page). Built once at construction.
  const allowedOrigins = new Set<string>(deps.corsOrigins);
  const baseOrigin = originOf(deps.authBaseUrl);
  if (baseOrigin) allowedOrigins.add(baseOrigin);

  // ----- GET /auth/authorize (consent page render) -----
  app.get("/authorize", async (c) => {
    if (!deps.auth) {
      return c.text("Auth not configured on this instance", 503);
    }
    // Bound to a local so the narrowing survives into the closures below.
    const auth = deps.auth;

    const url = new URL(c.req.url);
    // The plugin signs an exact parameter set and expects it returned
    // verbatim. `signedParams` is that set and nothing else: Marfa's own
    // display-only parameters are lifted off first (see
    // `CONSENT_DISPLAY_PARAMS`), because the signature covers every
    // remaining key and one extra pair invalidates it. Everything this
    // handler reads about the request comes from here rather than from
    // `url`, so no unsigned parameter can influence a decision. It
    // round-trips to the plugin through the form's `oauth_query` field.
    const signedParams = new URLSearchParams(url.search);
    const consentError = signedParams.get(CONSENT_ERROR_PARAM);
    for (const name of CONSENT_DISPLAY_PARAMS) signedParams.delete(name);
    const oauthQuery = signedParams.toString();

    const clientId = signedParams.get("client_id") ?? "";
    const requestedRedirectUri = signedParams.get("redirect_uri");
    const scopeParam = signedParams.get("scope") ?? "";
    const sig = signedParams.get("sig");

    if (!clientId || !sig) {
      return c.text(
        "Missing required query params: client_id and sig (the plugin's signed redirect to /auth/authorize must carry both)",
        400,
      );
    }

    // Nothing below acts on an authorize request the plugin did not sign,
    // and rendering is acting on it. A consent screen is a page the user
    // is meant to trust: served by the real issuer, on the real origin,
    // naming an app and a list of permissions that on this path would be
    // whoever crafted the URL's to choose. Refusing the submit afterwards
    // does not help — the page was the payload. The same reasoning covers
    // the sign-in bounce below, which is the same page one hop earlier
    // with a credential prompt on it, and an expired-but-genuine request,
    // which can no longer produce a code and so has nothing to render for.
    if (!(await verifySignedQuery(auth, oauthQuery))) {
      return c.text("Invalid or expired authorize request signature", 400);
    }

    // OIDC `prompt` rides the signed query verbatim:
    //   - `consent` → always render, even when covered
    //   - `none`    → never render; every outcome is a redirect back to
    //     the client carrying either a code or an OIDC error code
    //   - absent    → skip when covered, else render
    //
    // Parsed before the session gate because `prompt=none` changes what a
    // missing session means: OIDC Core §3.1.2.6 requires `login_required`
    // returned to the client, not a sign-in page the request explicitly
    // forbade.
    const promptSet = new Set(
      (signedParams.get("prompt") ?? "").split(/\s+/).filter(Boolean),
    );
    const promptNone = promptSet.has("none");

    /**
     * Emit an OIDC error back to the client, for a `prompt=none` request
     * that cannot be answered with a code.
     *
     * The `redirect_uri` and `state` come straight off the request, so
     * this path is only safe behind the signature check above: without it
     * any signed-in user's browser could be navigated to
     * `/auth/authorize` with a registered `client_id`, that client's
     * registered `redirect_uri`, `prompt=none` and a `state` of the
     * attacker's choosing, and would 302 to the client's callback echoing
     * that `state`. Reading from the verified parameter set is also what
     * makes appending `&prompt=none` to a legitimate consent URL fail
     * closed rather than convert that flow into a client-visible error.
     */
    const promptNoneError = (
      registeredRedirectUris: readonly string[],
      error: string,
      description: string,
    ): Response =>
      buildPromptNoneErrorRedirect(
        registeredRedirectUris,
        signedParams,
        error,
        description,
      ) ?? c.text("prompt=none requires a registered redirect_uri", 400);

    // Auth gate: the plugin's loginPage handles unsigned users normally,
    // but a direct hit on /auth/authorize without a session needs a
    // fallback bounce to sign-in. We pass the full URL as return_to
    // so the round-trip completes after sign-in.
    //
    // The client row is resolved inside the `prompt=none` branch rather
    // than ahead of this gate, so an unauthenticated caller still gets
    // the same sign-in bounce whether or not `client_id` is registered.
    // Resolving first would turn this route into a client-existence
    // oracle for anyone with no session at all.
    const session = await auth.getSession(c.req.raw.headers);
    if (!session) {
      if (promptNone) {
        const target = await resolveClient(deps.storage, clientId);
        if (!target) return c.text(`Unknown client: ${clientId}`, 404);
        return promptNoneError(
          target.redirectUris,
          "login_required",
          "End-User authentication is required",
        );
      }
      // Round-trip the signed parameter set, not the raw search: the
      // display-only parameters have served their purpose and a stale
      // error banner after signing in would be noise.
      const returnTo = encodeURIComponent(`${url.pathname}?${oauthQuery}`);
      return c.redirect(`/auth/sign-in?return_to=${returnTo}`);
    }

    // Parse + validate the requested scopes. Reject early on invalid
    // grammar — the plugin's own scope validation runs at /oauth2/authorize
    // (which mints the code), but a hand-crafted URL into /authorize
    // shouldn't bypass that.
    const scopeLiterals = scopeParam.split(/\s+/).filter(Boolean);
    const parsed: ParsedScope[] = [];
    for (const literal of scopeLiterals) {
      if (!isValidScope(literal)) {
        return c.text(`Invalid scope: ${literal}`, 400);
      }
      const p = parseScope(literal);
      if (!p) {
        return c.text(`Unparseable scope: ${literal}`, 400);
      }
      parsed.push(p);
    }

    // F12: resolve the client row (full row, not just the name). 404 only
    // when the row doesn't exist (genuinely unknown client). When the row
    // exists but `name` is null (DCR clients without `client_name` per
    // RFC 7591 §2 — `client_name` is OPTIONAL), fall back to displaying
    // the `clientId` itself rather than 404'ing a legitimate client.
    const client = await resolveClient(deps.storage, clientId);
    if (!client) {
      return c.text(`Unknown client: ${clientId}`, 404);
    }
    const clientName = client.name ?? clientId;

    // Look up the user's prior consent for (client_id, user_id) in
    // auth_oauth_consent. If present, the renderer shows the diff
    // (added/kept/removed); if not, renders flat.
    const priorScopes = await resolvePriorScopes(
      deps.storage,
      clientId,
      session.user.id,
    );

    // ----- Consent skip (already-granted → silent re-authorization) -----
    // The plugin's own already-consented check runs only at
    // /oauth2/authorize; the post-sign-in return_to lands here without
    // passing back through it, so without this branch every fresh
    // sign-in re-renders the consent screen. When the prior grant
    // already covers every requested scope, perform the accept
    // server-side (the plugin's before-hook still verifies the signed
    // query, so a tampered request cannot silently mint a code) and
    // send the browser straight back to the app.
    //
    // A requested set that WIDENS the prior grant falls through to the
    // re-consent diff render, and a revoked grant has no consent row
    // (revocation deletes it), so it falls through too.
    //
    // An EMPTY requested set is not "covered" even though it is
    // vacuously a subset of anything. The decision handler treats a
    // zero-scope accept as a deny; the two must not disagree about
    // whether a request for nothing is something the server approves.
    const priorSet =
      priorScopes !== undefined ? new Set(priorScopes) : undefined;
    const alreadyGranted =
      priorSet !== undefined &&
      scopeLiterals.length > 0 &&
      scopeLiterals.every((literal) => priorSet.has(literal));

    if (!promptSet.has("consent") && alreadyGranted) {
      const proxyResp = await proxyConsentDecision(
        auth,
        c.req.url,
        c.req.raw.headers,
        {
          accept: true,
          scope: scopeLiterals.join(" ") || undefined,
          oauthQuery,
        },
        // A top-level browser navigation carries no `Origin`, and Better
        // Auth rejects a cookie-bearing POST it can't attribute to a
        // trusted origin. Without the fallback the internal accept is
        // refused and the skip silently degrades to a re-render — which
        // is the whole behavior this branch exists to prevent. The
        // request being wrapped is a GET the browser already made; the
        // origin of the dispatch genuinely is the issuer's own.
        auth.baseURL,
      );
      // The plugin rewrites the stored consent scopes to the requested
      // set, and does so BEFORE the checks that can still refuse the
      // request (disabled client, invalid scope, unregistered redirect).
      // So the standing grant has to be put back on every outcome, not
      // just the successful one — a refusal must not be able to shrink a
      // grant as a side effect.
      await preserveBroaderGrant(deps.storage, {
        authUserId: session.user.id,
        clientId,
        priorScopes: priorScopes ?? [],
        requestedScopes: scopeLiterals,
      });

      const outcome = classifyProxyOutcome(proxyResp, requestedRedirectUri);

      if (outcome === "code") {
        // The projected grant record is deliberately untouched on reuse:
        // no re-projection, no granted_at bump. `last_used_at` is
        // stamped by the bearer middleware when the minted token is
        // actually used.
        void auditGrantReused(deps.storage, {
          authUserId: session.user.id,
          clientId,
          scopes: scopeLiterals,
          clientIp: c.var.clientIp ?? null,
        });
        // The Location carries a live authorization code. Every other
        // auth surface stamps no-store; a redirect holding a credential
        // has more reason to than most.
        return withNoStore(proxyResp);
      }

      if (outcome === "client_error") {
        // The plugin already produced a spec-shaped error response aimed
        // at the client's own callback (invalid scope, disabled client,
        // …). Forwarding it is strictly better than rendering a consent
        // screen that would fail the same way on submit.
        return withNoStore(proxyResp);
      }

      if (outcome === "interaction") {
        // Signature and session were fine, but the plugin wants a fresh
        // interaction — an unsatisfied `prompt=login`, most commonly.
        // `prompt=none` forbids exactly that.
        if (promptNone) {
          return promptNoneError(
            client.redirectUris,
            "interaction_required",
            "End-User interaction is required",
          );
        }
      } else if (promptNone) {
        // `outcome === "rejected"`: the plugin refused the accept
        // outright (expired or tampered signature, session mismatch).
        // Nothing here is trustworthy enough to redirect anywhere.
        return c.text("The authorize request was refused", 400);
      }
      // Everything else falls through to the consent screen, which
      // surfaces the same failure on submit.
    } else if (promptNone) {
      return promptNoneError(
        client.redirectUris,
        "consent_required",
        "End-User consent is required",
      );
    }

    // Build the type-pattern → plain-English description map.
    // F11: covers item types (TYPE_REGISTRY), edge types (EDGE_TYPE_REGISTRY),
    // and the standard OIDC literals (built-in copy). Metadata scopes are
    // skipped — they're operator-tooling scopes that don't need UI copy.
    const descriptions = buildScopeDescriptions(parsed);

    // Optional error banner (e.g. when redirected back from a zero-scopes
    // accept). Renderer ignores undefined.
    const errorMessage = consentError
      ? translateConsentError(consentError)
      : undefined;

    const html = renderConsentScreen({
      clientName,
      // Public clients (DCR / `token_endpoint_auth_method: none`) self-assert
      // their name with no vetted identity behind it. Flag them so the user
      // can tell a self-asserted name from a confidential, verified one — a
      // scammer registering a client named "Google Drive" must be visibly
      // distinguishable.
      unverified: client.isPublic,
      scopes: parsed,
      clientId,
      oauthQuery,
      descriptions,
      priorScopes,
      errorMessage,
    });

    // Every consent-page render carries `Cache-Control: no-store`.
    // See `routes/no-store.ts` for the helper used across every auth
    // HTML surface.
    setNoStore(c);
    return c.html(html);
  });

  // ---------------------------------------------------------------------
  // POST /auth/authorize/decision — Marfa-owned decision handler that
  // proxies to the plugin's /oauth2/consent endpoint, then writes the
  // system.connection projection + audit row only after the plugin has
  // returned a verified, code-bearing callback to the registered client.
  //
  // The plugin's /oauth2/consent body shape (verified in source
  // @better-auth/oauth-provider@1.6.13):
  //   { accept: boolean, scope?: string, oauth_query: string }
  // where `oauth_query` is the full signed query string the plugin
  // redirected us here with. Plugin's before-hook verifies the sig
  // against `oauth_query`, re-hydrates the original authorize-request
  // params into `oAuthState`, then `consentEndpoint` mints the code
  // and returns `{ redirect: true, url: "<redirect_uri>?code=..." }`.
  //
  // This explicit handler:
  //   1. reads `accept` + `client_id` + `oauth_query` + selected
  //      `scopes` from the form
  //   2. POSTs `{ accept, scope, oauth_query }` to /auth/oauth2/consent
  //      (JSON body — the plugin's `allowedMediaTypes` defaults to JSON
  //      for this endpoint)
  //   3. confirms that an accepted decision produced a code-bearing
  //      redirect to one of the client's registered callbacks
  //   4. projects `system.connection { kind: "app" }` (insert OR update
  //      on re-consent) + emits `auth.grant.created` audit row
  //   5. forwards the resulting redirect (302 OR JSON
  //      `{redirect, url}`) to the browser as a real 302
  // ---------------------------------------------------------------------
  app.post("/authorize/decision", async (c) => {
    if (!deps.auth) {
      return c.text("Auth not configured on this instance", 503);
    }

    // Defense-in-depth CSRF guard: reject a POST whose `Origin` (or, absent
    // that, `Referer`) is present but not in the allowlist. SameSite=Lax and
    // the downstream better-auth Origin check already cover this in normal
    // operation; this is an independent fence the consent handler owns. A
    // missing Origin/Referer is allowed through — a same-origin form POST may
    // omit both, and better-auth rejects null-origin form POSTs at the proxy
    // hop — so we only reject a *present, non-allowlisted* origin.
    const origin = requestOrigin(c.req.raw.headers);
    if (origin && !allowedOrigins.has(origin)) {
      return c.text("Cross-origin consent decision rejected", 403);
    }

    // Parse form FIRST (before the session check) so we can preserve
    // `oauth_query` on a session-expired bounce to sign-in (F10). Without
    // it the user signs back in and lands on /auth/sign-in's default
    // post-auth target instead of the consent page they were on.
    const form = await c.req.formData();
    const accept = form.get("accept") === "true";
    const oauthQueryRaw = form.get("oauth_query");
    const oauthQuery =
      typeof oauthQueryRaw === "string" ? oauthQueryRaw : undefined;

    const session = await deps.auth.getSession(c.req.raw.headers);
    if (!session) {
      // Preserve oauth_query so the user returns to consent after sign-in.
      if (oauthQuery) {
        const returnTo = encodeURIComponent(`/auth/authorize?${oauthQuery}`);
        return c.redirect(`/auth/sign-in?return_to=${returnTo}`, 302);
      }
      return c.redirect("/auth/sign-in", 302);
    }

    if (!oauthQuery) {
      return c.text("Missing required form field: oauth_query", 400);
    }

    // The plugin checks the signed query at the proxy hop too, but every
    // Marfa-owned side effect below must be gated independently. Rejecting
    // here also avoids relying on the shape of a plugin error response to
    // decide whether it is safe to project or revoke anything.
    if (!(await verifySignedQuery(deps.auth, oauthQuery))) {
      return c.text("Invalid or expired authorize request signature", 400);
    }

    // Parse `client_id` + `scope` from the verified `oauth_query`, NOT
    // from form fields. The plugin signed the oauth_query — those values
    // are tamper-evident. Trusting the form's client_id would let a
    // hostile POST project a grant for a different client than the one
    // the user is approving.
    const signedParams = new URLSearchParams(oauthQuery);
    const clientId = signedParams.get("client_id");
    const requestedRedirectUri = signedParams.get("redirect_uri");
    const signedScopeStr = signedParams.get("scope") ?? "";
    const signedScopes = new Set(signedScopeStr.split(/\s+/).filter(Boolean));
    if (!clientId) {
      return c.text("oauth_query missing client_id", 400);
    }

    const client = await resolveClient(deps.storage, clientId);
    if (!client) {
      return c.text(`Unknown client: ${clientId}`, 404);
    }

    // Form-supplied scopes are the user's per-row checkbox state.
    // Validate they're a subset of the signed scopes (the consent UI
    // can only narrow, not widen). Anything outside the signed set is
    // a hostile or buggy form — drop and continue with the signed set.
    const formScopes = form
      .getAll("scopes")
      .filter((v): v is string => typeof v === "string")
      .filter((s) => signedScopes.has(s));

    // Zero-scopes accept = deny. If the user submits `accept=true` with
    // no checkboxes ticked, the plugin would default to the full originally-
    // requested scope set AND the projection would skip — leaving /security
    // showing no grant while tokens are valid. Treat as deny + redirect
    // back with an error banner.
    //
    // The banner rides a Marfa-owned parameter that the consent page lifts
    // back off before handing the query on. Appending anything else here
    // would leave the user on a page whose signed query no longer
    // verifies, so every retry after a mis-click would die at the
    // signature check — the one failure mode this recovery exists to
    // avoid.
    if (accept && formScopes.length === 0) {
      const bounce = new URLSearchParams(oauthQuery);
      bounce.set(CONSENT_ERROR_PARAM, "no_scopes_selected");
      return c.redirect(`/auth/authorize?${bounce.toString()}`, 302);
    }

    const scopeStr = formScopes.join(" ");

    // Forward to the plugin's /oauth2/consent endpoint and hand the
    // (normalized) result to the browser. Shared with the GET handler's
    // consent-skip path.
    const proxyResp = await proxyConsentDecision(
      deps.auth,
      c.req.url,
      c.req.raw.headers,
      {
        accept,
        // Forward the user's narrowed scope set so the plugin issues a
        // token matching what they actually approved (not the full
        // originally-requested set).
        scope: accept && scopeStr ? scopeStr : undefined,
        oauthQuery,
      },
    );

    // A valid signed query is necessary but not sufficient: the plugin can
    // still refuse a disabled client, an invalid redirect, or a flow that
    // requires fresh interaction. Projection, audit, and narrowing-token
    // revocation are consent-success side effects, so none may happen until
    // a code actually reaches the client's registered callback.
    if (
      !accept ||
      classifyProxyOutcome(proxyResp, requestedRedirectUri) !== "code"
    ) {
      return proxyResp;
    }

    try {
      await projectGrantOnConsent(deps.storage, {
        authUserId: session.user.id,
        clientId,
        scopes: formScopes,
        clientIp: c.var.clientIp ?? null,
      });
    } catch (err) {
      if (err instanceof NarrowingNotEnforced) {
        // Narrowing a grant is a promise that the access it removes stops
        // working. Tokens already issued at the wider scope outlive the
        // consent row, so if they cannot be revoked the promise is not
        // kept — and handing back the code-bearing redirect would tell
        // the user it was. Fail loudly instead: the record still
        // describes the wider grant the tokens actually carry, which is
        // at least true.
        log("error", "consent decision: narrowing revocation failed", {
          client_id: clientId,
          error: err.cause instanceof Error ? err.cause.message : "unknown",
        });
        return c.text(
          "Could not withdraw the access you removed, so the change was not applied. Try again.",
          500,
        );
      }
      log("warn", "consent decision: projection failed", {
        client_id: clientId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return proxyResp;
  });

  return app;
}

/**
 * POST a consent decision to the plugin's `/auth/oauth2/consent`
 * endpoint and normalize the outcome for a browser.
 *
 * JSON body (the plugin's default media type for this endpoint):
 * `{ accept, scope?, oauth_query }`. Cookies pass through via the
 * original request headers — the session cookie is what the plugin uses
 * to authenticate the decision, and its before-hook re-verifies the
 * signed `oauth_query` before minting anything.
 *
 * The plugin returns either a 302 (browser-native redirect) OR a 200
 * with JSON body `{ redirect: true, url: "..." }` — the latter is the
 * default when better-auth doesn't see `Accept: text/html`. Both are
 * normalized to a real 302 so the browser navigates correctly. Any
 * other response (signature failure, expired query, plugin rejection)
 * is returned verbatim for the caller to handle.
 *
 * `fallbackOrigin` stamps the dispatch with an `Origin` when the inbound
 * request has none — needed when the caller is a GET the browser reached
 * by navigation. The decision handler deliberately omits it: that POST
 * arrives from a form, browsers always attach an `Origin` to one, and
 * Better Auth refusing an origin-less form POST is a fence the handler
 * relies on rather than something to paper over.
 */
async function proxyConsentDecision(
  auth: MarfaAuth,
  requestUrl: string,
  requestHeaders: Headers,
  decision: { accept: boolean; scope?: string; oauthQuery: string },
  fallbackOrigin?: string,
): Promise<Response> {
  const proxyUrl = new URL("/auth/oauth2/consent", requestUrl);
  const proxyHeaders = forwardHeaders(
    requestHeaders,
    { "content-type": "application/json" },
    fallbackOrigin,
  );

  const proxyBody: Record<string, unknown> = {
    accept: decision.accept,
    oauth_query: decision.oauthQuery,
  };
  if (decision.accept && decision.scope) {
    proxyBody.scope = decision.scope;
  }

  const proxyReq = new Request(proxyUrl.toString(), {
    method: "POST",
    headers: proxyHeaders,
    body: JSON.stringify(proxyBody),
    redirect: "manual",
  });

  const proxyResp = await auth.handler(proxyReq);
  if (proxyResp.status === 302) {
    return proxyResp;
  }
  if (proxyResp.status === 200) {
    try {
      const cloned = proxyResp.clone();
      const body = (await cloned.json()) as {
        redirect?: boolean;
        url?: string;
      };
      if (body.redirect && typeof body.url === "string") {
        // Preserve plugin response headers on the 302 normalization —
        // the plugin may set `Set-Cookie` (session refresh) or other
        // security headers; a bare redirect would discard them.
        const headers = new Headers(proxyResp.headers);
        headers.delete("content-type");
        headers.delete("content-length");
        headers.set("location", body.url);
        return new Response(null, { status: 302, headers });
      }
    } catch {
      // Fall through — return the plugin response verbatim.
    }
  }
  return proxyResp;
}

/**
 * Is this authorize query one the OAuth Provider plugin actually signed,
 * and still inside its validity window?
 *
 * Mirrors the plugin's own `verifyOAuthQueryParams`: strip `sig`,
 * re-sign what remains with the instance's signing secret, compare in
 * constant time, and reject anything past `exp`. The plugin's copy is
 * internal to the package, so this is a deliberate re-implementation
 * against the same public primitives (`makeSignature` from
 * `better-auth/crypto`) and the same secret the instance signs with —
 * `MarfaAuth.signingSecret` exists so there is one resolved value rather
 * than a verifier guessing at what the signer used.
 *
 * The plugin re-verifies on its own before minting anything, so this is
 * not the fence that protects code issuance. It is the fence in front of
 * the paths that act on the query WITHOUT reaching the plugin: the
 * `prompt=none` error redirects, which take a `redirect_uri` and a
 * `state` straight off the URL.
 */
async function verifySignedQuery(
  auth: MarfaAuth,
  oauthQuery: string,
): Promise<boolean> {
  try {
    const params = new URLSearchParams(oauthQuery);
    const sig = params.get("sig");
    if (!sig) return false;
    const expSeconds = Number(params.get("exp"));
    if (!Number.isFinite(expSeconds) || expSeconds * 1000 < Date.now()) {
      return false;
    }
    params.delete("sig");
    const expected = await makeSignature(params.toString(), auth.signingSecret);
    return constantTimeEqual(sig, expected);
  } catch (err) {
    log("warn", "consent: signed-query verification failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Is `candidate` one of the client's registered redirect URIs? Exact
 * match, plus the loopback-IP allowance the plugin applies at
 * `/oauth2/authorize` (RFC 8252 §7.3: native apps bind an ephemeral
 * port, so the port is ignored for loopback hosts).
 */
function isRegisteredRedirectUri(
  registeredRedirectUris: readonly string[],
  candidate: string,
): boolean {
  return registeredRedirectUris.some((entry) => {
    if (entry === candidate) return true;
    try {
      const a = new URL(entry);
      const b = new URL(candidate);
      const loopback =
        a.hostname === "127.0.0.1" ||
        a.hostname === "::1" ||
        a.hostname === "[::1]";
      return (
        loopback &&
        a.hostname === b.hostname &&
        a.pathname === b.pathname &&
        a.protocol === b.protocol &&
        a.search === b.search
      );
    } catch {
      return false;
    }
  });
}

/**
 * What the plugin actually did with a proxied consent decision.
 *
 * The proxy normalizes both of the plugin's success shapes to a 302, so
 * "status is 302" answers nothing on its own: an error redirect and a
 * bounce back to the sign-in page look identical to a minted code. Only
 * a redirect at the client's own registered callback carrying `code`
 * means an authorization was actually issued.
 *
 *  - `code`         — redirect to a registered `redirect_uri` with `code`
 *  - `client_error` — redirect to a registered `redirect_uri` with `error`
 *  - `interaction`  — a redirect somewhere else: the plugin wants the
 *                     user to do something (sign in again, pick an
 *                     account) before it will answer
 *  - `rejected`     — not a redirect at all; the plugin refused the
 *                     request outright
 */
type ProxyOutcome = "code" | "client_error" | "interaction" | "rejected";

// These are the query parameters this OAuth Provider implementation adds
// to a registered redirect URI. They are removed from both sides during
// callback matching: a client may already have one in its registered URI,
// and the provider replaces or appends the response value. Removing any
// other parameter would let a callback with missing or changed fixed
// registration data pass as the registered URI.
const OAUTH_RESPONSE_PARAMS = new Set([
  "code",
  "error",
  "error_description",
  "iss",
  "state",
]);

/**
 * Match a returned OAuth callback to a registered redirect URI while
 * ignoring only the response parameters the authorization server adds.
 *
 * `URL.origin` cannot represent native custom schemes (it is the literal
 * string `"null"` for all of them), so scheme, authority, and path are
 * compared directly. Fixed registered query parameters remain load-bearing:
 * both URLs must contain the same non-response key/value multiset after the
 * OAuth response fields are removed from each side.
 */
function isRegisteredResponseRedirect(
  registeredRedirectUris: readonly string[],
  candidate: string,
): boolean {
  return (
    findRegisteredResponseRedirect(registeredRedirectUris, candidate) !==
    undefined
  );
}

function findRegisteredResponseRedirect(
  registeredRedirectUris: readonly string[],
  candidate: string,
): URL | undefined {
  let returned: URL;
  try {
    returned = new URL(candidate);
  } catch {
    return undefined;
  }

  for (const entry of registeredRedirectUris) {
    let registered: URL;
    try {
      registered = new URL(entry);
    } catch {
      continue;
    }

    const loopback =
      registered.hostname === "127.0.0.1" ||
      registered.hostname === "::1" ||
      registered.hostname === "[::1]";
    if (
      registered.protocol !== returned.protocol ||
      registered.username !== returned.username ||
      registered.password !== returned.password ||
      registered.hostname !== returned.hostname ||
      (!loopback && registered.port !== returned.port) ||
      registered.pathname !== returned.pathname ||
      registered.hash !== returned.hash
    ) {
      continue;
    }

    const registeredQuery = [...registered.searchParams.entries()]
      .filter(([key]) => !OAUTH_RESPONSE_PARAMS.has(key))
      .sort(compareQueryEntry);
    const returnedQuery = [...returned.searchParams.entries()]
      .filter(([key]) => !OAUTH_RESPONSE_PARAMS.has(key))
      .sort(compareQueryEntry);
    if (queryEntriesEqual(registeredQuery, returnedQuery)) return registered;
  }
  return undefined;
}

function compareQueryEntry(
  a: readonly [string, string],
  b: readonly [string, string],
): number {
  return a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]);
}

function queryEntriesEqual(
  a: readonly (readonly [string, string])[],
  b: readonly (readonly [string, string])[],
): boolean {
  return (
    a.length === b.length &&
    a.every(([key, value], index) => {
      const other = b[index];
      return other?.[0] === key && other[1] === value;
    })
  );
}

/**
 * Did the provider add or replace a response parameter rather than merely
 * preserve a fixed value from the registered URI? This distinction matters
 * when, for example, an error callback retains a fixed `code` query pair:
 * that pair must not turn the error into a successful-code outcome.
 */
function hasAddedResponseParam(
  registered: URL,
  returned: URL,
  key: string,
): boolean {
  const registeredCounts = new Map<string, number>();
  for (const value of registered.searchParams.getAll(key)) {
    registeredCounts.set(value, (registeredCounts.get(value) ?? 0) + 1);
  }
  for (const value of returned.searchParams.getAll(key)) {
    const remaining = registeredCounts.get(value) ?? 0;
    if (remaining === 0) return true;
    registeredCounts.set(value, remaining - 1);
  }
  return false;
}

function classifyProxyOutcome(
  response: Response,
  requestedRedirectUri: string | null,
): ProxyOutcome {
  if (response.status !== 302) return "rejected";
  const location = response.headers.get("location");
  if (!location) return "rejected";
  let target: URL;
  try {
    target = new URL(location);
  } catch {
    // A relative Location is always an internal bounce, never a client
    // callback (registered redirect URIs are absolute).
    return "interaction";
  }
  const registered = requestedRedirectUri
    ? findRegisteredResponseRedirect([requestedRedirectUri], location)
    : undefined;
  if (!registered) {
    return "interaction";
  }
  if (hasAddedResponseParam(registered, target, "code")) return "code";
  if (hasAddedResponseParam(registered, target, "error")) {
    return "client_error";
  }
  return "interaction";
}

export const __test_internals = { isRegisteredResponseRedirect };

/**
 * Build the OIDC error redirect for a `prompt=none` request that cannot
 * be answered with a code: `redirect_uri?error=<code>&...`, with `state`
 * echoed when present (mirroring the plugin's own
 * `redirectWithPromptNoneError` shape).
 *
 * Reads only from the verified parameter set, so `redirect_uri` and
 * `state` are values the plugin signed rather than whatever the URL
 * happened to carry. Returns `null` when that `redirect_uri` isn't
 * registered for the client, so a hand-crafted target can never become an
 * open redirect — the registration check is the second fence beneath the
 * signature, not the only one.
 */
function buildPromptNoneErrorRedirect(
  registeredRedirectUris: readonly string[],
  signedParams: URLSearchParams,
  error: string,
  description: string,
): Response | null {
  const redirectUri = signedParams.get("redirect_uri");
  if (!redirectUri) return null;
  if (!isRegisteredRedirectUri(registeredRedirectUris, redirectUri)) {
    return null;
  }

  const params = new URLSearchParams({
    error,
    error_description: description,
  });
  const state = signedParams.get("state");
  if (state) params.append("state", state);
  const separator = redirectUri.includes("?") ? "&" : "?";
  return withNoStore(
    new Response(null, {
      status: 302,
      headers: { location: `${redirectUri}${separator}${params.toString()}` },
    }),
  );
}

/**
 * Put the user's standing grant back after a silent re-authorization
 * narrowed it.
 *
 * The OAuth Provider plugin rewrites `auth_oauth_consent.scopes` to the
 * requested set on every accept. That is right for the interactive path
 * — the user is looking at the checkboxes — but on the silent path
 * nobody agreed to anything: a client that asks for one scope this time
 * would shrink a three-scope grant it was given, with no interaction and
 * no way for the user to see it happen. The next request for the full
 * set would then re-prompt, and the projected `system.connection` row
 * (which the silent path leaves alone) would disagree with the consent
 * row in the meantime.
 *
 * So the standing grant wins: the code just minted carries only the
 * scopes the client asked for, and the record keeps the wider set the
 * user actually approved. Narrowing a grant stays a deliberate act,
 * available on the consent screen and on `/auth/security`.
 *
 * Awaited rather than fired and forgotten — the window where the stored
 * row disagrees with the projection should not outlive the request. A
 * failure logs and leaves the narrowed row; the alternative (failing the
 * authorization) would be worse for a user whose code is already minted.
 */
async function preserveBroaderGrant(
  storage: Storage,
  opts: {
    authUserId: string;
    clientId: string;
    priorScopes: readonly string[];
    requestedScopes: readonly string[];
  },
): Promise<void> {
  const requested = new Set(opts.requestedScopes);
  const narrowed = opts.priorScopes.some((s) => !requested.has(s));
  if (!narrowed) return;
  if (typeof storage.oauthProvider?.setConsentScopes !== "function") return;
  try {
    await storage.oauthProvider.setConsentScopes(
      opts.clientId,
      opts.authUserId,
      opts.priorScopes,
    );
  } catch (err) {
    log("warn", "consent skip: restoring the prior consent scopes failed", {
      client_id: opts.clientId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Emit the `auth.grant.reused` audit row for a silent re-authorization
 * (consent skipped because the prior grant already covers the request).
 * Distinct from `auth.grant.created` so the operator trail separates
 * "user clicked Approve" from "server reused an existing grant". The
 * lookups here are read-only — reuse never rewrites the projection.
 * Best-effort: a failure logs and never blocks the redirect.
 */
async function auditGrantReused(
  storage: Storage,
  opts: {
    authUserId: string;
    clientId: string;
    scopes: string[];
    clientIp: string | null;
  },
): Promise<void> {
  try {
    let tenantId: string | undefined;
    if (storage.users) {
      const userRow = await storage.users.getByAuthUserId(opts.authUserId);
      tenantId = userRow?.tenant_id ?? undefined;
    }
    let grantItemId: string | null = null;
    if (typeof storage.oauthProvider?.findGrantItemId === "function") {
      grantItemId = await storage.oauthProvider.findGrantItemId({
        tenantId: tenantId ?? null,
        clientId: opts.clientId,
        authUserId: opts.authUserId,
      });
    }
    await storage.audit.log({
      tenant_id: tenantId ?? null,
      action: "auth.grant.reused",
      resource_type: "oauth_grant",
      resource_id: opts.clientId,
      client_ip: opts.clientIp,
      details: {
        client_id: opts.clientId,
        user_id: opts.authUserId,
        scopes: opts.scopes,
        grant_item_id: grantItemId,
      },
    });
  } catch (err) {
    log("warn", "consent skip: auth.grant.reused audit emit failed", {
      client_id: opts.clientId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Write or refresh the `system.connection { kind: "app" }` projection for
 * an accepted code-flow consent. Mirrors what `createUserAppGrant` in
 * `routes/auth-pages.ts` does for the device-flow path. Emits
 * `auth.grant.created` audit row in both branches (creation + re-consent).
 *
 * Re-consent behavior: if a projection already exists for (tenant,
 * client, user), we update its `scopes` + `granted_at` in place rather
 * than creating a second row. The `audit.grant.created` row still emits
 * (a re-consent IS a grant event), with the existing `grant_item_id`
 * in details — operators auditing grant history see one row per consent
 * action, projection stays single-row per (tenant, client, user).
 */
async function projectGrantOnConsent(
  storage: Storage,
  opts: {
    authUserId: string;
    clientId: string;
    scopes: string[];
    clientIp: string | null;
  },
): Promise<void> {
  // Cycle metadata flows through `cycleRequestContext` (set by
  // `cycleMiddleware`) — `publish()` reads it automatically.
  let tenantId: string | undefined;
  if (storage.users) {
    const userRow = await storage.users.getByAuthUserId(opts.authUserId);
    tenantId = userRow?.tenant_id ?? undefined;
  }

  // Detect re-consent: update scopes in place if a projection exists,
  // insert on first consent. Either way the audit row and publish fire.
  let grantItemId: string | null = null;
  if (typeof storage.oauthProvider?.findGrantItemId === "function") {
    grantItemId = await storage.oauthProvider.findGrantItemId({
      tenantId: tenantId ?? null,
      clientId: opts.clientId,
      authUserId: opts.authUserId,
    });
  }

  const now = new Date().toISOString();
  let projectedItem: import("@withmarfa/shared").Item;
  let eventType: "created" | "updated";
  let priorScopes: string[] = [];

  if (grantItemId) {
    // Route the update through `storage.items.update` (not a raw SQL
    // patch) so it writes a versions snapshot, bumps updated_at + version,
    // and lets the row sort correctly under /items?sort=updated_at.
    // Pre-fetch to compute prior scopes for the narrowing check below.
    const existing = await storage.items.get(grantItemId, tenantId);
    if (existing) {
      priorScopes = Array.isArray(existing.properties.scopes)
        ? (existing.properties.scopes as string[])
        : [];
    }

    // If the new scope set is narrower than the prior set, revoke
    // existing access tokens — RPs must not continue calling narrowed-
    // away APIs. Refresh tokens are left intact; they mint at the
    // narrower scope on next refresh.
    //
    // Ahead of the record update, and fatal when it fails, because a
    // narrowing that cannot revoke is a narrowing that did not happen:
    // the tokens carrying the removed scopes stay valid for the rest of
    // their lifetime. Rewriting the record first would leave /auth/security
    // describing access the user no longer has while that access still
    // works. The caller turns this into a failed request rather than a
    // code-bearing redirect that claims otherwise.
    const newSet = new Set(opts.scopes);
    if (priorScopes.some((s) => !newSet.has(s))) {
      const provider = storage.oauthProvider;
      if (typeof provider?.revokeAccessTokensForGrant !== "function") {
        throw new NarrowingNotEnforced(
          new Error("storage cannot revoke access tokens for a grant"),
        );
      }
      try {
        await provider.revokeAccessTokensForGrant(
          opts.clientId,
          opts.authUserId,
        );
      } catch (err) {
        throw new NarrowingNotEnforced(err);
      }
    }

    // Reset status + clear revoked_at on re-consent. Without this a
    // re-consented row keeps status="revoked" — /security hides the grant
    // while the plugin issues tokens against it. Setting revoked_at:
    // undefined makes JSON.stringify drop the key from stored properties.
    const updated = await storage.items.update(
      grantItemId,
      {
        properties: {
          scopes: opts.scopes,
          status: "active",
          granted_at: now,
          revoked_at: undefined,
        },
      },
      tenantId,
    );
    if ("error" in updated) {
      // Unreachable: we don't pass `version`, so the merge path bypasses
      // conflict detection. Defensive.
      throw new Error(
        "projectGrantOnConsent: unexpected version conflict on re-consent",
      );
    }
    projectedItem = updated;
    eventType = "updated";
  } else {
    // First-time consent: insert a fresh row.
    const item = await storage.items.create(
      {
        type: "system.connection",
        tier: "library",
        state: "active",
        properties: {
          kind: "app",
          client_id: opts.clientId,
          user_id: opts.authUserId,
          scopes: opts.scopes,
          status: "active",
          granted_at: now,
        },
        source: "marfa/oauth2/consent",
      },
      tenantId,
    );
    grantItemId = item.id;
    projectedItem = item;
    eventType = "created";
  }

  // Fire-and-forget — a publish failure must not block consent.
  void publish({
    type: eventType,
    item: projectedItem,
    tenantId,
  });

  void storage.audit.log({
    tenant_id: tenantId ?? null,
    action: "auth.grant.created",
    resource_type: "oauth_grant",
    resource_id: opts.clientId,
    client_ip: opts.clientIp,
    details: {
      client_id: opts.clientId,
      user_id: opts.authUserId,
      scopes: opts.scopes,
      grant_item_id: grantItemId,
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up the full client row from the plugin's `auth_oauth_client` table.
 * Returns null when the row doesn't exist (callers 404). When the row
 * exists but `name` is null (a DCR client registered without `client_name`
 * per RFC 7591 §2), the caller falls back to displaying the `clientId`
 * rather than 404'ing a legitimate but unnamed client.
 */
async function resolveClient(
  storage: Storage,
  clientId: string,
): Promise<{
  name: string | null;
  isPublic: boolean;
  redirectUris: readonly string[];
} | null> {
  try {
    if (typeof storage.oauthProvider?.getClient === "function") {
      const row = await storage.oauthProvider.getClient(clientId);
      return row
        ? {
            name: row.name,
            isPublic: row.isPublic,
            redirectUris: row.redirectUris,
          }
        : null;
    }
    return null;
  } catch (err) {
    log("warn", "consent: resolveClient failed", {
      client_id: clientId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Look up the user's most recent prior consent for this (client_id, user_id)
 * combo from `auth_oauth_consent`. Returns the scope literals from that
 * row, or `undefined` if no prior grant exists.
 */
async function resolvePriorScopes(
  storage: Storage,
  clientId: string,
  authUserId: string,
): Promise<readonly string[] | undefined> {
  try {
    if (typeof storage.oauthProvider?.getPriorConsent === "function") {
      return await storage.oauthProvider.getPriorConsent(clientId, authUserId);
    }
    return undefined;
  } catch (err) {
    log("warn", "consent: resolvePriorScopes failed", {
      client_id: clientId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Built-in copy for the standard OIDC literals — the OIDC spec doesn't
 * carry plain-English descriptions, but the user needs to know what
 * they're approving. These strings are user-facing and intentionally
 * plain; mirror the language convention of the type-registry
 * descriptions.
 */
const OIDC_SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: "Confirm your identity.",
  profile: "See your name and profile picture.",
  email: "See your email address.",
  offline_access: "Stay signed in even when you're not using the app.",
};

/**
 * User-facing copy for the consent screen, keyed by type id (core
 * types, system types) or edge type id. Intentionally separate from
 * the type registry's `description` field — those are written for
 * developers (reference notes, schema rationale, internal dev notes,
 * etc.) and read fine in API docs but land poorly on a consent screen. Keep these short, plain, second-person, and
 * one line each.
 *
 * Missing entries fall back to the type registry's `description` —
 * which is correct behavior for custom types registered at runtime
 * via `POST /types`, where the operator controls the copy. For core
 * + system types every entry is curated below so the registry copy
 * never reaches the screen.
 */
const CONSENT_TYPE_DESCRIPTIONS: Record<string, string> = {
  // Core content
  "core.note": "Your notes.",
  "core.task": "Your tasks and to-dos.",
  "core.bookmark": "Bookmarks and saved links.",
  "core.highlight": "Highlights and excerpts.",
  "core.event": "Calendar events.",
  "core.message": "Messages and conversations.",

  // Entities
  "core.entity": "Organizations and other entities.",
  "core.entity.person": "People in your contacts.",
  "core.entity.place": "Places and venues.",

  // Files
  "core.file": "Files.",
  "core.file.audio": "Audio files and recordings.",
  "core.file.image": "Photos and images.",
  "core.file.video": "Videos.",

  // Media
  "core.media": "Media — books, films, music, podcasts.",
  "core.media.album": "Music albums.",
  "core.media.article": "Articles.",
  "core.media.book": "Books.",
  "core.media.film": "Films.",
  "core.media.podcast": "Podcasts.",
  "core.media.series": "TV series.",
  "core.media.song": "Songs.",
  "core.media.tv_episode": "TV episodes.",

  // System
  "system.activity": "Background activity and notifications.",
  "system.app": "Connected apps.",
  "system.connection": "Connections to other apps and services.",
  "system.credential": "API keys and credentials.",
  "system.device": "Devices signed in to your account.",
  "system.integration": "Available integrations.",
  "system.webhook": "Webhook subscriptions.",

  // Edge types — relationships between items.
  about: "Links between items and what they're about.",
  "parent-of": "Parent and child relationships.",
  "in-thread": "Items grouped into threads.",
  "attached-to": "File attachments on items.",
  references: "References between items.",
  "authored-by": "Authorship — who created what.",
  "derived-from": "Items derived from other items.",
  supersedes: "Updates and replacements between items.",
};

/**
 * Build the `{ typePattern: description }` map the renderer uses for
 * the plain-English hint per scope row. Sources by kind:
 *
 *  - **Type** scopes → `TYPE_REGISTRY.get(typeId)?.description`
 *  - **Edge** scopes → `EDGE_TYPE_REGISTRY.get(edgeType)?.description`
 *  - **OIDC** scopes → `OIDC_SCOPE_DESCRIPTIONS` built-in map
 *  - **Metadata** scopes → skipped (operator-tooling scopes; the literal
 *    `metadata:read` etc. is self-explanatory to the audience that
 *    requests them)
 *
 * Missing entries fall through — the renderer shows just the literal.
 */
export function buildScopeDescriptions(
  scopes: ParsedScope[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of scopes) {
    if (s.kind === "oidc") {
      const literal = s.oidcScope ?? s.typePattern;
      const copy = OIDC_SCOPE_DESCRIPTIONS[literal];
      if (copy) out[s.typePattern] = copy;
      continue;
    }
    if (s.kind === "edge") {
      // `edgeType` is optional on ParsedScope but always present when
      // kind === "edge"; guard for the type-checker.
      const edgeType = s.edgeType;
      if (edgeType) {
        // Curated user-facing copy wins. Falls back to the registry's
        // engineering description for any edge type without a curated
        // entry (custom edge types registered at runtime).
        const curated = CONSENT_TYPE_DESCRIPTIONS[edgeType];
        if (curated) {
          out[s.typePattern] = curated;
        } else {
          const edgeSchema = EDGE_TYPE_REGISTRY.get(edgeType);
          if (edgeSchema?.description) {
            out[s.typePattern] = edgeSchema.description;
          }
        }
      }
      continue;
    }
    if (s.kind === "metadata") continue;
    const curated = CONSENT_TYPE_DESCRIPTIONS[s.typePattern];
    if (curated) {
      out[s.typePattern] = curated;
      continue;
    }
    const schema = TYPE_REGISTRY.get(s.typePattern);
    if (schema?.description) {
      out[s.typePattern] = schema.description;
    }
  }
  return out;
}

/**
 * Map the `?error=...` query param (set when GET /authorize is reached
 * via a redirect from a failed decision attempt) to a user-facing
 * sentence. Unknown error codes return undefined → no banner shown.
 */
function translateConsentError(code: string): string | undefined {
  if (code === "no_scopes_selected") {
    return "Approve needs at least one permission ticked. Tick what you'd like to grant, or click Deny to cancel.";
  }
  return undefined;
}
