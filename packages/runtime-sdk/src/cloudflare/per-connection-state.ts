/**
 * Cloudflare Durable Object subclass that wires `PerConnectionStateCore`
 * to a real `DurableObjectState`.
 *
 * Per-Integration Workers bind this class via:
 *
 *   [[durable_objects.bindings]]
 *   name = "PER_CONNECTION_STATE"
 *   class_name = "PerConnectionState"
 *
 *   [[migrations]]
 *   tag = "v1"
 *   new_sqlite_classes = ["PerConnectionState"]
 *
 * The Worker exports this class from its top-level entrypoint; the
 * Cloudflare runtime instantiates one per `idFromName(connection_id)`.
 *
 * This file is part of the `@withmarfa/runtime-sdk/cloudflare` subpath —
 * the substrate-specific surface that imports Workers types
 * (`DurableObject`, `DurableObjectState`, `Queue`). The runtime-agnostic
 * `PerConnectionStateCore` lives at the root `@withmarfa/runtime-sdk`
 * entry and is reused by the local-runtime substrate without any
 * Cloudflare type dependency.
 */
import { computeNextRunAt } from "../cron.js";
import {
  PerConnectionStateCore,
  type PerConnectionInternalState,
} from "../per-connection-state.js";
import type { ScheduleMessage } from "../types.js";

/**
 * Per-Worker env shape consumed by the DO's alarm + arm-schedule
 * paths. Vars come from `wrangler.toml [vars]`; the queue producer
 * is bound via `[[queues.producers]]`.
 *
 * `MANIFEST_CRON` and `SCHEDULED_POLL_QUEUE` are absent for
 * webhook-only integrations — the DO degrades gracefully (alarm()
 * becomes a no-op; arm-schedule returns no_schedule).
 */
export interface PerConnectionAlarmEnv {
  INTEGRATION_NAME: string;
  MANIFEST_CRON?: string;
  SCHEDULED_POLL_QUEUE?: Queue<ScheduleMessage>;
}

export class PerConnectionState implements DurableObject {
  private readonly core: PerConnectionStateCore;
  private readonly state: DurableObjectState;
  private readonly env: PerConnectionAlarmEnv;

  constructor(state: DurableObjectState, env: PerConnectionAlarmEnv) {
    this.state = state;
    this.env = env;
    const internal: PerConnectionInternalState = {
      storage: state.storage,
    };
    this.core = new PerConnectionStateCore(internal);
  }

  /** Default fetch handler. Routes:
   *   - POST /arm-schedule  → arm or re-arm the schedule alarm
   *   - POST /storage?op=...&key=... → KV proxy for the queue-consumer
   *     isolate (the consumer runs in the Worker, not the DO; it
   *     proxies cursor / idempotency / echo storage through this
   *     route)
   *   - GET  /              → small JSON dump of state for debugging
   *
   *  Production traffic (queue messages) flows through the integration
   *  Worker's `queue` handler. The Worker uses /storage to read &
   *  mutate per-Connection state; alarm scheduling is local to the DO. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/arm-schedule" && request.method === "POST") {
      const next_run_at_ms = await this.armSchedule();
      return Response.json({ ok: true, next_run_at_ms });
    }
    if (url.pathname === "/storage" && request.method === "POST") {
      return this.handleStorage(request, url);
    }
    const credential = await this.core.getRuntimeCredential();
    const errors = await this.core.listRecentErrors();
    const next_run_at_ms = await this.core.getNextRunAt();
    return Response.json({
      ok: true,
      credential_cached: credential !== null,
      recent_errors: errors.length,
      next_run_at_ms,
    });
  }

  private async handleStorage(request: Request, url: URL): Promise<Response> {
    const op = url.searchParams.get("op");
    const key = url.searchParams.get("key");
    if (!op || !key) {
      return Response.json(
        { ok: false, reason: "missing_op_or_key" },
        { status: 400 },
      );
    }
    if (op === "get") {
      const value = await this.state.storage.get(key);
      return Response.json({ ok: true, value: value ?? null });
    }
    if (op === "put") {
      const body: { value: unknown } = await request.json();
      await this.state.storage.put(key, body.value);
      return Response.json({ ok: true });
    }
    if (op === "delete") {
      await this.state.storage.delete(key);
      return Response.json({ ok: true });
    }
    return Response.json({ ok: false, reason: "unknown_op" }, { status: 400 });
  }

  /**
   * Compute the next run from the manifest cron and call setAlarm.
   * Idempotent — re-arming an already-armed alarm just updates the
   * target. Returns the next-run timestamp (or null if the integration
   * has no schedule trigger).
   */
  async armSchedule(): Promise<number | null> {
    if (!this.env.MANIFEST_CRON) return null;
    const next = computeNextRunAt(this.env.MANIFEST_CRON, Date.now());
    await this.state.storage.setAlarm(next);
    await this.core.setNextRunAt(next);
    return next;
  }

  /**
   * Cloudflare invokes this when the wall-clock reaches the alarm
   * target. Enqueue a ScheduleMessage onto the per-Integration
   * scheduled-poll queue, then re-arm for the next cron tick.
   *
   * Webhook-only integrations (no MANIFEST_CRON or no queue binding)
   * no-op safely — the alarm shouldn't have fired in that case, but
   * defensive behaviour costs nothing.
   */
  async alarm(): Promise<void> {
    if (!this.env.MANIFEST_CRON || !this.env.SCHEDULED_POLL_QUEUE) {
      return;
    }
    const connectionId = this.state.id.name ?? this.state.id.toString();
    const message: ScheduleMessage = {
      kind: "schedule",
      integration_name: this.env.INTEGRATION_NAME,
      connection_id: connectionId,
      scheduled_for_ms: Date.now(),
    };
    await this.env.SCHEDULED_POLL_QUEUE.send(message);
    const next = computeNextRunAt(this.env.MANIFEST_CRON, Date.now());
    await this.state.storage.setAlarm(next);
    await this.core.setNextRunAt(next);
  }
}
