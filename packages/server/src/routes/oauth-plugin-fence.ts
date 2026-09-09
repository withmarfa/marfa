/**
 * The OAuth Provider plugin's management endpoints, refused before the
 * Better Auth catch-all can serve them.
 *
 * The plugin registers two kinds of endpoint. The protocol ones (authorize,
 * token, introspect, revoke, userinfo, end-session, and the registration
 * Marfa fronts) are the surface this server exists to offer. The rest are
 * the plugin's own management API: reading, widening and deleting a user's
 * consent rows, creating and editing OAuth clients, a public client lookup,
 * and an admin resource registry. Most of it is gated on a signed-in session
 * and nothing else.
 *
 * **A grant is two records here, and Marfa's own routes are the only writers
 * that keep them in step.** The consent decision and the revoke cascade write
 * the plugin's `auth_oauth_consent` row and the `system.connection`
 * projection together, and every reader — the security page, `/auth/grants`,
 * the device token step, the consent skip — trusts that they agree. The
 * plugin's consent endpoints write one of the two. Driven against staging,
 * `update-consent` added a scope to the consent row with no consent screen
 * and no audit row, and the next authorize for that scope was answered
 * silently; `delete-consent` removed the row while the tokens, the refresh
 * token and the security page listing all survived. The plugin's `consent`
 * endpoint is the same writer one step earlier: it upserts the consent row
 * and mints a code with no projection and no audit row. Marfa's consent
 * screen posts to `/auth/authorize/decision`, which accepts through the
 * plugin in-process rather than over the wire, so nothing legitimate reaches
 * the HTTP endpoint and it is fenced with the rest.
 *
 * The client-management endpoints are the sharper case. Their gate degrades
 * to any signed-in session when `clientPrivileges` is unset, which it is,
 * and `create-client` admits the whole registration allowlist, so any user
 * could mint a client wider than the ceiling dynamic registration enforces.
 * Nothing in Marfa reads them and nothing audits them.
 *
 * Refused as 404 rather than 403 because these paths are not part of the
 * surface. Thrown as a `MarfaError` so the ordinary error handler shapes the
 * envelope and stamps `X-Error-Code`. Better Auth's own `disabledPaths`
 * option would also answer 404, as a bare response from inside the library;
 * the Hono pre-mount gives the Marfa envelope, the header the test keys on,
 * and a list a test can import.
 *
 * **The fence holds at the wire and nowhere else.** A Marfa handler calling
 * the plugin's API in-process (`auth.api.updateOAuthConsent` and its
 * siblings) would write one record again with nothing here to stop it; that
 * path is held by review.
 *
 * The lists are paired with a test that enumerates a freshly constructed
 * plugin's endpoint record. That record is a flat literal no option gates,
 * so it is the set the running instance registers. Every routable path must
 * be either reachable by design or named here, whatever prefix it carries,
 * so a plugin upgrade that adds a management endpoint reddens rather than
 * opening a door nobody looked at. Endpoints the plugin marks server-only
 * are never routed by Better Auth at all; the admin variants and the
 * resource registry are among them today and are fenced regardless, so a
 * version that exposes them meets a 404 rather than the catch-all.
 */
import { Hono } from "hono";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";

/**
 * Plugin endpoints Marfa serves. Every other path the plugin routes must
 * appear in {@link FENCED_PLUGIN_ENDPOINTS}, and the enumeration test holds
 * the two lists to the plugin's own record.
 *
 * Paths are the plugin's, relative to the Better Auth base path (`/auth`).
 */
export const REACHABLE_PLUGIN_ENDPOINTS: readonly string[] = [
  "/oauth2/authorize",
  // The plugin's own continuation after its login page. Marfa's sign-in
  // returns the browser to the authorize URL instead, so this goes unused,
  // but it is part of the plugin's authorize flow and writes no grant record.
  "/oauth2/continue",
  "/oauth2/token",
  "/oauth2/introspect",
  "/oauth2/revoke",
  "/oauth2/userinfo",
  // Marfa fronts the GET in `routes/auth-pages.ts`; the plugin serves the
  // POST and the confirmation step.
  "/oauth2/end-session",
  "/oauth2/end-session/confirm",
  // Fronted by Marfa's own handler in `routes/oauth-register.ts`, which is
  // mounted ahead of the catch-all; the plugin's endpoint never runs.
  "/oauth2/register",
];

/**
 * Plugin endpoints this server does not serve. Hono path syntax, because
 * the resource routes carry path parameters.
 */
export const FENCED_PLUGIN_ENDPOINTS: readonly string[] = [
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

/** Mounted under `/auth`, ahead of the Better Auth catch-all in `app.ts`. */
export function oauthPluginFenceRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const refuse = (): never => {
    throw new MarfaError(ErrorCode.NOT_FOUND, "Not found");
  };
  for (const path of FENCED_PLUGIN_ENDPOINTS) {
    // Both spellings. Hono matches strictly, so `update-consent/` would
    // otherwise fall to the catch-all, where only Better Auth's default of
    // refusing a trailing slash keeps it closed. A fence that depends on a
    // library default nobody here is watching is not a fence.
    router.all(path, refuse);
    router.all(`${path}/`, refuse);
  }
  return router;
}
