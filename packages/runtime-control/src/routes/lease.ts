import { Hono } from "hono";
import type { ControlPlaneEnv } from "../env.js";
import { MarfaServerClient } from "../marfa-client.js";

/**
 * Lease broker.
 *
 *   POST /lease/:connection_id/runtime
 *     Mints (or refreshes) the per-Connection runtime credential by
 *     calling Marfa's `/system/runtime-credentials` endpoint. The
 *     control plane authenticates with MARFA_RUNTIME_BROKER_KEY (a
 *     long-lived `is_platform: true` key bound as a secret).
 *
 *     The Marfa server resolves the Connection's persisted Integration
 *     manifest and owns permission projection. The integration Worker calls
 *     this on every queue message; the per-Connection DO caches the result
 *     with TTL ≤ 5 min so the broker isn't hit on the hot path.
 *
 *   POST /lease/:connection_id/oauth/:capability_id
 *     Not yet implemented. Returns 501 until install-time manifest
 *     persistence captures `oauth_requirements.<capability_id>`.
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
        ttl_seconds: ttl,
      });
    } catch (err) {
      return c.json(
        {
          error: "mint_failed",
          message: err instanceof Error ? err.message : String(err),
        },
        502,
      );
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
