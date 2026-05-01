/**
 * Control plane Worker bindings.
 *
 * Every binding is optional at the type level so the Worker can boot
 * with the minimum surface; routes that need a missing binding return
 * 503 with a clear reason rather than crashing the Worker. This keeps
 * the skeleton deployable while bindings are being filled in.
 */
export interface ControlPlaneEnv {
  /** Base URL of the Myme server this control plane talks to. */
  MYME_API_URL?: string;
  /** Long-lived broker key the control plane uses to mint per-Connection
   *  runtime credentials and look up inbound-webhook subscriptions. */
  MYME_RUNTIME_BROKER_KEY?: string;
  /** Environment label surfaced in /health responses. */
  ENVIRONMENT?: string;

  // ---- Bindings provisioned via wrangler.control.toml -----------------
  /** Cloudflare Queue producer for verified inbound webhook deliveries.
   *  Per-Integration Workers consume from this queue. Wired in PR 3 of
   *  Layer 1 (binding) + PR 4 (real send). */
  WEBHOOK_RECEIPT_QUEUE?: QueueProducer;
  /** Reactive-run producer (the server-side bridge sends here too;
   *  the control plane keeps it bound for future use cases like
   *  re-broadcasting from the webhook flow). */
  REACTIVE_RUN_QUEUE?: QueueProducer;
  /** Short-lived idempotency cache keyed by `${webhook_id}:${delivery_id}`. */
  IDEMPOTENCY_KV?: KVNamespace;
}

/** Slim shape we accept for tests — the real Cloudflare QueueProducer
 *  binding satisfies this with `send(message: T): Promise<void>`. */
interface QueueProducer {
  send(
    body: unknown,
    opts?: { contentType?: "json" | "text" | "v8" },
  ): Promise<void>;
}
