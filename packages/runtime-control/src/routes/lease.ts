import { Hono } from "hono";
import type { ControlPlaneEnv } from "../env.js";
import {
  MarfaServerClient,
  RuntimeCredentialMintError,
} from "../marfa-client.js";
import { brokerAuthFailure } from "../broker-auth.js";

/**
 * Lease broker.
 *
 *   POST /lease/:connection_id/runtime
 *     Mints (or refreshes) the per-Connection runtime credential by
 *     calling Marfa's `/system/runtime-credentials` endpoint. The
 *     control plane authenticates with MARFA_RUNTIME_BROKER_KEY (a
 *     long-lived `is_platform: true` key bound as a secret).
 *
 *     Permissions default to `*: write` on all three axes. The
 *     integration Worker calls this on every queue message; the
 *     per-Connection DO caches the result with TTL ≤ 5 min so the
 *     broker isn't hit on the hot path.
 *
 *   POST /lease/:connection_id/oauth/:capability_id
 *     Not yet implemented. Returns 501 until install-time manifest
 *     persistence captures `oauth_requirements.<capability_id>`.
 *
 * Both routes require the caller to present the broker key, because a
 * Connection ID is not a secret: it appears in operator surfaces, in
 * logs and in client state, so an unauthenticated mint path hands a
 * tenant-scoped credential to anyone who has seen one.
 */

export function registerLeaseRoutes(
  app: Hono<{ Bindings: ControlPlaneEnv }>,
): void {
  app.post("/lease/:connection_id/runtime", async (c) => {
    const connectionId = c.req.param("connection_id");
    const env = c.env;
    if (!env.MARFA_API_URL || !env.MARFA_RUNTIME_BROKER_KEY) {
      return c.json(
        {
          error: "control_plane_misconfigured",
          message:
            "MARFA_API_URL and MARFA_RUNTIME_BROKER_KEY must both be set.",
        },
        503,
      );
    }
    const unauthorized = brokerAuthFailure(c, env.MARFA_RUNTIME_BROKER_KEY);
    if (unauthorized) return unauthorized;

    const marfa = new MarfaServerClient(
      env.MARFA_API_URL,
      env.MARFA_RUNTIME_BROKER_KEY,
    );

    let body: { label?: string; source?: string; ttl_seconds?: number };
    try {
      body = await c.req.json<{
        label?: string;
        source?: string;
        ttl_seconds?: number;
      }>();
    } catch {
      body = {};
    }
    const ttl = body.ttl_seconds ?? 600;
    const label = body.label ?? `runtime ${connectionId}`;
    const source =
      body.source ??
      `runtime-${connectionId.slice(0, 12)}-${String(Date.now())}`;

    let minted;
    try {
      minted = await marfa.mintRuntimeCredential({
        connection_id: connectionId,
        label,
        source,
        // Wildcard write on all three permission axes — mirrors the
        // local-substrate credential mint (see
        // `packages/server/src/integrations/local-runtime/credentials.ts`).
        // All three axes must be granted: `edge_permissions` and
        // `extension_permissions` default to `{}`, which blocks every
        // `createEdge` / extension write, so a `type_permissions`-only
        // credential could write items but silently fail edge and
        // extension writes.
        type_permissions: { "*": "write" },
        edge_permissions: { "*": "write" },
        extension_permissions: { "*": "write" },
        ttl_seconds: ttl,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Pass a permanent verdict through with its own status instead of
      // flattening everything to 502. The Worker branches on this: 404
      // and 403 mean the Connection can never run again, so it tears the
      // schedule down; anything else it retries. Collapsing them made a
      // deleted Connection indistinguishable from a cold server.
      if (err instanceof RuntimeCredentialMintError) {
        if (err.status === 404) {
          return c.json(
            {
              error: "connection_not_found",
              message,
              connection_id: connectionId,
            },
            404,
          );
        }
        if (err.status === 403) {
          return c.json(
            {
              error: "connection_not_active",
              message,
              connection_id: connectionId,
            },
            403,
          );
        }
      }
      return c.json({ error: "mint_failed", message }, 502);
    }

    return c.json(
      {
        api_key: minted.api_key,
        connection_id: minted.connection_id,
        expires_at: minted.expires_at,
      },
      200,
    );
  });

  app.post("/lease/:connection_id/oauth/:capability_id", (c) => {
    if (!c.env.MARFA_RUNTIME_BROKER_KEY) {
      return c.json(
        {
          error: "control_plane_misconfigured",
          message: "MARFA_RUNTIME_BROKER_KEY must be set.",
        },
        503,
      );
    }
    const unauthorized = brokerAuthFailure(c, c.env.MARFA_RUNTIME_BROKER_KEY);
    if (unauthorized) return unauthorized;

    const connectionId = c.req.param("connection_id");
    const capabilityId = c.req.param("capability_id");
    return c.json(
      {
        error: "not_implemented",
        message:
          "Leased OAuth token broker is not yet implemented. It requires manifest persistence to capture oauth_requirements.<capability_id>.",
        connection_id: connectionId,
        capability_id: capabilityId,
      },
      501,
    );
  });
}
