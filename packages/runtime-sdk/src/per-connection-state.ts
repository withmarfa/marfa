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
 *   - runtime_credential_cached     — short-TTL RuntimeCredential
 *
 * This file holds only the substrate-agnostic surface — the storage
 * adapter shape, the state methods, and constants. The Cloudflare
 * Durable Object subclass that wires this into Workers state lives at
 * `@withmarfa/runtime-sdk/cloudflare`. The Node/Postgres-backed local
 * runtime wires the same core against its own storage adapter.
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
    await this.state.storage.put("next_run_at_ms", ms);
  }

  async getNextRunAt(): Promise<number | null> {
    const raw = await this.state.storage.get("next_run_at_ms");
    return typeof raw === "number" ? raw : null;
  }
}
