/**
 * The OAuth Provider plugin's management endpoints, refused before the
 * Better Auth catch-all can serve them.
 *
 * The plugin registers two kinds of endpoint under `/oauth2/*`. The
 * protocol ones (authorize, consent, token, introspect, revoke, userinfo,
 * end-session, and the registration Marfa fronts) are the surface this
 * server exists to offer. The rest are the plugin's own management API,
 * gated on a signed-in session and nothing else: reading, widening and
 * deleting a user's consent rows, creating and editing OAuth clients, and
 * an admin resource registry.
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
 * token and the security page listing all survived. The client-management
 * endpoints are ownership-scoped inside the plugin, but nothing in Marfa
 * uses them, nothing audits them, and a session-created client would sit
 * outside every convention this server has about who registers a client and
 * how one is removed.
 *
 * Refused as 404 rather than 403 because these paths are not part of the
 * surface: an operator reading the reference finds no such route, and the
 * response says the same. Thrown as a `MarfaError` so the ordinary error
 * handler shapes the envelope and stamps `X-Error-Code`.
 *
 * The list is paired with a test that enumerates the plugin's registered
 * endpoints from the running auth instance and fails on any `/oauth2/*` or
 * `/admin/oauth2/*` path that is neither reachable by design nor named here.
 * A plugin upgrade that adds a management endpoint therefore reddens rather
 * than opening a door nobody looked at.
 */
import { Hono } from "hono";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";

/**
 * Plugin endpoints Marfa serves. Every other `/oauth2/*` or `/admin/oauth2/*`
 * path the plugin registers must appear in {@link FENCED_PLUGIN_ENDPOINTS},
 * and the enumeration test holds the two lists to the plugin's own.
 *
 * Paths are the plugin's, relative to the Better Auth base path (`/auth`).
 */
export const REACHABLE_PLUGIN_ENDPOINTS: readonly string[] = [
  "/oauth2/authorize",
  "/oauth2/consent",
  "/oauth2/continue",
  "/oauth2/token",
  "/oauth2/introspect",
  "/oauth2/revoke",
  "/oauth2/userinfo",
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
  // Consent management: a second writer of one of the grant's two records.
  "/oauth2/get-consent",
  "/oauth2/get-consents",
  "/oauth2/update-consent",
  "/oauth2/delete-consent",
  // Client management: registration is `POST /oauth2/register` and removal
  // is the platform-admin route; nothing here has a reader or an audit row.
  "/oauth2/create-client",
  "/oauth2/get-client",
  "/oauth2/get-clients",
  "/oauth2/public-client",
  "/oauth2/public-client-prelogin",
  "/oauth2/update-client",
  "/oauth2/client/rotate-secret",
  "/oauth2/delete-client",
  "/admin/oauth2/create-client",
  "/admin/oauth2/update-client",
  // The RFC 8707 resource registry. Marfa validates and strips `resource`
  // itself and mints opaque tokens for one audience, so the registry has
  // nothing to decide; its gate degrades to any signed-in session when the
  // privilege hook is unset, which it is.
  "/admin/oauth2/resources",
  "/admin/oauth2/resources/:identifier",
  "/admin/oauth2/resources/:identifier/clients/:client_id",
];

/** Mounted under `/auth`, ahead of the Better Auth catch-all in `app.ts`. */
export function oauthPluginFenceRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  for (const path of FENCED_PLUGIN_ENDPOINTS) {
    router.all(path, () => {
      throw new MarfaError(ErrorCode.NOT_FOUND, "Not found");
    });
  }
  return router;
}
