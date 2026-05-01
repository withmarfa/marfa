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
import type { CursorStorageAdapter } from "./cursor-store.js";
import type { RuntimeCredential } from "./types.js";

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

  constructor(state: DurableObjectState, env: unknown) {
    this.core = new PerConnectionStateCore({
      storage: state.storage as unknown as CursorStorageAdapter,
    });
    void env;
  }

  /** Default fetch handler — returns a small JSON dump of state for
   *  debugging. Production traffic flows through queue messages, not
   *  HTTP-to-the-DO. */
  async fetch(request: Request): Promise<Response> {
    void request;
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

  /** Re-armed after every dispatch — the queue consumer enqueues a
   *  `scheduled-poll` message and re-arms based on manifest cadence. */
  async alarm(): Promise<void> {
    // Layer 1 PR 3 wires the producer that fires when alarm() ticks.
    // For now, alarm() existence ensures the platform recognises the
    // DO as alarm-capable.
    await Promise.resolve();
  }
}
