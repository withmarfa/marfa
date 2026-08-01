/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * An HTTP MCP server must advertise which authorization server protects it;
 * clients start at a 401's `resource_metadata` challenge parameter, fetch
 * this document, and discover the authorization server from it. Two
 * documents are served: the origin-level one at
 * `/.well-known/oauth-protected-resource` (resource = the API origin) and
 * the path-aware one at `/.well-known/oauth-protected-resource/mcp`
 * (resource = the MCP endpoint, the RFC's insertion of the well-known
 * segment between host and resource path). Hosted deployments only — in
 * keys mode there is no authorization server to point at.
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
  app.get("/.well-known/oauth-protected-resource/mcp", (c) =>
    c.json(metadataFor(`${base}/mcp`, base, bundles)),
  );

  return app;
}
