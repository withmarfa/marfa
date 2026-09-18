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
 *     can POST it back unchanged to `/auth/authorize/decision`, which
 *     forwards it to the plugin in-process (the plugin re-verifies the
 *     sig; its wire endpoint is fenced). Marfa's own display-only
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
 *
 * Undoing that narrowing is a read-then-write across a proxy round trip,
 * so it runs under `withConsentLock` for the (client, user) pair and the
 * write itself carries the value it expects to find. Both exist for one
 * reason: an act that genuinely does withdraw permission — a narrowing on
 * the consent screen, a revoke from `/auth/security` — must never be
 * undone by a restoration computed before the user performed it. See
 * `auth/consent-lock.ts` for what each of the two fences covers.
 */

import { Hono } from "hono";
import { makeSignature, constantTimeEqual } from "better-auth/crypto";
import type { ParsedScope, PermissionBundle } from "@withmarfa/shared";
import {
  parseScope,
  isValidScope,
  isReservedRoot,
  grantCoversScope,
  subtreeWildcardRoot,
  GLOBAL_TYPE_WILDCARD,
  TYPE_REGISTRY,
  EDGE_TYPE_REGISTRY,
} from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { MarfaAuth } from "../auth/instance.js";
import { getPermissionBundles } from "../config.js";
import { renderConsentScreen } from "./consent.js";
import { deriveWildcardDescription } from "./wildcard-copy.js";
import { renderAuthorizeExpiredPage } from "./authorize-expired-page.js";
import type { AuthorizeFailure } from "./authorize-expired-page.js";
import { setNoStore, withNoStore } from "./no-store.js";
import { forwardHeaders } from "./forward-headers.js";
import { withConsentLock } from "../auth/consent-lock.js";
import { auditGrantReused } from "../auth/grant-lifecycle.js";
import { buildAllowedOrigins, isCrossOriginPost } from "./_space-caller.js";
import {
  findRegisteredResponseRedirect,
  hasAddedResponseParam,
  isRegisteredResponseRedirect,
} from "../auth/redirect-params.js";
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

/**
 * Outcome of the consent-skip critical section: either the request falls
 * through to the consent screen, or the accept was proxied and the
 * plugin's response is waiting to be classified.
 */
type ConsentSkipAttempt =
  | { skipped: false; priorScopes: readonly string[] | undefined }
  | {
      skipped: true;
      priorScopes: readonly string[] | undefined;
      proxyResp: Response;
    };

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
export function authConsentRoutes(deps: ConsentRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Origin allowlist for the consent decision CSRF guard: every operator
  // CORS origin plus the auth issuer's own origin (a same-origin POST from
  // the rendered consent page). Built once at construction.
  const allowedOrigins = buildAllowedOrigins(
    deps.corsOrigins,
    deps.authBaseUrl,
  );

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
    //
    // What it does render is a page built entirely from fixed copy, with
    // nothing from the query on it. The signed window is ten minutes from
    // the plugin's first authorize hit and has to cover the whole
    // authentication journey — a magic link, or a sign-up with an email
    // verification hop, routinely outruns it — so an honest user reaching
    // this is ordinary, and a raw 400 would leave them stranded on a
    // developer's error message with nothing to do next.
    const getVerdict = await verifySignedQuery(auth, oauthQuery);
    if (getVerdict !== "valid") {
      setNoStore(c);
      return c.html(renderAuthorizeExpiredPage(failureCopy(getVerdict)), 400);
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
    // **Not a door onto the allowlist, and enumerated here because it looks
    // like one.** `isValidScope` alone is the right filter at this site: it
    // refuses invalid grammar with a 400 and admits nothing to a stored
    // ceiling. Everything it passes is re-validated by the plugin against the
    // client's registered row, so a withheld literal arriving here is refused
    // one step later rather than published. The three sites that DO write are
    // `buildAllowedScopes`, `bundlePublishedScopes` and the self-serve key
    // mint, and all three consult `isWithheldFromAllowlist`.
    // Deduplicated, order preserved. A client may name the same literal
    // twice and nothing upstream stops it, which produced two identical
    // toggles carrying one checkbox value: unticking the row in front of you
    // reliably did nothing, because the decision handler takes the union of
    // what was submitted. The device screen has always deduplicated, so one
    // request rendered coherently on one surface and incoherently on the
    // other.
    //
    // Done here rather than only at the render because the duplicate did not
    // stop at the screen. It survived into `formScopes`, through
    // `projectGrantOnConsent`, and was written verbatim into
    // `properties.scopes` on the `system.connection` item, where every
    // surface that later reads or diffs that list inherited it.
    const scopeLiterals = [...new Set(scopeParam.split(/\s+/).filter(Boolean))];
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
    //
    // Reading the standing grant, letting the plugin narrow it, and
    // putting it back is one operation on one record, so it runs under
    // the consent lock for this (client, user). Split apart, a narrowing
    // or a revocation the user performs while the proxy is in flight is
    // overwritten by a restoration computed before they performed it.
    // The lookup is inside the lock rather than before it for the same
    // reason: a value read outside is already potentially stale by the
    // time the decision is acted on.
    const attempt = await withConsentLock(
      clientId,
      session.user.id,
      async (): Promise<ConsentSkipAttempt> => {
        // Doubles as the renderer's re-consent diff input when the skip
        // does not apply: prior consent for (client_id, user_id) in
        // auth_oauth_consent, which the renderer shows as a diff
        // (added/kept/removed), or flat when there is none.
        const priorScopes = await resolvePriorScopes(
          deps.storage,
          clientId,
          session.user.id,
        );
        // Coverage, not membership. A standing grant of `core.*:read`
        // genuinely answers a later request for `core.note:read`, and the
        // set test this replaced said otherwise — so a person who had
        // granted everything was asked again the first time a client named
        // a type under it.
        //
        // This is now the more permissive of the two skips on the platform,
        // and deliberately. The vendored provider has its own
        // already-consented check and it is exact membership, so a request
        // this route waves through would be re-prompted had it reached
        // `/oauth2/authorize` directly. Nothing depends on the two agreeing:
        // the provider's runs on a path Marfa's `consentPage` config
        // redirects away from, and the direction of the difference is a
        // screen shown rather than a screen skipped. Worth knowing before
        // reading a re-prompt on one surface as a bug on the other.
        const alreadyGranted =
          priorScopes !== undefined &&
          scopeLiterals.length > 0 &&
          scopeLiterals.every((literal) =>
            grantCoversScope(priorScopes, literal),
          );
        if (promptSet.has("consent") || !alreadyGranted) {
          return { skipped: false, priorScopes };
        }

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
        // No `?? []` here: reaching this line means `alreadyGranted` held,
        // and that now tests `priorScopes` itself rather than a `Set` built
        // from it, so the compiler carries the narrowing all the way down.
        await preserveBroaderGrant(deps.storage, {
          authUserId: session.user.id,
          clientId,
          priorScopes,
          requestedScopes: scopeLiterals,
        });
        return { skipped: true, priorScopes, proxyResp };
      },
    );
    const priorScopes = attempt.priorScopes;

    if (attempt.skipped) {
      const proxyResp = attempt.proxyResp;
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

    // The plain-English line per scope row, from the one source the device
    // approval screen reads too.
    const descriptions = buildScopeDescriptions(parsed);
    const wildcardExpansions = await resolveWildcardExpansions(
      deps.storage,
      parsed,
    );
    const bundles = resolveConsentBundles();

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
      wildcardExpansions,
      priorScopes,
      errorMessage,
      bundles,
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
    if (isCrossOriginPost(c.req.raw.headers, allowedOrigins)) {
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
    //
    // The same page as the GET path, for the same reason: this POST is a
    // form submit from a browser, and the likeliest way to reach it is a
    // user who read the consent screen for longer than the signed window
    // lasts.
    const decisionVerdict = await verifySignedQuery(deps.auth, oauthQuery);
    if (decisionVerdict !== "valid") {
      setNoStore(c);
      return c.html(
        renderAuthorizeExpiredPage(failureCopy(decisionVerdict)),
        400,
      );
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
    //
    // Deduplicated, and this is a second source rather than the same one
    // twice. The render now emits one row per literal, so an honest browser
    // cannot submit a duplicate — but this is a form, and `getAll` returns
    // whatever was posted. A hand-crafted POST naming one literal twice
    // passes the membership test on both copies, because `signedScopes` is a
    // `Set`, and writes the duplicate into the stored grant no matter what
    // the screen rendered.
    const formScopes = [
      ...new Set(
        form
          .getAll("scopes")
          .filter((v): v is string => typeof v === "string")
          .filter((s) => signedScopes.has(s)),
      ),
    ];

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
    const auth = deps.auth;

    // The proxy and the record it produces are one operation on the same
    // (client, user) grant the silent path also writes, so they share its
    // lock. Without it a decision landing mid-skip is undone by the
    // skip's restoration, which was computed before the user made it.
    return await withConsentLock(
      clientId,
      session.user.id,
      async (): Promise<Response> => {
        // Forward to the plugin's /oauth2/consent endpoint and hand the
        // (normalized) result to the browser. Shared with the GET
        // handler's consent-skip path.
        const proxyResp = await proxyConsentDecision(
          auth,
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

        // A valid signed query is necessary but not sufficient: the plugin
        // can still refuse a disabled client, an invalid redirect, or a
        // flow that requires fresh interaction. Projection, audit, and
        // narrowing-token revocation are consent-success side effects, so
        // none may happen until a code actually reaches the client's
        // registered callback.
        //
        // Either way the response is stamped no-store on its way out. The
        // accepted one carries a single-use code in its `Location`, which
        // is reason enough on its own; the refused one is stamped for the
        // same reason every other auth surface is, and stamping one exit
        // and not the other is how the exception gets missed.
        if (
          !accept ||
          classifyProxyOutcome(proxyResp, requestedRedirectUri) !== "code"
        ) {
          return withNoStore(proxyResp);
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
            // Narrowing a grant is a promise that the access it removes
            // stops working. Tokens already issued at the wider scope
            // outlive the consent row, so if they cannot be revoked the
            // promise is not kept — and handing back the code-bearing
            // redirect would tell the user it was. Fail loudly instead:
            // the record still describes the wider grant the tokens
            // actually carry, which is at least true.
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

        return withNoStore(proxyResp);
      },
    );
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
 * Verdict on an authorize query's signature.
 *
 * `expired` and `unsigned` both end the request the same way and get the
 * same page — the user's only move either way is to start again at the
 * app, and telling them which it was would be no help to them and a hint
 * to anyone probing. The split exists for the operator: a request that
 * timed out is routine traffic, one nobody signed is somebody building a
 * consent screen, and a log that couldn't tell them apart would bury the
 * second in the first.
 */
type SignedQueryVerdict = "valid" | "expired" | "unsigned";

/**
 * Which failure screen a non-valid verdict earns.
 *
 * `unsigned` covers a signature that did not match, a missing one, and an
 * `exp` that never parsed. None of those is a timeout, and calling them one
 * sends an honest user hunting for a clock problem while an operator reads
 * routine traffic where there is a forged request. The user-facing wording
 * lives with the page.
 */
function failureCopy(
  verdict: Exclude<SignedQueryVerdict, "valid">,
): AuthorizeFailure {
  return verdict === "expired" ? "expired" : "unverifiable";
}

/**
 * Order a parameter set the way the OAuth Provider plugin orders it
 * before signing, so a signature computed here matches one computed
 * there.
 *
 * The plugin canonicalizes because anything between it and the browser —
 * a CDN, a proxy — is free to reorder query parameters in transit, and a
 * signature taken over the arrival order breaks whenever one does. Sort
 * is by key, then by value, so the parameters the plugin repeats still
 * land in a stable sequence.
 */
function canonicalizeOAuthQueryParams(
  params: URLSearchParams,
): URLSearchParams {
  const canonical = new URLSearchParams();
  const entries = [...params.entries()].sort(
    ([keyA, valueA], [keyB, valueB]) => {
      if (keyA < keyB) return -1;
      if (keyA > keyB) return 1;
      if (valueA < valueB) return -1;
      if (valueA > valueB) return 1;
      return 0;
    },
  );
  for (const [key, value] of entries) canonical.append(key, value);
  return canonical;
}

/**
 * Is this authorize query one the OAuth Provider plugin actually signed,
 * and still inside its validity window?
 *
 * Mirrors the plugin's own `verifyOAuthQueryParams`: reject anything
 * carrying other than exactly one `sig`, strip it, canonicalize what
 * remains, re-sign with the instance's signing secret, compare in
 * constant time, and reject anything past `exp`. The plugin's copy is
 * internal to the package, so this is a deliberate re-implementation
 * against the same public primitives (`makeSignature` from
 * `better-auth/crypto`) and the same secret the instance signs with —
 * `MarfaAuth.signingSecret` exists so there is one resolved value rather
 * than a verifier guessing at what the signer used.
 *
 * Being a re-implementation, it has to move when the plugin's signing
 * scheme moves: the canonicalization below tracks the plugin's fix for
 * proxy parameter reordering, and a mismatch makes every genuinely signed
 * query read as forged. The consent round trip in the
 * route tests is what pins the two together.
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
): Promise<SignedQueryVerdict> {
  try {
    const params = new URLSearchParams(oauthQuery);
    // Exactly one `sig`, never several. The plugin emits one; accepting a
    // set and testing a single member of it would let a caller keep a
    // valid signature alongside the parameters it does not cover.
    const sigs = params.getAll("sig");
    if (sigs.length !== 1) return "unsigned";
    const sig = sigs[0];
    if (!sig) return "unsigned";
    const expSeconds = Number(params.get("exp"));
    // A missing or unparseable `exp` is not a request that timed out. The
    // plugin always signs one, so its absence means the parameter set
    // never came from the plugin at all.
    if (!Number.isFinite(expSeconds)) return "unsigned";
    if (expSeconds * 1000 < Date.now()) return "expired";
    params.delete("sig");
    const expected = await makeSignature(
      canonicalizeOAuthQueryParams(params).toString(),
      auth.signingSecret,
    );
    if (constantTimeEqual(sig, expected)) return "valid";
    log(
      "warn",
      "consent: authorize request carries a signature we did not make",
    );
    return "unsigned";
  } catch (err) {
    log("warn", "consent: signed-query verification failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "unsigned";
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

export const __test_internals = {
  isRegisteredResponseRedirect,
  // Shared with the tests that mint their own signed queries, so a signer
  // and its verifier can never disagree about parameter order. The tests
  // that drive the real plugin flow are what pin this to the plugin.
  canonicalizeOAuthQueryParams,
};

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
 *
 * `priorScopes` was read before the plugin ran, so the restoration is
 * only correct while nothing else has touched the grant since. Passing
 * `requestedScopes` as the expected current value is what makes that
 * conditional: the store refuses to write unless the row still holds
 * exactly what the plugin was told to put there, so a narrowing or a
 * revocation that landed in between is left alone rather than undone by
 * a set the user has already moved past.
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
  // Literal, deliberately, and the one comparison on this path that stays
  // that way.
  //
  // The others ask a permission question — is the app reaching anything new,
  // is the user giving anything up — and a permission question has to
  // understand that `core.*:read` covers `core.note:read`. This one asks
  // whether the plugin's rewrite changed the ARRAY, because what it restores
  // is the record of what the user approved, verbatim. Coverage here would
  // decline to restore whenever the narrowed row granted the same access by
  // fewer literals, and the record would quietly lose a scope the user
  // ticked, with nobody having asked for that. Same access, different
  // record, and the record is the thing this function exists to keep.
  const requested = new Set(opts.requestedScopes);
  const narrowed = opts.priorScopes.some((s) => !requested.has(s));
  if (!narrowed) return;
  if (typeof storage.oauthProvider?.setConsentScopes !== "function") return;
  try {
    const restored = await storage.oauthProvider.setConsentScopes(
      opts.clientId,
      opts.authUserId,
      opts.priorScopes,
      opts.requestedScopes,
    );
    if (!restored) {
      log("info", "consent skip: standing grant changed, restore declined", {
        client_id: opts.clientId,
      });
    }
  } catch (err) {
    log("warn", "consent skip: restoring the prior consent scopes failed", {
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
 * Re-consent behavior: if a projection already exists for (space,
 * client, user), we update its `scopes` + `granted_at` in place rather
 * than creating a second row. The `audit.grant.created` row still emits
 * (a re-consent IS a grant event), with the existing `grant_item_id`
 * in details — operators auditing grant history see one row per consent
 * action, projection stays single-row per (space, client, user).
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
  // Detect re-consent: update scopes in place if a projection exists,
  // insert on first consent. Either way the audit row and publish fire.
  let grantItemId: string | null = null;
  if (typeof storage.oauthProvider?.findGrantItemId === "function") {
    grantItemId = await storage.oauthProvider.findGrantItemId({
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
    const existing = await storage.items.get(grantItemId);
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
    // Coverage, and this is the site where getting it wrong is
    // destructive rather than annoying: a widening misread as a narrowing
    // revokes every live access token the client holds. `core.note:read`
    // is not lost when the new grant says `core.*:read`.
    //
    // That a narrowing can happen here at all is what separates this
    // surface from the device one, and the pair is worth stating in both
    // places. This screen offers per-scope toggles: a set arriving smaller
    // than the standing grant is the user having unticked something, so it
    // is honored, and honoring it means the tokens carrying the removed
    // scopes have to stop working.
    //
    // **The device screen offers toggles too, and still merges rather than
    // narrowing.** It once had none, which is where this contrast came from,
    // and the difference is deliberate rather than a leftover — a set
    // arriving smaller there may be the client asking for less or the person
    // unticking a row, and nothing at that call site can tell the two apart.
    // What the untick reaches there is the token that device is issued: the
    // code is narrowed to the ticked set before the plugin approves it.
    // Neither surface narrows without the user having asked, and neither
    // leaves a record claiming access the user withdrew.
    if (priorScopes.some((s) => !grantCoversScope(opts.scopes, s))) {
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
    //
    // This writes one of the two lifecycle axes and never the other, which
    // is safe only because `findGrantItemId` refuses a row whose `state` is
    // not active: the row reaching here is already listed by both read
    // surfaces on that axis, so flipping `status` back makes it coherent
    // rather than reactivating something nobody can see. A soft-deleted
    // grant does not resolve at all and the branch below inserts a fresh
    // row instead.
    const updated = await storage.items.update(grantItemId, {
      properties: {
        scopes: opts.scopes,
        status: "active",
        granted_at: now,
        revoked_at: undefined,
      },
    });
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
    const item = await storage.items.create({
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
    });
    grantItemId = item.id;
    projectedItem = item;
    eventType = "created";
  }

  // Fire-and-forget — a publish failure must not block consent.
  void publish({
    type: eventType,
    item: projectedItem,
  });

  void storage.audit.log({
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
 * User-facing copy for the consent surfaces, keyed by the `typePattern` a
 * scope parses to: a type id, a wildcard pattern, an `edge.<type>` pattern,
 * or a metadata sub-resource path. Intentionally separate from the type
 * registry's `description` field. Those are written for developers
 * (reference notes, schema rationale, internal dev notes, etc.) and read
 * fine in API docs but land poorly on a consent screen. Keep these short,
 * plain, second-person, and one line each.
 *
 * Missing entries fall back to a registry `description` where a registry has
 * one. **That fallback has never served a type registered at runtime, and
 * the claim that it did stood here while sixteen shipped types were the only
 * population reaching it.** `POST /types` writes to a per-space overlay, and
 * neither `TYPE_REGISTRY` nor `EDGE_TYPE_REGISTRY` exposes one — so a custom
 * type cannot reach either lookup. It does not reach a row of its own
 * either: `buildAllowedScopes` enumerates registry keys for the concrete
 * scopes, so a space's own type is requestable only through its namespace
 * wildcard, which is curated.
 *
 * What the type fallback does reach is a platform row this build no longer
 * ships. `seedPlatformTypes` refills the registry at boot from the rows the
 * instance holds, so an instance carrying a retired type resolves it here
 * and no curated entry can exist for it — the build that shipped it is
 * gone. That is the whole of the population, and it is why the fallback
 * stays.
 *
 * The edge registry has no seed path at all, so its fallback reaches
 * nothing while every shipped edge type stays curated. Both halves are
 * held to that by a test, against `TYPE_REGISTRY` and `EDGE_TYPE_REGISTRY`
 * rather than against a list kept beside them.
 *
 * Both halves of that sentence are held against `TYPE_REGISTRY` and
 * `EDGE_TYPE_REGISTRY` rather than against a list kept beside them, because
 * the edge half was false while the sentence already claimed it.
 * `in-collection` shipped with no entry here, and the paragraph of schema
 * rationale it fell through to reached a device approval screen as a row.
 *
 * **Keyed uniformly on `typePattern`, which is what makes one flat map
 * across four kinds sound.** `typePattern` carries a different namespace per
 * kind, so a single map is only safe if no two kinds can produce the same
 * string, and none can: `parseScope` claims `metadata`, `edge.` and
 * `space.` ahead of the item-type matcher, `space` is a reserved
 * root whose non-members it refuses outright, and the four OIDC literals are
 * bare single words that `isValidTypePattern` rejects, a type identifier
 * needing two segments.
 *
 * The uniformity is load-bearing rather than tidy. The edge entries were
 * keyed on the bare edge type id while every other entry was keyed on the
 * pattern, and a bare edge type id shares its namespace with everything: an
 * edge type may be named `metadata`, and `edge.*` is a literal the scope
 * allowlist publishes as requestable. Both would have read another kind's
 * copy off this map the moment the wildcard and metadata entries landed in
 * it, and a consent screen telling someone that one relation is "Everything
 * in your space" is a worse failure than the blank row it replaced.
 *
 * Exported for the guard that walks `src` looking for a second statement of
 * this copy. The guard derives its search keys from the map itself rather
 * than from a list beside it, because a hand-kept list of the same strings is
 * the exact failure it exists to catch.
 */
export const CONSENT_SCOPE_DESCRIPTIONS: Record<string, string> = {
  // **The possessive is dropped from the name of a content type, and kept
  // where it locates or distinguishes.** Every type on this screen is equally
  // the reader's, so "Your notes" beside "Bookmarks and saved links" invited
  // them to look for a difference that was not there, which is the whole of
  // what the word was doing. Dropped, the entries read as one list.
  //
  // It stays in two places, and both carry information a reader would lose:
  // "in your space" and "about your account" say where the grant reaches, and
  // `user.*` is "Your custom types" precisely because `app.*` immediately
  // below it is the app's. Neither is decoration.
  //
  // Core content
  "core.note": "Notes.",
  "core.task": "Tasks and to-dos.",
  "core.bookmark": "Bookmarks and saved links.",
  "core.highlight": "Highlights and excerpts.",
  "core.event": "Calendar events.",
  "core.message": "Messages and conversations.",

  // Entities
  //
  // `core.entity` names the same grant here that its toggle label names on
  // the authorize screen, and "and other entities" was the half that did
  // not. It reached wider than the label without saying how much wider, so
  // one grant read two ways depending on which screen a person was looking
  // at, and the narrower reading was the one above the toggles. The registry
  // lists a company, a band, a team, a charity, a brand and a school. Three
  // are named below and the rest sit under "organizations", a brand
  // excepted, so the sentence lands where the label does instead of past it.
  // The reasoning for keeping "Organizations" as that label and for
  // accepting the brand as residue is at `SCOPE_LABELS`.
  "core.entity": "Companies, teams, schools, and other organizations.",
  "core.entity.person": "People in your contacts.",
  "core.entity.place": "Places and venues.",

  // Files
  "core.file": "Files.",
  "core.file.audio": "Audio files and recordings.",
  "core.file.image": "Photos and images.",
  "core.file.video": "Videos.",

  // Media
  //
  // The same defect `core.entity` carried, on the surface that has no second
  // line to soften it. "Media: books, films, music, podcasts." named four
  // kinds a bare `core.media` grant reaches none of: the registry holds
  // seven subtypes, each separately requestable with a scope of its own, and
  // `grantCoversScope` answers false for every one of them. So the device
  // screen, which prints this sentence and nothing else, described the grant
  // by listing what it does not include.
  //
  // The replacement says what the grant does reach, which is media stored as
  // `core.media` itself. It is deliberately awkward rather than vague: a
  // sentence like "Media content" could not be checked against anything and
  // so could never be found wrong again, which is a worse place to end up
  // than the wrong list. This one is checkable against the registry, and it
  // stays true when an eighth subtype is registered, because it names the
  // relationship instead of the members.
  //
  // It also names no subtype, not even in the negative. "Media that is not a
  // book or a film" would be true and would still put those words on the row
  // of a grant that does not reach them, which is the thing the coverage
  // guard reads for. The guard cannot see polarity and teaching it to would
  // mean parsing negation, so the sentence stays positive.
  "core.media": "Media saved without a more specific type.",
  "core.media.album": "Music albums.",
  "core.media.article": "Articles.",
  "core.media.book": "Books.",
  "core.media.episode": "Episodes of a series.",
  "core.media.film": "Films.",
  "core.media.series": "Ongoing series.",
  "core.media.song": "Songs.",

  // Integration types: the sixteen this build ships through a connected
  // service.
  //
  // These reached a person as the type registry's `description` until now,
  // which is the only population that fallback ever served. Those are
  // written for a developer reading API docs — 170 to 796 characters,
  // backticks, field names, and in the worst case an argument about why
  // `priority` is an integer here and an enum on `core.task`. A screen
  // deciding whether to trust an application is the wrong place for it.
  //
  // **Each says where the data comes from, because the label already says
  // what it is.** Every one of these has a curated entry in `SCOPE_LABELS`
  // naming the service and the noun ("Todoist tasks"), so a sentence
  // restating that spends the row on nothing. What a person cannot get from
  // the label is which of their things the grant reaches — the calendars
  // they own, the videos they liked — and that is what these answer.
  //
  // Held to the rest of the map's rules: a noun phrase rather than an act,
  // no futurity clause, and the possessive kept only where it locates.
  "google.calendar.event": "Events on your Google Calendars.",
  "google.contacts.contact": "People in your Google Contacts.",
  "google.drive.file": "Files in your Google Drive.",
  "google.tasks.task": "Tasks on your Google Tasks lists.",
  "google.youtube.channel":
    "YouTube channels you subscribe to, and the ones behind videos you like.",
  "google.youtube.playlist": "YouTube playlists you make.",
  "google.youtube.video":
    "YouTube videos you like, and the ones in your playlists.",
  "marfa.captured_email":
    "Emails sent to the address that captures mail into your space.",
  "marfa.podcast.episode": "Episodes of the podcasts you follow.",
  "marfa.podcast.show": "Podcasts you follow.",
  "raindrop.collection":
    "The collections your Raindrop bookmarks are filed in.",
  "raindrop.raindrop": "Bookmarks you save to Raindrop.",
  "readwise.book":
    "The books, articles, and podcasts your Readwise highlights come from.",
  "readwise.document":
    "Articles and documents in your Readwise Reader library.",
  // "with any notes you add" was the first draft and the futurity guard
  // refused it: its vocabulary cannot tell a verb meaning "annotate" from
  // one meaning "later", which is the same limit that keeps every futurity
  // clause out of this map and composed by the renderers instead.
  "readwise.highlight":
    "Passages you highlight in Readwise, and the notes you write on them.",
  "todoist.task": "Tasks on your Todoist projects.",

  // System
  "system.account_holder": "The entry that represents you in your space.",
  "system.activity": "Background activity and notifications.",
  "system.app": "Connected apps.",
  "system.connection": "Connections to other apps and services.",
  "system.credential": "Keys that give access to your space.",
  "system.device": "Devices signed in to your account.",
  "system.integration": "Available integrations.",
  "system.webhook": "Webhook subscriptions.",

  // Edge types: relationships between items.
  //
  // One shape, and it is a question about the reader's own data rather than a
  // noun for the relation. These entries previously carried three: a
  // relationship noun ("Parent and child relationships."), a description of
  // what the platform does with it ("Items grouped into threads."), and an
  // abstract restatement of the identifier ("References between items.",
  // "Items derived from other items."). The third shape is the one that
  // earns nothing: a space owner reading it has been told the type id back,
  // spelled differently, and the row above already said that.
  //
  // So each of these answers which of the person's things the relation joins,
  // in the words they would use for it. That rule is checkable against a new
  // entry, where "share a shape" was not.
  "edge.about": "What an item is about.",
  "edge.parent-of": "Which items sit inside others.",
  "edge.in-thread": "Which thread an item belongs to.",
  "edge.in-collection": "Which collection an item belongs to.",
  "edge.attached-to": "Which item a file is attached to.",
  "edge.references": "Which items point to others.",
  "edge.authored-by": "Who made an item.",
  "edge.derived-from": "Which item another came from.",
  "edge.supersedes": "Which item replaces another.",

  // Metadata layer: sub-resources rather than item types, so no registry
  // holds a description to fall back to and this is the only source.
  //
  // Phrased as things rather than as acts, because one entry serves both
  // operations. `typePattern` carries no verb, so `metadata.types:read` and
  // `metadata.types:write` read the same line, and a line saying "register
  // and update" told somebody approving a read that they were granting a
  // write. The read/write split is already carried by the screen's own
  // grouping and by the toggle the row sits on.
  // Category 2, Your profile. The possessive stays throughout this block
  // under the rule the map's header states: it distinguishes rather than
  // decorates, because an app's own name and the person's are both nameable
  // on this screen and the reader has to be able to tell them apart.
  //
  // None of these states that the parent reaches rows added later — that is
  // composed from `isOpenEnded`, which answers true for the bare `profile`
  // form and false for a row, exactly as it does for a wildcard.
  profile: "Your name, email address, avatar, username, bio and timezone.",
  "profile.name": "Your name.",
  "profile.email": "Your email address.",
  "profile.avatar": "Your avatar.",

  metadata: "Custom data types and relationship types.",
  "metadata.types": "Custom data types in your space.",
  "metadata.edge_types": "Custom relationship types in your space.",

  // Wildcards: the one family where curated copy is not merely better than
  // the registry's but is the only thing that can exist. A wildcard matches
  // types at check time and the grant reaches types nobody has registered
  // yet, so what the copy has to say is precisely what no registry entry
  // knows.
  //
  // **None of these sentences says that the grant reaches types nobody has
  // registered yet, and none of them may.** Both screens compose that from
  // the grammar: `subRow` puts `OPEN_ENDED_LINE` on the toggle row's second
  // line, `describeScope` appends `OPEN_ENDED_SENTENCE` to whichever
  // of these it is about to print, and `isOpenEnded` is the single answer
  // both read. So an entry here says what the grant reaches and stops.
  //
  // **The prohibition is not tidiness, it is the only way the two screens
  // can be made to agree.** These sentences used to carry a futurity clause,
  // because the device screen has no second line, so the description is the
  // whole of what it says about a grant. But `scopeName` on the
  // authorize screen falls through to this map wherever nothing curated
  // names the pattern, so the clause written for one screen arrived as the
  // other screen's toggle label, directly above a line about to state the same
  // thing. What reconciled them was a regex looking for the word "later" in
  // the label, and a check on the copy cannot tell a clause that means
  // futurity from a word that merely spells it: futurity phrased in other
  // words was stated twice, and a "later" carrying no futurity at all
  // silenced the line on a wildcard that then said nothing about its reach.
  // Composing removes the collision rather than arbitrating it.
  //
  // The global wildcard is no longer an exemption. It read "Everything in
  // your space." because that sentence cannot be falsified by a type
  // registered tomorrow, which was all the device screen needed back when
  // the device screen needed the copy to carry it. It needs nothing of the
  // sort now, so `*` says what it reaches like every other entry and the
  // screens add the rest.
  // `routes/keys-page.ts` renders "Everything in your space" as a section
  // heading, without this entry's full stop, and that divergence is correct:
  // one is a heading and the other is a sentence a consent row prints.
  // Recorded because nothing will catch it if it stops being correct — the
  // duplicate-copy guard excludes non-dotted keys by construction, since a
  // bare `*` is an ordinary field name in code, so `*` sits outside what the
  // guard can see rather than having been overlooked by it.
  "*": "Everything in your space.",
  // Says what it reaches by saying what it does not, because the only
  // thing separating it from `*` above is the system family: the
  // category projects every system type to `none`, so a person holding
  // it grants nothing about their connections, devices, webhooks or
  // activity. Naming those four would date the sentence the next time
  // one is added; naming the thing they have in common does not.
  content: "Everything you save, and nothing about your account.",
  "core.*": "All standard content types.",
  "user.*": "Your custom types.",
  "app.*": "Types this app defines for itself.",

  // The relationship half of the three above, and the widest edge grant
  // expressible. All three were requestable and undescribed: a person
  // approving `edge.*` was shown the literal and asked to agree to it.
  //
  // **Curated rather than derived, for the same reason their type-axis
  // partners are.** `deriveWildcardDescription` answers for a publisher
  // root, where the set is open and a rule is the only thing that reaches a
  // root installed at boot. These three roots are structural — `user` and
  // `app` are the namespace tiers and `edge.*` names no root at all — so the
  // set is closed and a sentence can say what a rule could not.
  //
  // Phrased as how a person's items are joined rather than as a noun for the
  // relation, which is the rule the concrete edge entries above follow.
  "edge.*": "How everything in your space is connected.",
  "edge.user.*": "How your custom relationship types connect your items.",
  "edge.app.*":
    "How the relationship types this app defines connect your items.",
};

/**
 * The bundle set this consent screen groups under: the instance's active
 * bundles, which keep their `default_on` flags and carry the namespaces
 * the instance registered, folded in at boot. A curated
 * `MARFA_PERMISSION_BUNDLES` override is what `getPermissionBundles`
 * already answers with when one is set and valid.
 */
export function resolveConsentBundles(): PermissionBundle[] {
  return getPermissionBundles();
}

/**
 * For a requested custom-namespace wildcard (`user.*`, or a runtime
 * publisher-handle root the space registered), the display names of the
 * custom types the consenting user's space holds under that root today.
 * Read from `storage.types` (the persisted rows) rather than the
 * in-memory registry, so the answer does not depend on hydration state.
 * Reserved roots stay un-enumerated — their members are the platform's,
 * not the space's — and any other root enumerates only what the space
 * itself registered under it, so a registry-shipped root like `google.*`
 * keeps rendering without an enumeration.
 */
export async function resolveWildcardExpansions(
  storage: Storage,
  scopes: ParsedScope[],
): Promise<Record<string, string[]>> {
  const wildcardRoots = new Set<string>();
  for (const s of scopes) {
    if (s.kind === "oidc" || !s.typePattern.endsWith(".*")) continue;
    const root = s.typePattern.slice(0, -2);
    if (root.length === 0 || root.includes(".")) continue;
    // The runtime tiers (`user`, `app`) sit inside the reserved set —
    // reserved means unclaimable as a handle, not unregistrable — and are
    // exactly the roots a space registers under, so they enumerate. The
    // rest of the reserved set (`core`, `system`, `marfa`) is the
    // platform's and never does.
    if (isReservedRoot(root) && root !== "user" && root !== "app") continue;
    wildcardRoots.add(root);
  }
  if (wildcardRoots.size === 0) return {};
  const types = await storage.types.listCustom();
  const out: Record<string, string[]> = {};
  for (const root of wildcardRoots) {
    const names = types
      .filter((t) => t.id.startsWith(`${root}.`))
      .map((t) => t.label ?? t.id)
      .sort();
    if (names.length > 0) out[`${root}.*`] = names;
  }
  return out;
}

/**
 * The plain-English line one scope row gets, or undefined where the row
 * carries only its label.
 *
 * Written as an exhaustive switch on `kind` rather than a run of early
 * returns, and the `never` binding is the reason: a new scope family stops
 * this package compiling until somebody has decided what a person reads when
 * one appears on a consent screen. The families that reached this function
 * without a branch of their own did not render a neutral fallback. They
 * rendered nothing, on the one screen whose entire job is saying how large a
 * grant is.
 */
function describeScope(scope: ParsedScope): string | undefined {
  switch (scope.kind) {
    case "oidc":
      // Deliberately absent. `scopeName` in `consent.ts` and
      // `describeScope` in `device-pages.ts` both resolve an OIDC
      // literal through `oidc-labels.ts` and return before they look at this
      // map, so anything written here for one was computed and discarded. A
      // third register existed to fill it and is gone with it.
      return undefined;
    case "space":
      // Deliberately absent, for the reason above. `scopeName` in
      // `consent.ts` and `describeScope` in `device-pages.ts` both
      // resolve a space permission literal through
      // `space-permission-labels.ts` and return before they look at this map,
      // so anything written here for one was computed and discarded. The
      // branch that filled it is gone with it.
      //
      // Absent here is not a gap waiting on space permissions reaching a
      // consent screen. They are already described when they get there, on
      // both surfaces, by `SPACE_PERMISSION_LABELS` and
      // `SPACE_PERMISSION_SHORT`. Whoever comes to put one in front of a
      // person should extend those maps rather than this one: an entry here
      // is a third name for the same grant, in the one place neither renderer
      // reads.
      return undefined;
    case "content":
      // Resolved from the curated map, unlike the two arms above, because
      // both renderers do read the map for this kind. `describeScope`
      // on the device screen falls to `descriptions?.[s.typePattern]` for
      // everything that is not OIDC or a space permission, and `labelFor` on
      // the authorize screen falls through `SCOPE_LABELS` to the same map. So
      // a `content` entry written there reaches a person on both surfaces,
      // and a hard return here would discard it — silently, on the one screen
      // whose job is saying how large a grant is.
      //
      // The entry exists now, and this arm never changed to accommodate it —
      // which is what resolving rather than hard-returning bought. The two
      // literals still share the pattern `content`, so this map answers the
      // same sentence for both; what tells the read level from the write one
      // is the operation the row's label carries, which is derived per
      // literal rather than looked up here.
      return CONSENT_SCOPE_DESCRIPTIONS[scope.typePattern];
    case "edge": {
      // `edgeType` is optional on ParsedScope but always present when
      // kind === "edge"; guard for the type-checker.
      const edgeType = scope.edgeType;
      if (!edgeType) return undefined;
      // Curated user-facing copy wins. The fallback below is a belt and
      // reaches nothing today: `EDGE_TYPE_REGISTRY` is built once from the
      // shipped set with no seed path, and every member of it is curated,
      // which a test holds. It is emphatically NOT what serves an edge type
      // registered at runtime — that lives in a per-space overlay this
      // lookup never consults.
      return (
        CONSENT_SCOPE_DESCRIPTIONS[scope.typePattern] ??
        // Ahead of the registry rather than after it, so a namespace
        // wildcard can never resolve one edge type's copy as a whole root's.
        // The lookup below cannot do that today — `EDGE_TYPE_REGISTRY` is
        // keyed on exact ids, so `google.*` simply misses — but that is the
        // registry happening to miss rather than this function declining,
        // and the same distinction is drawn on the type axis one arm down.
        deriveWildcardDescription(scope.typePattern) ??
        EDGE_TYPE_REGISTRY.get(edgeType)?.description
      );
    }
    case "metadata":
    case "profile":
      // No registry fallback for either: a metadata sub-resource and a
      // profile row are not registered types, and nothing else holds copy
      // for one. Curated copy is the only possible source, which is also why
      // the coverage guard treats a missing entry here as a defect rather
      // than as a fallback working.
      return CONSENT_SCOPE_DESCRIPTIONS[scope.typePattern];
    case "type": {
      const curated = CONSENT_SCOPE_DESCRIPTIONS[scope.typePattern];
      if (curated) return curated;
      // A wildcard returns here rather than falling to the registry, and the
      // distinction is not academic. `TYPE_REGISTRY.get("core.*")` is
      // undefined today because the registry is keyed on exact ids, so the
      // lookup happens to miss. A registry that ever answered a pattern would
      // answer this one with a single type's copy standing in for a grant
      // over a whole namespace. Curated copy is the only source a wildcard
      // can have; missing it, the row is better left to its label.
      if (
        scope.typePattern === GLOBAL_TYPE_WILDCARD ||
        subtreeWildcardRoot(scope.typePattern) !== null
      ) {
        // Derived from the root where the map says nothing, which is what
        // reaches a publisher root installed at boot. Returns undefined for
        // the structural roots, whose wildcards are curated above.
        return deriveWildcardDescription(scope.typePattern);
      }
      return TYPE_REGISTRY.get(scope.typePattern)?.description;
    }
    default: {
      // Compile-time exhaustiveness check, the same one `isTypeScope` uses.
      // The runtime arm refuses too, so a value built by hand or arriving
      // from a stale build is not admitted either.
      const _exhaustive: never = scope.kind;
      void _exhaustive;
      return undefined;
    }
  }
}

/**
 * Build the `{ typePattern: description }` map both consent surfaces read for
 * the plain-English line per scope row: `/auth/authorize` and the device
 * approval screen, which used to hold a second vocabulary of its own.
 *
 * Missing entries fall through; the renderer shows the row's label, or the
 * literal where it has no label either.
 *
 * **Metadata scopes and wildcards are described rather than skipped, which
 * reverses what this function used to do.** The skip rested on a claim that
 * `metadata:read` and its siblings are self-explanatory to the audience that
 * requests them. That audience is the wrong one: whoever wrote the
 * integration is not who reads this screen, and the person deciding owns a
 * space rather than operates the server. The device screen had been showing
 * "Register and update custom data types in your space" against
 * `metadata.types` for exactly that reason, and between working copy on one
 * surface and a skip on the other, the copy is what should survive.
 *
 * Wildcards were never a judgment call, only an omission: nothing described
 * them here while the device screen did, and the registry cannot describe
 * one at all. See `CONSENT_SCOPE_DESCRIPTIONS` for why the pattern is what
 * both facts hang off.
 */
export function buildScopeDescriptions(
  scopes: ParsedScope[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const scope of scopes) {
    const description = describeScope(scope);
    if (description) out[scope.typePattern] = description;
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
