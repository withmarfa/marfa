import { Hono } from "hono";
import type { ControlPlaneEnv } from "../env.js";

/**
 * Inbound webhook receiver. PR 1 ships the route shape only — the body
 * is captured (so size limits and content-type checks can land here)
 * but verification + queue enqueue are stubbed pending PR 3.
 *
 * Final shape (PR 3):
 *   1. Resolve the inbound_webhook row from the Myme server by
 *      `connection_id` + adapter-extracted external_delivery_id.
 *   2. Decrypt the row's secret via the existing secret-encryption
 *      helper (server-side; the control plane fetches a verification
 *      token, never the raw secret).
 *   3. Dispatch to the manifest's verification adapter.
 *   4. On success: enqueue { integration_name, connection_id,
 *      delivery_id, headers, body, verified_at_ms } onto
 *      WEBHOOK_RECEIPT_QUEUE; respond 202.
 *   5. On failure: respond 401 (do not enqueue).
 *
 * Bodies > 256KB get handed off via R2 with a presigned URL in the
 * queue message. R2 binding wiring lives behind a separate PR.
 */
export function registerWebhookRoutes(
  app: Hono<{ Bindings: ControlPlaneEnv }>,
): void {
  app.post("/webhooks/inbound/:connection_id", async (c) => {
    const connectionId = c.req.param("connection_id");
    if (!connectionId) {
      return c.json({ error: "missing_connection_id" }, 400);
    }
    // Drain the body so the request doesn't hang; size enforcement
    // belongs to wrangler's request limit (100MB on standard plans).
    const _body = await c.req.arrayBuffer();
    void _body;
    return c.json(
      {
        error: "not_implemented",
        message: "Inbound webhook routing lands in PR 3.",
        connection_id: connectionId,
      },
      501,
    );
  });
}
