/**
 * Per-Connection Durable Object — owns the runtime hot state for a
 * single Connection. One DO instance per Connection ID per Integration
 * (the integration Worker namespaces its own DO binding by class
 * name).
 *
 * State (DO storage, KV-shaped):
 *   - cursor:<trigger_key>          — opaque per-trigger cursor
 *   - pending_write:<external_id>   — echo-suppression entries
 *   - idem:<delivery_id>            — bounded ring of recent
 *                                      external_delivery_ids
 *   - error:<index>                 — bounded ring of recent failures
 *   - retry:<key>                   — per-failing-target retry state
 *   - next_run_at_ms                — alarm() target
 *   - runtime_credential_cached     — short-TTL RuntimeCredential
 *
 * `alarm()` runs scheduled-poll dispatch + housekeeping (echo prune,
 * idempotency-window decay).
 */
import { computeNextRunAt } from "./cron.js";
import type { CursorStorageAdapter } from "./cursor-store.js";
import type { RuntimeCredential, ScheduleMessage } from "./types.js";

export const IDEMPOTENCY_WINDOW_SIZE = 1024;
export const RECENT_ERRORS_SIZE = 32;

interface RecordedError {
  at: number;
  message: string;
  attempt: number;
}

export interface PerConnectionInternalState {
  // Storage adapter — DurableObjectStorage in production; in-memory in
  // tests. The adapter satisfies CursorStorageAdapter (a subset of
  // DurableObjectStorage). list() is optional and only used by the
  // echo prune helpers in PR 5+.
  storage: CursorStorageAdapter & {
    list?: (options: {
      prefix?: string;
      limit?: number;
    }) => Promise<Map<string, unknown>>;
  };
}

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

export class PerConnectionStateCore {
  constructor(private readonly state: PerConnectionInternalState) {}

  // ---- runtime credential cache ---------------------------------------
  async getRuntimeCredential(): Promise<RuntimeCredential | null> {
    const raw = await this.state.storage.get("runtime_credential_cached");
    if (!raw) return null;
    const cached = raw as RuntimeCredential;
    if (new Date(cached.expires_at).getTime() <= Date.now()) {
      await this.state.storage.delete("runtime_credential_cached");
      return null;
    }
    return cached;
  }

  async setRuntimeCredential(credential: RuntimeCredential): Promise<void> {
    await this.state.storage.put("runtime_credential_cached", credential);
  }

  // ---- idempotency window ---------------------------------------------
  /** Returns true if `delivery_id` was seen recently — caller should
   *  drop the duplicate. Otherwise records the id and returns false. */
  async checkAndRecordDelivery(deliveryId: string): Promise<boolean> {
    const key = `idem:${deliveryId}`;
    const seen = await this.state.storage.get(key);
    if (seen) return true;
    await this.state.storage.put(key, { at: Date.now() });
    return false;
  }

  // ---- error tail ------------------------------------------------------
  async recordError(message: string, attempt: number): Promise<void> {
    const at = Date.now();
    const counterRaw = await this.state.storage.get("error_counter");
    const counter = typeof counterRaw === "number" ? counterRaw : 0;
    const idx = counter % RECENT_ERRORS_SIZE;
    const record: RecordedError = { at, message, attempt };
    await this.state.storage.put(`error:${String(idx)}`, record);
    await this.state.storage.put("error_counter", counter + 1);
  }

  async listRecentErrors(): Promise<RecordedError[]> {
    const errors: RecordedError[] = [];
    for (let i = 0; i < RECENT_ERRORS_SIZE; i++) {
      const raw = await this.state.storage.get(`error:${String(i)}`);
      if (raw) errors.push(raw as RecordedError);
    }
    errors.sort((a, b) => b.at - a.at);
    return errors;
  }

  // ---- alarm scheduling -----------------------------------------------
  async setNextRunAt(ms: number): Promise<void> {
    await this.state.storage.put("next_run_at_ms", ms);
  }

  async getNextRunAt(): Promise<number | null> {
    const raw = await this.state.storage.get("next_run_at_ms");
    return typeof raw === "number" ? raw : null;
  }
}

/**
 * Cloudflare Durable Object subclass that wires PerConnectionStateCore
 * to a real DurableObjectState.
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
 */
export class PerConnectionState implements DurableObject {
  private readonly core: PerConnectionStateCore;
  private readonly state: DurableObjectState;
  private readonly env: PerConnectionAlarmEnv;

  constructor(state: DurableObjectState, env: PerConnectionAlarmEnv) {
    this.state = state;
    this.env = env;
    this.core = new PerConnectionStateCore({
      storage: state.storage as unknown as CursorStorageAdapter,
    });
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
    return Response.json(
      { ok: false, reason: "unknown_op" },
      { status: 400 },
    );
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
