/**
 * Per-Connection state core — runtime-agnostic helpers for the hot
 * state a single Connection holds while it's running:
 *
 *   - cursor:<trigger_key>          — opaque per-trigger cursor
 *   - pending_write:<external_id>   — echo-suppression entries
 *   - idem:<delivery_id>            — bounded ring of recent
 *                                      external_delivery_ids
 *   - error:<index>                 — bounded ring of recent failures
 *   - retry:<key>                   — per-failing-target retry state
 *   - next_run_at_ms                — alarm() target
 *   - schedule_disarmed             — tombstone: schedule deliberately
 *                                     not armed
 *   - runtime_credential_cached     — short-TTL RuntimeCredential
 *
 * This file holds the storage adapter shape, the state methods, and
 * constants. The server's integration runtime wires the core against
 * its own storage adapter.
 */
import type { CursorStorageAdapter } from "./cursor-store.js";
import type { RuntimeCredential } from "./types.js";

export const IDEMPOTENCY_WINDOW_SIZE = 1024;
export const RECENT_ERRORS_SIZE = 32;

const SCHEDULE_DISARMED_KEY = "schedule_disarmed";
const NEXT_RUN_AT_KEY = "next_run_at_ms";

interface RecordedError {
  at: number;
  message: string;
  attempt: number;
}

/**
 * Tombstone written when a Connection's schedule is deliberately taken
 * down (uninstall, or the runtime discovering the Connection is gone).
 * Its presence — not the absence of a stored alarm — is what stops the
 * schedule re-arming, so a tick already in flight when the teardown
 * landed cannot resurrect it.
 */
export interface ScheduleDisarmRecord {
  at: number;
  reason: string;
}

export interface PerConnectionInternalState {
  // DurableObjectStorage on Cloudflare; Postgres-backed or in-memory in
  // the local runtime / tests. list() is optional — only the echo prune
  // helpers use it.
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
    await this.state.storage.put(NEXT_RUN_AT_KEY, ms);
  }

  async getNextRunAt(): Promise<number | null> {
    const raw = await this.state.storage.get(NEXT_RUN_AT_KEY);
    return typeof raw === "number" ? raw : null;
  }

  async clearNextRunAt(): Promise<void> {
    await this.state.storage.delete(NEXT_RUN_AT_KEY);
  }

  // ---- schedule disarm tombstone ---------------------------------------
  async getScheduleDisarmed(): Promise<ScheduleDisarmRecord | null> {
    const raw = await this.state.storage.get(SCHEDULE_DISARMED_KEY);
    return raw ? (raw as ScheduleDisarmRecord) : null;
  }

  async setScheduleDisarmed(reason: string): Promise<void> {
    const record: ScheduleDisarmRecord = { at: Date.now(), reason };
    await this.state.storage.put(SCHEDULE_DISARMED_KEY, record);
  }

  async clearScheduleDisarmed(): Promise<void> {
    await this.state.storage.delete(SCHEDULE_DISARMED_KEY);
  }
}
