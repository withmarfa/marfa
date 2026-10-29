/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * A resource server advertises which authorization server protects it;
 * clients start at a 401's `resource_metadata` challenge parameter, fetch
 * this document, and discover the authorization server from it. The API
 * origin's document is served at `/.well-known/oauth-protected-resource`, and
 * each MCP endpoint's at that path followed by the endpoint's own, naming the
 * endpoint as the resource.
 *
 * `scopes_supported` carries the default consent bundles' expansion: the
 * minimal useful grant, matching what the consent screen offers by default.
 * An MCP group's document adds the scopes its own tools need. Step-up beyond
 * that rides scope challenges, not this document.
 */

import { Hono } from "hono";
import {
  expandBundlesToScopes,
  type PermissionBundle,
} from "@withmarfa/shared";
import { getPermissionBundles } from "../config.js";
import type { AppEnv } from "../middleware/auth.js";
import {
  MCP_RESOURCE_PATHS,
  mcpResourceUri,
  protectedResourceMetadataPath,
} from "../auth/mcp-resource.js";
import { GROUP_SCOPES, groupAt } from "../mcp/groups.js";

interface ProtectedResourceConfig {
  authBaseUrl: string;
  permissionBundles?: PermissionBundle[];
}

function metadataFor(
  resource: string,
  authBaseUrl: string,
  bundles: PermissionBundle[],
  extraScopes: readonly string[] = [],
) {
  return {
    resource,
    authorization_servers: [`${authBaseUrl}/auth`],
    scopes_supported: [
      ...new Set([...expandBundlesToScopes(bundles), ...extraScopes]),
    ].sort(),
    bearer_methods_supported: ["header"],
  };
}

export function oauthProtectedResourceRoutes(
  config: ProtectedResourceConfig,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const base = config.authBaseUrl.replace(/\/+$/, "");
  const bundles = config.permissionBundles ?? getPermissionBundles();

  app.get(protectedResourceMetadataPath(), (c) =>
    c.json(metadataFor(base, base, bundles)),
  );
  for (const path of MCP_RESOURCE_PATHS) {
    app.get(protectedResourceMetadataPath(path), (c) =>
      c.json(
        metadataFor(
          mcpResourceUri(base, path),
          base,
          bundles,
          GROUP_SCOPES[groupAt(path)],
        ),
      ),
    );
  }

  return app;
}
