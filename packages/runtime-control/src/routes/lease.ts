import { Hono } from "hono";
import { ErrorCode } from "@withmarfa/shared";
import type { ControlPlaneEnv } from "../env.js";
import {
  MarfaServerClient,
  RuntimeCredentialMintError,
} from "../marfa-client.js";
import { authenticateWorker } from "../worker-identity.js";

/**
 * Lease broker.
 *
 *   POST /lease/:connection_id/runtime
 *     Mints (or refreshes) the per-Connection runtime credential by
 *     calling Marfa's `/system/runtime-credentials` endpoint. The
 *     control plane authenticates to the server with
 *     MARFA_RUNTIME_BROKER_KEY (a long-lived `is_platform: true` key
 *     bound as a secret) — that value stays here and is never handed
 *     downstream.
 *
 *     The Marfa server resolves the Connection's persisted Integration
 *     manifest and owns permission projection. The integration Worker calls
 *     this on every queue message; the per-Connection DO caches the result
 *     with TTL ≤ 5 min so the broker isn't hit on the hot path.
 *
 *     A mint refusal is classified by the server's error CODE, not its
 *     status: only `connection_not_found` / `connection_not_active`
 *     are about the Connection itself and pass through as terminal.
 *     Everything else — including a 403 that means the broker key
 *     isn't a platform credential, and the 403 that means the caller
 *     asked for a Connection belonging to a different integration — is
 *     `mint_failed` 502, which the Worker retries. A misrouted request
 *     is a deployment fault, not a verdict on the Connection, and
 *     nothing re-arms a schedule torn down by mistake.
 *
 *   POST /lease/:connection_id/oauth/:capability_id
 *     Not yet implemented. Returns 501 until install-time manifest
 *     persistence captures `oauth_requirements.<capability_id>`.
 *
 * Both routes authenticate the caller as a specific integration Worker,
 * because a Connection ID is not a secret: it appears in operator
 * surfaces, in logs and in client state, so an unauthenticated mint path
 * hands a space-scoped credential to anyone who has seen one. The
 * integration the caller proves is forwarded to the server, which holds
 * the persisted manifest and refuses a Connection that belongs to
 * another integration.
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
    const caller = await authenticateWorker(c);
    if (!caller.ok) return caller.response;

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
        // The integration the caller proved, never one it asked for.
        // The server checks this against the Connection's persisted
        // manifest, so forwarding anything the request body carried
        // would hand the check back to the party it exists to check.
        integration_name: caller.integrationName,
        label,
        source,
        ttl_seconds: ttl,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Pass a permanent verdict through with its own status instead of
      // flattening everything to 502. The Worker branches on this: a
      // terminal verdict means the Connection can never run again, so it
      // tears the schedule down; anything else it retries. Collapsing
      // them made a deleted Connection indistinguishable from a cold
      // server.
      //
      // The server's error CODE decides, not its status. Status is only
      // the cross-check. Both statuses below are shared with route-level
      // failures that are not about any Connection: 403 also answers
      // "this credential is not a platform credential", and 404 also
      // answers "no such route". Classifying on status alone means one
      // mis-scoped `MARFA_RUNTIME_BROKER_KEY`, or one wrong
      // `MARFA_API_URL`, hands every Connection in every space a
      // terminal verdict on its next tick — and a torn-down schedule
      // only comes back through a per-Connection arm by an operator.
      // The asymmetry has to favor retrying.
      if (err instanceof RuntimeCredentialMintError) {
        if (
          err.status === 404 &&
          err.code === (ErrorCode.CONNECTION_NOT_FOUND as string)
        ) {
          return c.json(
            {
              error: "connection_not_found",
              message,
              connection_id: connectionId,
            },
            404,
          );
        }
        if (
          err.status === 403 &&
          err.code === (ErrorCode.CONNECTION_NOT_ACTIVE as string)
        ) {
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

  app.post("/lease/:connection_id/oauth/:capability_id", async (c) => {
    const caller = await authenticateWorker(c);
    if (!caller.ok) return caller.response;

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
