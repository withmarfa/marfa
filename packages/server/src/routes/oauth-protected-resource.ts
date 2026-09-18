/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * A resource server advertises which authorization server protects it;
 * clients start at a 401's `resource_metadata` challenge parameter, fetch
 * this document, and discover the authorization server from it. One
 * document is served, at `/.well-known/oauth-protected-resource`, with the
 * API origin as the resource.
 *
 * `scopes_supported` carries the default consent bundles' expansion: the
 * minimal useful grant, matching what the consent screen offers by default.
 * Step-up beyond it rides scope challenges, not this document.
 */

import { Hono } from "hono";
import {
  expandBundlesToScopes,
  type PermissionBundle,
} from "@withmarfa/shared";
import { getPermissionBundles } from "../config.js";
import type { AppEnv } from "../middleware/auth.js";

interface ProtectedResourceConfig {
  authBaseUrl: string;
  permissionBundles?: PermissionBundle[];
}

function metadataFor(
  resource: string,
  authBaseUrl: string,
  bundles: PermissionBundle[],
) {
  return {
    resource,
    authorization_servers: [`${authBaseUrl}/auth`],
    scopes_supported: expandBundlesToScopes(bundles),
    bearer_methods_supported: ["header"],
  };
}

export function oauthProtectedResourceRoutes(
  config: ProtectedResourceConfig,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const base = config.authBaseUrl.replace(/\/+$/, "");
  const bundles = config.permissionBundles ?? getPermissionBundles();

  app.get("/.well-known/oauth-protected-resource", (c) =>
    c.json(metadataFor(base, base, bundles)),
  );

  return app;
}
