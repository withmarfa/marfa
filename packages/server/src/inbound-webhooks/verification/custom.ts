import type { VerifyInboundWebhook } from "./types.js";

/**
 * Custom verification stub for workstream 2.
 *
 * A manifest declaring `webhook_verification: { method: "custom", adapter_id }`
 * is allowed to land on the system in WS2 — but the runtime that resolves
 * the named adapter and dispatches into it lives in workstream 3.
 *
 * In WS2 every receipt to a custom-verification subscription returns
 * `verified: false` with a clear reason so:
 *   1. Operators can see the gap in `inbound_webhook_events.processing_error`.
 *   2. The route still writes the row (for audit + future retry once
 *      WS3's adapter resolution lands) and returns 401 like any other
 *      verification failure.
 *
 * This intentionally never returns true. Once WS3 adds adapter
 * resolution, the dispatch table swaps this stub for the resolver.
 */
export const verifyCustom: VerifyInboundWebhook = () => {
  return {
    verified: false,
    reason: "custom verification not yet implemented (WS3)",
  };
};
