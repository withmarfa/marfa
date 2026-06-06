/**
 * Cloudflare Queues HTTP-pull client.
 *
 * The runtime-control Worker uses producer **bindings** for the hot
 * paths (webhook receipt, reactive run). For DLQ inspection /
 * replay we need to read messages without registering as a queue
 * consumer — Cloudflare's account-scoped HTTP-pull API is the right
 * substrate. No consumer binding required; the operator-debug routes
 * pull on demand.
 *
 * API surface:
 *   - POST /accounts/{account_id}/queues/{queue_id}/messages/pull
 *     body: { batch_size, visibility_timeout_ms }
 *   - POST /accounts/{account_id}/queues/{queue_id}/messages/ack
 *     body: { acks: [{ lease_id }] }
 *
 * Auth: account-scoped Bearer token (`CLOUDFLARE_QUEUES_API_TOKEN`).
 * Required scopes: `queues_read` + `queues_write`.
 *
 * Queue-id resolution: the pull/ack endpoints take queue *id* (UUID),
 * not queue *name*. Names are env-suffixed
 * (e.g. `marfa-webhook-receipt-staging-dlq`); ids are stable. We
 * resolve once per Worker instance via `GET /accounts/:id/queues`
 * and cache in a module-level `Map`. Cache misses (e.g. after a
 * re-provision) refresh transparently.
 *
 * Pagination: not implemented. DLQs should be small in practice; the
 * pull API caps batches at 100 and the operator-debug surface is fine
 * with a single batch per call. If volume ever justifies it, paginate
 * in the route handler by chaining pulls until the lease window
 * empties.
 */

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

export interface CfQueuesEnv {
  CLOUDFLARE_QUEUES_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
}

export interface PulledMessage {
  /** Cloudflare's internal message id. Operators reference it on the
   *  `--message-ids` flag of replay. */
  cf_message_id: string;
  lease_id: string;
  /** Decoded body. JSON content is parsed; non-JSON falls through as
   *  the raw string. Operators see the same shape regardless of how
   *  the message was originally produced. */
  body: unknown;
  /** Producer timestamp (ms since epoch). */
  timestamp_ms: number;
  /** Delivery attempts before this pull. */
  attempts: number;
  metadata: Record<string, unknown>;
}

export interface AckResult {
  ackCount: number;
  warnings: Record<string, unknown>;
}

/** Discrete error type the route layer catches and translates into a
 *  503 with a clear reason. Distinct from upstream API errors so the
 *  caller can tell "we forgot to set the secret" apart from "Cloudflare
 *  said no". */
export class CfQueuesNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CfQueuesNotConfiguredError";
  }
}

interface ApiEnvelope<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}

interface ListQueuesItem {
  queue_id: string;
  queue_name: string;
}

interface PullResultBody {
  message_backlog_count: number;
  messages: {
    id: string;
    lease_id: string;
    body: string;
    timestamp_ms: number;
    attempts: number;
    metadata?: Record<string, unknown>;
  }[];
}

interface AckResultBody {
  ackCount: number;
  retryCount: number;
  warnings: Record<string, unknown>;
}

const queueIdCache = new Map<string, string>();

function cacheKey(accountId: string, queueName: string): string {
  return `${accountId}::${queueName}`;
}

/** Test-only — clears the queue-id cache so each test starts from a
 *  known state. Production code should never call this. */
export function _resetQueueIdCacheForTests(): void {
  queueIdCache.clear();
}

function requireConfig(env: CfQueuesEnv): {
  token: string;
  accountId: string;
} {
  if (!env.CLOUDFLARE_QUEUES_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    throw new CfQueuesNotConfiguredError(
      "CLOUDFLARE_QUEUES_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must both be set on the runtime-control Worker.",
    );
  }
  return {
    token: env.CLOUDFLARE_QUEUES_API_TOKEN,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
  };
}

async function cfRequest<T>(
  env: CfQueuesEnv,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const { token } = requireConfig(env);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
    ...init,
    headers,
  });
  const text = await res.text();
  let envelope: ApiEnvelope<T> | undefined;
  try {
    envelope = text ? (JSON.parse(text) as ApiEnvelope<T>) : undefined;
  } catch {
    // Non-JSON response — treat as failure.
  }
  if (!res.ok || !envelope?.success) {
    const detail = envelope?.errors.length
      ? JSON.stringify(envelope.errors)
      : text.slice(0, 512);
    throw new Error(
      `Cloudflare Queues API ${String(res.status)} ${res.statusText} for ${path}: ${detail}`,
    );
  }
  return envelope.result;
}

async function listQueues(env: CfQueuesEnv): Promise<ListQueuesItem[]> {
  const { accountId } = requireConfig(env);
  return cfRequest<ListQueuesItem[]>(
    env,
    `/accounts/${accountId}/queues?per_page=100`,
  );
}

/** Resolve a queue *name* (env-suffixed) to a queue *id* (UUID).
 *  Cached per-Worker-instance; cache misses re-list. Returns null
 *  if the queue doesn't exist on the account — the route layer
 *  surfaces this as a 503 / empty result, never a 500. */
export async function resolveQueueId(
  env: CfQueuesEnv,
  queueName: string,
): Promise<string | null> {
  const { accountId } = requireConfig(env);
  const key = cacheKey(accountId, queueName);
  const cached = queueIdCache.get(key);
  if (cached) return cached;

  const queues = await listQueues(env);
  for (const q of queues) {
    queueIdCache.set(cacheKey(accountId, q.queue_name), q.queue_id);
  }
  return queueIdCache.get(key) ?? null;
}

/** Pull a batch of messages from a DLQ. Messages are leased — they
 *  re-appear after `visibilityTimeoutMs` if not acked. Default
 *  visibility timeout is short (5s) so peek (which doesn't ack) lets
 *  the next operator see the same messages quickly. */
export async function pullMessages(
  env: CfQueuesEnv,
  queueId: string,
  opts: { batchSize?: number; visibilityTimeoutMs?: number } = {},
): Promise<PulledMessage[]> {
  const { accountId } = requireConfig(env);
  const result = await cfRequest<PullResultBody>(
    env,
    `/accounts/${accountId}/queues/${queueId}/messages/pull`,
    {
      method: "POST",
      body: JSON.stringify({
        batch_size: opts.batchSize ?? 50,
        visibility_timeout_ms: opts.visibilityTimeoutMs ?? 5000,
      }),
    },
  );
  return result.messages.map((m) => ({
    cf_message_id: m.id,
    lease_id: m.lease_id,
    body: decodeBody(m.body, m.metadata ?? {}),
    timestamp_ms: m.timestamp_ms,
    attempts: m.attempts,
    metadata: m.metadata ?? {},
  }));
}

/** Ack a batch of messages by lease token. Successful ack removes the
 *  message from the queue. Lease tokens expire with the message's
 *  visibility timeout — stale leases are rejected by Cloudflare. */
export async function ackMessages(
  env: CfQueuesEnv,
  queueId: string,
  leaseIds: string[],
): Promise<AckResult> {
  if (leaseIds.length === 0) {
    return { ackCount: 0, warnings: {} };
  }
  const { accountId } = requireConfig(env);
  const result = await cfRequest<AckResultBody>(
    env,
    `/accounts/${accountId}/queues/${queueId}/messages/ack`,
    {
      method: "POST",
      body: JSON.stringify({
        acks: leaseIds.map((lease_id) => ({ lease_id })),
      }),
    },
  );
  return {
    ackCount: result.ackCount,
    warnings: result.warnings,
  };
}

/** Decode the wire body. JSON content gets parsed; anything that fails
 *  to parse falls through as the raw string. Best-effort — operators
 *  see whatever the producer wrote, with the wire shape preserved. */
function decodeBody(body: string, metadata: Record<string, unknown>): unknown {
  const contentType = metadata["CF-Content-Type"];
  if (contentType === "json" || contentType === undefined) {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  return body;
}
