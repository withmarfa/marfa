import { Hono } from "hono";
import type { ControlPlaneEnv } from "../env.js";
import { MymeServerClient } from "../myme-client.js";

/**
 * Lease broker.
 *
 *   POST /lease/:connection_id/runtime
 *     Mints (or refreshes) the per-Connection runtime credential by
 *     calling Myme's `/system/runtime-credentials` endpoint. The
 *     control plane authenticates with MYME_RUNTIME_BROKER_KEY (a
 *     long-lived `is_platform: true` key bound as a secret).
 *
 *     Layer 1 PR 4 ships this endpoint with manifest-derived
 *     permissions defaulting to `*: write` — Layer 2's install
 *     pipeline narrows them per the manifest's declared scopes. The
 *     integration Worker calls this on every queue message; the
 *     per-Connection DO caches the result with TTL ≤ 5 min so the
 *     broker isn't hit on the hot path.
 *
 *   POST /lease/:connection_id/oauth/:capability_id
 *     Stub for Layer 2 — proxies a leased-token request to Myme's
 *     existing `/connections/:id/lease-token` route. Layer 2 wires
 *     the install-time manifest persistence that captures
 *     `oauth_requirements.<capability_id> === "leased"`; until then
 *     the broker returns 501.
 */
export function registerLeaseRoutes(
  app: Hono<{ Bindings: ControlPlaneEnv }>,
): void {
  app.post("/lease/:connection_id/runtime", async (c) => {
    const connectionId = c.req.param("connection_id");
    const env = c.env;
    if (!env.MYME_API_URL || !env.MYME_RUNTIME_BROKER_KEY) {
      return c.json(
        {
          error: "control_plane_misconfigured",
          message: "MYME_API_URL and MYME_RUNTIME_BROKER_KEY must both be set.",
        },
        503,
      );
    }
    const myme = new MymeServerClient(
      env.MYME_API_URL,
      env.MYME_RUNTIME_BROKER_KEY,
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
      minted = await myme.mintRuntimeCredential({
        connection_id: connectionId,
        label,
        source,
        // Wildcard write on all three permission axes — mirrors the
        // local-substrate credential mint (see
        // `packages/server/src/integrations/local-runtime/credentials.ts`).
        // Pre-T-260 only `type_permissions` was set, so the runtime
        // credential could write items but silently failed every
        // `createEdge` / extension write — both default to `{}` and
        // block the call. T-249's `google.youtube` was the first
        // manifest to declare `permissions.edge: { "parent-of": "write" }`
        // and surfaced the gap. Manifest-projected permissions
        // (each Connection's credential carrying exactly the
        // per-manifest map rather than wildcard) is a separate
        // refinement filed as the long-term follow-on on T-260.
        type_permissions: { "*": "write" },
        edge_permissions: { "*": "write" },
        extension_permissions: { "*": "write" },
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
          "Leased OAuth token broker lands in Layer 2 once manifest persistence captures oauth_requirements.<capability_id>.",
        connection_id: connectionId,
        capability_id: capabilityId,
      },
      501,
    );
  });
}
