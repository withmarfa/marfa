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

  // ---- Cloudflare Queues HTTP-pull config (T-084) ---------------------
  /** Account-scoped Cloudflare API token with `queues_read` +
   *  `queues_write` permissions. Used by the DLQ peek/replay routes
   *  to access the HTTP-pull substrate (the runtime-control Worker
   *  itself is not a queue consumer; pull is on-demand). Set via
   *  `wrangler secret put CLOUDFLARE_QUEUES_API_TOKEN --env <env>`. */
  CLOUDFLARE_QUEUES_API_TOKEN?: string;
  /** Cloudflare account id the queues live in. Set as a wrangler
   *  `[vars]` entry (not secret — also hardcoded as `account_id` at
   *  the top of wrangler.control.toml). */
  CLOUDFLARE_ACCOUNT_ID?: string;

  // ---- Bindings provisioned via wrangler.control.toml -----------------
  /**
   * Legacy shared Cloudflare Queue producer for verified inbound webhook
   * deliveries. Kept as the fallback path for `mymehq.github-webhooks`
   * which still consumes from this queue. New inbound-webhook
   * integrations bind their own per-integration producer below — the
   * shared queue + envelope-filter model can't scale past a single
   * consumer (Cloudflare Queues allow at most one consumer per queue;
   * the runtime-sdk's envelope filter only fires after the message has
   * already been delivered to that single consumer, so any other
   * integration's messages would be silently filtered out).
   *
   * The route picks `WEBHOOK_RECEIPT_QUEUE_<NAME>` first when present,
   * falling back to this shared binding otherwise.
   */
  WEBHOOK_RECEIPT_QUEUE?: QueueProducer;
  /**
   * Per-integration inbound-webhook queue producers. One binding per
   * integration with a `webhook` trigger. The route in `webhooks.ts`
   * resolves the binding by `integration_name`. Adding a new
   * inbound-webhook integration requires:
   *   1. New `[[env.<env>.queues.producers]]` block in `wrangler.control.toml`.
   *   2. New field on this interface (the resolver fans out via a name-keyed map).
   *   3. New `[[env.<env>.queues.consumers]]` block on the per-Integration
   *      Worker's wrangler.toml pointing at the same queue.
   *   4. `provision.ts` mints the queue + DLQ.
   */
  WEBHOOK_RECEIPT_QUEUE_MYMEHQ_INBOX?: QueueProducer;
  WEBHOOK_RECEIPT_QUEUE_GOOGLE_CALENDAR?: QueueProducer;
  /** Reactive-run producer (the server-side bridge sends here too;
   *  the control plane keeps it bound for future use cases like
   *  re-broadcasting from the webhook flow). */
  REACTIVE_RUN_QUEUE?: QueueProducer;
  /** Scheduled-poll producer. Bound for DLQ replay (T-084) — when
   *  an operator replays a `myme-scheduled-poll-${env}-dlq` message,
   *  it gets re-enqueued onto this main queue via the producer
   *  binding. Not used on hot paths today. */
  SCHEDULED_POLL_QUEUE?: QueueProducer;
  /** Short-lived idempotency cache keyed by `${webhook_id}:${delivery_id}`. */
  IDEMPOTENCY_KV?: KVNamespace;

  // ---- Service bindings to per-Integration Workers --------------------
  /**
   * Service bindings to each in-tree Integration Worker. The control
   * plane uses these to call `/arm-schedule` on a connection's per-
   * Integration Worker at install time and `/verify` (T-082) for the
   * synchronous operator-debug dispatch. Bound by integration name in
   * `wrangler.control.toml`. New integrations need a new binding.
   *
   * **Bounded-set assumption (T-082).** This per-integration binding
   * pattern works for the in-tree set declared in `wrangler.control.toml`
   * — small, stable, low maintenance cost. It does NOT scale to
   * community-published integrations from a future marketplace where
   * runtime-control can't pre-declare bindings for arbitrary third-party
   * Workers. Marketplace integrations will need a different dispatch
   * path (HTTP fetch via Workers Platform service URLs, or a queue-
   * mediated sync polling pattern). The arm-schedule + verify routes
   * surface `no_service_binding` (503) for missing entries so this
   * limitation is visible at the call site rather than buried.
   *
   * The binding is optional at the type level so the Worker can boot
   * before all integrations are deployed; routes that reach for a
   * missing binding return 503 with a clear reason.
   */
  INTEGRATION_RSS_WATCHER?: ServiceBinding;
  INTEGRATION_GITHUB_WEBHOOKS?: ServiceBinding;
  INTEGRATION_TASK_AUTO_ARCHIVE?: ServiceBinding;
  INTEGRATION_GOOGLE_CALENDAR?: ServiceBinding;
  INTEGRATION_GOOGLE_TASKS?: ServiceBinding;
  INTEGRATION_GOOGLE_DRIVE?: ServiceBinding;
  INTEGRATION_GOOGLE_CONTACTS?: ServiceBinding;
  INTEGRATION_GOOGLE_YOUTUBE?: ServiceBinding;
  INTEGRATION_TODOIST_TASKS?: ServiceBinding;
  INTEGRATION_READWISE?: ServiceBinding;
  INTEGRATION_RAINDROP?: ServiceBinding;
  INTEGRATION_MYMEHQ_INBOX?: ServiceBinding;
}

/** Subset of Cloudflare's Fetcher binding (service binding) we use. */
interface ServiceBinding {
  fetch(request: Request): Promise<Response>;
}

/** Slim shape we accept for tests — the real Cloudflare QueueProducer
 *  binding satisfies this with `send(message: T): Promise<void>`. */
interface QueueProducer {
  send(
    body: unknown,
    opts?: { contentType?: "json" | "text" | "v8" },
  ): Promise<void>;
}
