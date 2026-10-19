import { setImmediate } from "node:timers/promises";
import { runInBackground } from "../background-context.js";
import * as clock from "../clock.js";
import type { Storage } from "./interface.js";
import { withoutWriteWait } from "./sqlite/connection.js";

const WINDOW_MS = 3_600_000;
const RETRY_MS = 1_000;
const CACHE_MAX = 32_768;
const PENDING_MAX = 128;

interface Use {
  id: string;
  at: string;
  elapsed: number;
}

class KeyUsage {
  private readonly cache = new Map<string, number>();
  private readonly pending = new Map<string, Use>();
  private running: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly storage: Storage) {}

  record(id: string): void {
    const elapsed = clock.monotonicMs();
    const until = this.cache.get(id);
    if (
      this.closed ||
      this.pending.has(id) ||
      (until !== undefined && elapsed <= until) ||
      this.pending.size >= PENDING_MAX
    )
      return;
    this.pending.set(id, { id, at: clock.now().toISOString(), elapsed });
    this.running ??= runInBackground(async () => {
      try {
        while (this.pending.size) {
          // Yield outside every request's authority, read view and writer.
          await setImmediate();
          const use = this.pending.values().next().value;
          if (!use) break;
          let until = use.elapsed + WINDOW_MS;
          try {
            await withoutWriteWait(() =>
              this.storage.keys.updateLastUsed(use.id, use.at),
            );
          } catch {
            // Usage is observational. A later request retries a failed stamp;
            // neither a held writer nor a broken store keeps a worker waiting.
            until = clock.monotonicMs() + RETRY_MS;
          }
          this.pending.delete(use.id);
          this.cache.delete(use.id);
          this.cache.set(use.id, until);
          if (this.cache.size > CACHE_MAX) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) this.cache.delete(oldest);
          }
        }
      } finally {
        this.running = undefined;
      }
    });
  }

  async drain(close: boolean): Promise<void> {
    if (close) this.closed = true;
    await this.running;
  }
}

const writers = new WeakMap<Storage, KeyUsage>();

export function recordKeyUsage(storage: Storage, id: string): void {
  let writer = writers.get(storage);
  if (!writer) {
    writer = new KeyUsage(storage);
    writers.set(storage, writer);
  }
  writer.record(id);
}

export async function drainKeyUsage(
  storage: Storage,
  close = false,
): Promise<void> {
  await writers.get(storage)?.drain(close);
}
