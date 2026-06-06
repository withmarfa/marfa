import { Hono } from "hono";
import type { ControlPlaneEnv } from "../env.js";
import { MarfaServerClient } from "../marfa-client.js";
import {
  ackMessages,
  pullMessages,
  resolveQueueId,
  CfQueuesNotConfiguredError,
  type PulledMessage,
} from "../cf-queues-pull.js";

/**
 * DLQ peek + replay routes.
 *
 *   POST /dlq/peek    body: { connection_id, since?, limit? }
 *   POST /dlq/replay  body: { connection_id, message_ids? }
 *
 * Both require a platform credential. runtime-control has no DB
 * access, so the gate is enforced by forwarding the operator's bearer
 * to the server's `GET /system/connections/:id/dlq-context` endpoint
 * (same pattern as verify.ts).
 *
 * Substrate: Cloudflare Queues HTTP-pull (`cf-queues-pull.ts`). The
 * runtime-control Worker is not registered as a queue consumer for the
 * DLQs — the pull API is account-level, no consumer binding needed.
 *
 * Replay re-enqueue: pushes to the main queue via the matching
 * producer binding (`WEBHOOK_RECEIPT_QUEUE`, `SCHEDULED_POLL_QUEUE`,
 * `REACTIVE_RUN_QUEUE`), then acks the DLQ message via lease token.
 * If `send` succeeds and `ack` fails, the message is duplicated; we
 * surface that as `skipped: { reason: "ack_failed" }` so the operator
 * can retry the ack (or accept the duplicate) deliberately.
 *
 * **At-least-once.** Replay is not idempotent across invocations. If
 * an operator passes the same `cf_message_id` twice across two replay
 * calls, and both calls find the message before it's acked, it lands
 * in the main queue twice. The CLI confirmation gate is the
 * operator-side guardrail.
 *
 * Filtering: server-side, on `body.connection_id`, after the pull.
 * The pull API doesn't filter by message contents. DLQs should be
 * small in practice — if they aren't, paginate (chain pulls) in this
 * handler.
 *
 * Cross-connection peek (admin-style "everything stuck") is not
 * currently supported.
 */

interface DlqQueueDescriptor {
  /** Logical name used to construct the env-suffixed queue name. */
  family: "webhook-receipt" | "scheduled-poll" | "reactive-run";
  dlqName: string;
  mainName: string;
  /** Producer binding for the *main* queue, used on replay. */
  mainProducer?: {
    send(
      body: unknown,
      opts?: { contentType?: "json" | "text" },
    ): Promise<void>;
  };
}

function describeDlqQueues(env: ControlPlaneEnv): DlqQueueDescriptor[] {
  const envLabel = env.ENVIRONMENT ?? "dev";
  return [
    {
      family: "webhook-receipt",
      dlqName: `marfa-webhook-receipt-${envLabel}-dlq`,
      mainName: `marfa-webhook-receipt-${envLabel}`,
      mainProducer: env.WEBHOOK_RECEIPT_QUEUE,
    },
    {
      family: "scheduled-poll",
      dlqName: `marfa-scheduled-poll-${envLabel}-dlq`,
      mainName: `marfa-scheduled-poll-${envLabel}`,
      mainProducer: env.SCHEDULED_POLL_QUEUE,
    },
    {
      family: "reactive-run",
      dlqName: `marfa-reactive-run-${envLabel}-dlq`,
      mainName: `marfa-reactive-run-${envLabel}`,
      mainProducer: env.REACTIVE_RUN_QUEUE,
    },
  ];
}

function extractConnectionId(body: unknown): string | undefined {
  if (body && typeof body === "object" && "connection_id" in body) {
    const v = (body as { connection_id?: unknown }).connection_id;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function extractFailureReason(message: PulledMessage): string | null {
  // Best-effort. CF Queues messages don't carry a first-class
  // failure-reason field, so we look in three conventional places:
  //   1. body._failure_reason as a structured object — the runtime-sdk
  //      consumer wrapper stamps this on permanent failure.
  //      Shape: `{ message, class_name, attempts, failed_at }`. We
  //      flatten to "<class>: <message> (attempts: <n>)" for the
  //      `failure_reason` string field. The full structured shape is
  //      still readable on `body._failure_reason` itself.
  //   2. body._failure_reason as a string — external producers that
  //      stamp a flat string.
  //   3. metadata.failure_reason — Cloudflare-native if it ever lands.
  // null when none of the above is present.
  if (message.body && typeof message.body === "object") {
    const v = (message.body as { _failure_reason?: unknown })._failure_reason;
    if (v && typeof v === "object") {
      const obj = v as {
        message?: unknown;
        class_name?: unknown;
        attempts?: unknown;
      };
      const msg = typeof obj.message === "string" ? obj.message : null;
      if (msg !== null) {
        const cls =
          typeof obj.class_name === "string" ? obj.class_name : "unknown";
        const attempts = typeof obj.attempts === "number" ? obj.attempts : null;
        return attempts === null
          ? `${cls}: ${msg}`
          : `${cls}: ${msg} (attempts: ${String(attempts)})`;
      }
    }
    if (typeof v === "string") return v;
  }
  const metaReason = message.metadata.failure_reason;
  if (typeof metaReason === "string") return metaReason;
  return null;
}

function bearer(c: {
  req: { header: (name: string) => string | undefined };
}): string | null {
  const auth = c.req.header("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

interface PeekResponseMessage {
  cf_message_id: string;
  body: unknown;
  enqueued_at: string;
  failure_reason: string | null;
  attempts: number;
}

export function registerDlqRoutes(
  app: Hono<{ Bindings: ControlPlaneEnv }>,
): void {
  app.post("/dlq/peek", async (c) => {
    if (!c.env.MARFA_API_URL) {
      return c.json(
        {
          error: "control_plane_misconfigured",
          message: "MARFA_API_URL must be set.",
        },
        503,
      );
    }
    const operatorBearer = bearer(c);
    if (!operatorBearer) return c.json({ error: "unauthorized" }, 401);

    let body: { connection_id?: string; since?: string; limit?: number };
    try {
      body = await c.req.json<{
        connection_id?: string;
        since?: string;
        limit?: number;
      }>();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (!body.connection_id || typeof body.connection_id !== "string") {
      return c.json({ error: "missing_field", field: "connection_id" }, 400);
    }
    const connectionId = body.connection_id;
    const limit =
      typeof body.limit === "number" && body.limit > 0
        ? Math.floor(body.limit)
        : 50;
    const sinceMs = body.since ? Date.parse(body.since) : null;
    if (body.since && (sinceMs === null || Number.isNaN(sinceMs))) {
      return c.json({ error: "invalid_since" }, 400);
    }

    const marfa = new MarfaServerClient(c.env.MARFA_API_URL, "");
    const ctx = await marfa.getDlqContext(connectionId, operatorBearer);
    if (!ctx.ok) {
      const httpStatus =
        ctx.status === 401 ||
        ctx.status === 403 ||
        ctx.status === 404 ||
        ctx.status === 400
          ? ctx.status
          : 502;
      const code =
        ctx.status === 401
          ? "unauthorized"
          : ctx.status === 403
            ? "forbidden"
            : ctx.status === 404
              ? "connection_not_found"
              : "upstream_error";
      return c.json({ error: code, message: ctx.message }, httpStatus);
    }

    const queues = describeDlqQueues(c.env);
    const matched: PeekResponseMessage[] = [];

    try {
      for (const q of queues) {
        const queueId = await resolveQueueId(c.env, q.dlqName);
        if (!queueId) continue; // queue not provisioned in this env — skip
        const messages = await pullMessages(c.env, queueId, {
          batchSize: 100,
          visibilityTimeoutMs: 5000,
        });
        for (const m of messages) {
          if (extractConnectionId(m.body) !== connectionId) continue;
          if (sinceMs !== null && m.timestamp_ms < sinceMs) continue;
          matched.push({
            cf_message_id: m.cf_message_id,
            body: m.body,
            enqueued_at: new Date(m.timestamp_ms).toISOString(),
            failure_reason: extractFailureReason(m),
            attempts: m.attempts,
          });
        }
      }
    } catch (err) {
      if (err instanceof CfQueuesNotConfiguredError) {
        return c.json(
          { error: "cf_queues_not_configured", message: err.message },
          503,
        );
      }
      return c.json(
        {
          error: "cf_queues_error",
          message: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }

    matched.sort((a, b) => (a.enqueued_at < b.enqueued_at ? 1 : -1));
    return c.json({ messages: matched.slice(0, limit) });
  });

  app.post("/dlq/replay", async (c) => {
    if (!c.env.MARFA_API_URL) {
      return c.json(
        {
          error: "control_plane_misconfigured",
          message: "MARFA_API_URL must be set.",
        },
        503,
      );
    }
    const operatorBearer = bearer(c);
    if (!operatorBearer) return c.json({ error: "unauthorized" }, 401);

    let body: { connection_id?: string; message_ids?: string[] };
    try {
      body = await c.req.json<{
        connection_id?: string;
        message_ids?: string[];
      }>();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (!body.connection_id || typeof body.connection_id !== "string") {
      return c.json({ error: "missing_field", field: "connection_id" }, 400);
    }
    const connectionId = body.connection_id;
    const requestedIds =
      Array.isArray(body.message_ids) && body.message_ids.length > 0
        ? new Set(body.message_ids.filter((s) => typeof s === "string"))
        : null;

    const marfa = new MarfaServerClient(c.env.MARFA_API_URL, "");
    const ctx = await marfa.getDlqContext(connectionId, operatorBearer);
    if (!ctx.ok) {
      const httpStatus =
        ctx.status === 401 ||
        ctx.status === 403 ||
        ctx.status === 404 ||
        ctx.status === 400
          ? ctx.status
          : 502;
      const code =
        ctx.status === 401
          ? "unauthorized"
          : ctx.status === 403
            ? "forbidden"
            : ctx.status === 404
              ? "connection_not_found"
              : "upstream_error";
      return c.json({ error: code, message: ctx.message }, httpStatus);
    }

    const replayed: string[] = [];
    const skipped: { cf_message_id: string; reason: string }[] = [];
    /** Tracks which requested ids we found in some DLQ. The diff
     *  (requested - found) is reported as `not_found`. */
    const foundIds = new Set<string>();

    const queues = describeDlqQueues(c.env);
    try {
      for (const q of queues) {
        const queueId = await resolveQueueId(c.env, q.dlqName);
        if (!queueId) continue;
        const messages = await pullMessages(c.env, queueId, {
          batchSize: 100,
          visibilityTimeoutMs: 30_000, // longer than peek; we may take time to send + ack
        });
        for (const m of messages) {
          if (extractConnectionId(m.body) !== connectionId) continue;
          if (requestedIds && !requestedIds.has(m.cf_message_id)) continue;
          foundIds.add(m.cf_message_id);

          if (!q.mainProducer) {
            skipped.push({
              cf_message_id: m.cf_message_id,
              reason: "no_main_producer_binding",
            });
            continue;
          }

          try {
            await q.mainProducer.send(m.body, { contentType: "json" });
          } catch {
            skipped.push({
              cf_message_id: m.cf_message_id,
              reason: "send_failed",
            });
            continue;
          }

          try {
            await ackMessages(c.env, queueId, [m.lease_id]);
            replayed.push(m.cf_message_id);
          } catch {
            // Send succeeded but ack failed — the message reached the
            // main queue but is still in the DLQ. Surface as skipped
            // so the operator knows to retry the ack manually.
            skipped.push({
              cf_message_id: m.cf_message_id,
              reason: "ack_failed",
            });
          }
        }
      }
    } catch (err) {
      if (err instanceof CfQueuesNotConfiguredError) {
        return c.json(
          { error: "cf_queues_not_configured", message: err.message },
          503,
        );
      }
      return c.json(
        {
          error: "cf_queues_error",
          message: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }

    if (requestedIds) {
      for (const id of requestedIds) {
        if (!foundIds.has(id)) {
          skipped.push({ cf_message_id: id, reason: "not_found" });
        }
      }
    }

    return c.json({ replayed, skipped });
  });
}
