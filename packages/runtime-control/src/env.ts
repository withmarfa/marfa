/**
 * Control plane Worker bindings.
 *
 * Layer 1 PR 1 ships only the secrets the skeleton needs to surface a
 * health/readiness signal. Subsequent PRs widen this:
 *   - PR 3 adds Queue producer bindings (WEBHOOK_RECEIPT_QUEUE,
 *     REACTIVE_RUN_QUEUE) and the KV idempotency cache.
 *   - PR 4 wires MYME_RUNTIME_BROKER_KEY through the lease handler.
 *   - Layer 2 adds R2 bindings for large-payload handoff.
 *
 * Every binding is optional at the type level so PR 1 can boot with
 * just MYME_API_URL set; a missing required binding surfaces a 503 at
 * the route that needs it (see /lease, /webhooks/inbound), not a Worker
 * crash. This keeps the skeleton deployable while later PRs land.
 */
export interface ControlPlaneEnv {
  /** Base URL of the Myme server this control plane talks to. Required. */
  MYME_API_URL?: string;
  /** Long-lived broker key the control plane uses to mint per-Connection
   *  runtime credentials. Wired in PR 4. */
  MYME_RUNTIME_BROKER_KEY?: string;
  /** Environment label surfaced in /health responses. */
  ENVIRONMENT?: string;
}
