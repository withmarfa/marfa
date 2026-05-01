import { Hono } from "hono";
import type { ControlPlaneEnv } from "../env.js";

/**
 * Lease broker. PR 1 ships the route shape only; PR 4 wires the broker
 * to mint short-TTL runtime credentials via Myme's
 * `/system/runtime-credentials` endpoint, and surface leased OAuth
 * tokens via the existing `/connections/:id/lease-token` route.
 *
 * Two flavors share this prefix:
 *   POST /lease/:connection_id/runtime
 *     → mints (or refreshes) the per-Connection runtime credential
 *       used by the integration Worker to call Myme. Cached in the
 *       per-Connection DO with TTL ≤ 5 min.
 *
 *   POST /lease/:connection_id/oauth/:capability_id
 *     → forwards a leased-token request to Myme on behalf of an
 *       integration whose manifest declares
 *       `oauth_requirements.<capability_id> === "leased"`.
 */
export function registerLeaseRoutes(
  app: Hono<{ Bindings: ControlPlaneEnv }>,
): void {
  app.post("/lease/:connection_id/runtime", (c) => {
    const connectionId = c.req.param("connection_id");
    return c.json(
      {
        error: "not_implemented",
        message:
          "Runtime credential broker lands in PR 4 (server-side mint route + broker key).",
        connection_id: connectionId,
      },
      501,
    );
  });

  app.post("/lease/:connection_id/oauth/:capability_id", (c) => {
    const connectionId = c.req.param("connection_id");
    const capabilityId = c.req.param("capability_id");
    return c.json(
      {
        error: "not_implemented",
        message:
          "Leased OAuth token broker lands in PR 4; calls Myme's existing /connections/:id/lease-token route.",
        connection_id: connectionId,
        capability_id: capabilityId,
      },
      501,
    );
  });
}
