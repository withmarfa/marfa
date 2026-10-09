/**
 * The sign-in library's routes this server serves, and the refusal every
 * other path under `/auth` meets before the library can answer it.
 *
 * The library and its OAuth Provider plugin register far more than Marfa
 * uses: social sign-in, email flows, profile and account editing, session
 * listings, a password check, a session token signed with the ID-token keys,
 * and the plugin's own management API. Marfa serves only the routes its
 * clients and pages call, and `credential-census.json` says which those are:
 * every route the configured library registers is named there with a
 * boundary, and only the boundaries in {@link SERVED_BOUNDARIES} reach the
 * library over the wire. A library upgrade that adds a route fails
 * `credential-census.test.ts` until the route is classified, and until then
 * it is refused like any other path.
 *
 * **The plugin's management endpoints are the sharpest case.** A grant is
 * two records here, and Marfa's own routes are the only writers that keep
 * them in step. The consent decision and the revoke cascade write the
 * plugin's `auth_oauth_consent` row and the `system.connection` projection
 * together, and every reader (the security page, `/auth/grants`, the device
 * token step, the consent skip) trusts that they agree. The plugin's consent
 * endpoints write one of the two. Driven against staging, `update-consent`
 * added a scope to the consent row with no consent screen and no audit row,
 * and the next authorize for that scope was answered silently;
 * `delete-consent` removed the row while the tokens, the refresh token and
 * the security page listing all survived. The plugin's `consent` endpoint is
 * the same writer one step earlier. Marfa's consent screen posts to
 * `/auth/authorize/decision`, which accepts through the plugin in-process,
 * so nothing legitimate reaches the HTTP endpoint. The client-management
 * endpoints' gate degrades to any signed-in session when `clientPrivileges`
 * is unset, which it is, and `create-client` admits the whole registration
 * allowlist.
 *
 * Refused as 404 rather than 403 because these paths are not part of the
 * surface. Thrown as a `MarfaError` so the ordinary error handler shapes the
 * envelope and stamps `X-Error-Code`. The refusal is an allowlist on the
 * catch-all rather than a list of fenced paths, so a path nobody listed,
 * either spelling of it, and a route a library upgrade adds are all refused
 * the same way.
 *
 * **The fence holds at the wire and nowhere else.** A Marfa handler calling
 * the library's API in-process (`auth.api.updateOAuthConsent` and its
 * siblings) would write one record again with nothing here to stop it; that
 * path is held by review.
 *
 * The plugin's lists below are paired with a test that enumerates a freshly
 * constructed plugin's endpoint record, so a plugin upgrade that adds a
 * management endpoint reddens rather than opening a door nobody looked at.
 */
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import census from "../auth/credential-census.json" with { type: "json" };

/**
 * Plugin endpoints Marfa serves. Every other path the plugin routes must
 * appear in {@link FENCED_PLUGIN_ENDPOINTS}, and the enumeration test holds
 * the two lists to the plugin's own record.
 *
 * Paths are the plugin's, relative to the Better Auth base path (`/auth`).
 */
export const REACHABLE_PLUGIN_ENDPOINTS: readonly string[] = [
  "/oauth2/authorize",
  "/oauth2/token",
  "/oauth2/introspect",
  "/oauth2/revoke",
  "/oauth2/userinfo",
  // Marfa fronts the GET in `routes/auth-pages.ts`; the plugin serves the
  // POST and the confirmation step.
  "/oauth2/end-session",
  "/oauth2/end-session/confirm",
  "/oauth2/register",
  // The device plugin's initiation endpoint (RFC 8628 §3.1); the exchange is
  // `/oauth2/token` with the device grant.
  "/device/code",
  // Marfa fronts the GET with its verification page in `routes/auth-pages.ts`
  // and calls the plugin's own verify in-process from the consent screen, so
  // the plugin's JSON answer never serves over the wire.
  "/device",
];

/**
 * Plugin endpoints this server does not serve, each with why. Hono path
 * syntax, because the resource routes carry path parameters.
 */
export const FENCED_PLUGIN_ENDPOINTS: readonly string[] = [
  // The device plugin's own decision endpoints approve a code as it was
  // requested, with no consent screen, no narrowing, no projection and no
  // audit row; Marfa's `POST /auth/device/consent` is the one approver and
  // reaches them in-process. `/device/token` mints a first-party session for
  // the code's user, which is a sign-in door this server does not offer.
  "/device/approve",
  "/device/deny",
  "/device/token",
  // The plugin's own continuation after its login page, which issues a code
  // from a signed authorize query without passing through `/oauth2/authorize`
  // again, where Marfa narrows the scopes, refuses a bearer header and audits
  // a reused grant. Marfa's sign-in returns the browser to the authorize URL
  // instead.
  "/oauth2/continue",
  // Consent: every writer of one of the grant's two records. The accept
  // Marfa performs goes through the plugin in-process, never over the wire.
  "/oauth2/consent",
  "/oauth2/get-consent",
  "/oauth2/get-consents",
  "/oauth2/update-consent",
  "/oauth2/delete-consent",
  // Client management: registration is `POST /oauth2/register` and removal
  // is the operator route; nothing here has a reader or an audit row,
  // and the create gate admits any signed-in session.
  "/oauth2/create-client",
  "/oauth2/get-client",
  "/oauth2/get-clients",
  "/oauth2/update-client",
  "/oauth2/client/rotate-secret",
  "/oauth2/delete-client",
  // Read-only client lookups with no reader in this tree. The plugin refuses
  // the pre-login one itself while `allowPublicClientPrelogin` is unset.
  // Unfence these if the consent screen ever moves client-side.
  "/oauth2/public-client",
  "/oauth2/public-client-prelogin",
  // Server-only in the plugin today, so never routed; fenced so that a
  // version which exposes them changes nothing here.
  "/admin/oauth2/create-client",
  "/admin/oauth2/update-client",
  // The RFC 8707 resource registry, server-only today as well. Marfa
  // validates and strips `resource` itself and mints opaque tokens for one
  // audience, so the registry has nothing to decide; its gate degrades to
  // any signed-in session when the privilege hook is unset, which it is.
  "/admin/oauth2/resources",
  "/admin/oauth2/resources/:identifier",
  "/admin/oauth2/resources/:identifier/clients/:client_id",
];

/**
 * The census boundaries whose routes the library answers over the wire:
 * password sign-in and the browser session, the key set that signs ID
 * tokens, the OAuth protocol, the device grant's initiation and the
 * discovery and error documents.
 */
export const SERVED_BOUNDARIES: readonly string[] = [
  "password-session",
  "signing",
  "oauth-protocol",
  "device",
  "metadata",
];

/** The library's paths this server serves, relative to `/auth`. */
export const SERVED_LIBRARY_PATHS: ReadonlySet<string> = new Set(
  Object.values(
    census as Record<string, { path: string | null; boundary: string }>,
  )
    .filter((entry) => SERVED_BOUNDARIES.includes(entry.boundary))
    .flatMap((entry) => (entry.path === null ? [] : [entry.path])),
);

/**
 * Refuse a request the `/auth/*` catch-all received unless it names a route
 * the library serves here. `path` is the request's raw pathname, `/auth`
 * included, percent-escapes and all: the library and the facade route on
 * that string, so the fence must judge the same one.
 */
export function refuseUnservedLibraryPath(path: string): void {
  if (!SERVED_LIBRARY_PATHS.has(path.replace(/^\/auth/, "")))
    throw new MarfaError(ErrorCode.NOT_FOUND, "Not found");
}
