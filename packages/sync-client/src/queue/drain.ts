/**
 * Drain loop. Pulls one mutation at a time from `MutationQueue`, sends
 * it via `@mymehq/sdk`, classifies the result, and either removes or
 * retries. Backoff on transient errors mirrors the Swift SDK schedule
 * (1–30s with ±20% jitter via `nextReconnectDelay`).
 *
 * The drain loop is *cooperative*: it doesn't burn CPU when idle. It
 * runs via `setTimeout` ticks; each tick processes one mutation if
 * available, then schedules itself. Calling `wake()` short-circuits
 * the wait — the queue does this on `enqueue`.
 */

import type { MymeClient } from "@mymehq/sdk";
import type { MutationQueue, QueueRow } from "./queue.js";
import type {
  MutationPayload,
  CreateItemPayload,
  UpdateItemPayload,
  IdPayload,
  TransitionItemPayload,
  CreateEdgePayload,
  UpdateEdgePayload,
  SetMetadataPayload,
  MergeMetadataPayload,
  TagPayload,
  RemoveTagPayload,
  SetExtensionPayload,
  DeleteExtensionPayload,
} from "./mutations.js";
import type { SyncEventEmitter } from "../events/emitter.js";
import type { SyncLogger } from "../config.js";
import { nextReconnectDelay } from "../sync/reconnect.js";

const PERMANENT_STATUSES = new Set([400, 403, 404]);
const POLL_INTERVAL_MS = 250;

export interface DrainOptions {
  queue: MutationQueue;
  sdk: MymeClient;
  emitter: SyncEventEmitter;
  logger: SyncLogger;
  /**
   * Hook so the drain loop can stamp the current `write_id` onto the
   * SDK's outbound fetch as `Idempotency-Key`. The client.ts owns the
   * SDK construction and provides a closure-backed setter; tests
   * supply a no-op.
   */
  setCurrentWriteId: (writeId: string | null) => void;
  /** Optional override for `setTimeout` (used in tests). */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  /** Optional override for `clearTimeout`. */
  clearTimeoutFn?: (handle: unknown) => void;
}

export class DrainLoop {
  private readonly options: DrainOptions;
  private running = false;
  private pendingTick: unknown = null;
  private wakeResolver: (() => void) | null = null;

  constructor(options: DrainOptions) {
    this.options = options;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.pendingTick !== null) {
      const clear = this.options.clearTimeoutFn ?? clearTimeout;
      clear(this.pendingTick as Parameters<typeof clearTimeout>[0]);
      this.pendingTick = null;
    }
    this.wakeResolver?.();
    this.wakeResolver = null;
  }

  /**
   * Notify the drain loop to process pending mutations now rather than
   * waiting for the next scheduled tick. Called by the items API on
   * every `enqueue`.
   */
  wake(): void {
    if (!this.running) return;
    if (this.pendingTick !== null) {
      const clear = this.options.clearTimeoutFn ?? clearTimeout;
      clear(this.pendingTick as Parameters<typeof clearTimeout>[0]);
      this.pendingTick = null;
    }
    void this.tick();
  }

  /** One pass: pull a mutation, send it, schedule the next. */
  private async tick(): Promise<void> {
    if (!this.running) return;

    let row: QueueRow | null;
    try {
      row = await this.options.queue.takeNext();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.error("queue takeNext failed", { message });
      this.scheduleNextTick(POLL_INTERVAL_MS);
      return;
    }

    if (!row) {
      // Idle — schedule a soft re-check.
      this.scheduleNextTick(POLL_INTERVAL_MS);
      return;
    }

    const parsed = parsePayload(row);
    if (!parsed) {
      this.options.logger.error("queue row has unparseable payload", {
        write_id: row.write_id,
      });
      await this.options.queue.remove(row.write_id);
      this.scheduleNextTick(0);
      return;
    }

    this.options.setCurrentWriteId(row.write_id);
    try {
      await this.send(parsed, row.write_id);
      await this.options.queue.remove(row.write_id);
      this.options.emitter.emit("mutation.confirmed", {
        id: row.write_id,
        kind: parsed.kind,
        enqueuedAt: new Date(row.created_at),
      });
    } catch (error) {
      const status = errorStatus(error);
      const message = error instanceof Error ? error.message : String(error);

      if (status !== null && PERMANENT_STATUSES.has(status)) {
        // Permanent failure — drop the mutation, cascade if needed.
        await this.options.queue.remove(row.write_id);
        this.options.emitter.emit("mutation.rejected", {
          id: row.write_id,
          kind: parsed.kind,
          enqueuedAt: new Date(row.created_at),
          error: { code: errorCode(error) ?? "permanent_error", message },
          localValue: parsed.payload,
          attempts: row.attempt_count + 1,
        });
        if (parsed.kind === "createItem" && row.target_id) {
          const dropped = await this.options.queue.cascadeDrop(row.target_id);
          for (const id of dropped) {
            this.options.emitter.emit("mutation.dropped", {
              id,
              kind: "createItem",
              enqueuedAt: new Date(row.created_at),
              reason: "cascade",
            });
          }
        }
        this.scheduleNextTick(0);
        return;
      }

      // Transient — record failure, back off, retry.
      await this.options.queue.recordFailure(row.write_id, message);
      const delay = nextReconnectDelay(row.attempt_count + 1);
      this.options.logger.warn("queue mutation failed; retrying", {
        write_id: row.write_id,
        attempts: row.attempt_count + 1,
        delay_ms: delay,
        message,
      });
      this.scheduleNextTick(delay);
    } finally {
      this.options.setCurrentWriteId(null);
    }
  }

  private scheduleNextTick(delayMs: number): void {
    if (!this.running) return;
    const setT =
      this.options.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.pendingTick = setT(() => {
      this.pendingTick = null;
      void this.tick();
    }, delayMs);
  }

  /** Dispatch a parsed payload via the SDK. Throws on rejection. */
  private async send(
    mutation: MutationPayload,
    writeId: string,
  ): Promise<void> {
    const idem: { headers: { "Idempotency-Key": string } } = {
      headers: { "Idempotency-Key": writeId },
    };
    void idem; // The SDK doesn't currently expose a per-call header
    // override; the Idempotency-Key header is set via a fetch wrapper
    // configured at SDK construction (see client.ts). Calling sites
    // therefore don't need to thread the header explicitly — the
    // wrapper picks up `writeId` from the queued mutation. This
    // comment leaves the convention visible.

    const sdk = this.options.sdk;
    switch (mutation.kind) {
      case "createItem": {
        const p = mutation.payload as CreateItemPayload;
        await sdk.items.create(p.input);
        return;
      }
      case "updateItem": {
        const p = mutation.payload as UpdateItemPayload;
        await sdk.items.update(p.id, p.properties, {
          expectedVersion: p.expectedVersion,
          library: p.library,
          type: p.type,
        });
        return;
      }
      case "deleteItem": {
        const p = mutation.payload as IdPayload;
        await sdk.items.delete(p.id);
        return;
      }
      case "restoreItem": {
        const p = mutation.payload as IdPayload;
        await sdk.items.restore(p.id);
        return;
      }
      case "transitionItem": {
        const p = mutation.payload as TransitionItemPayload;
        await sdk.items.transition(p.id, p.state);
        return;
      }
      case "purgeItem": {
        const p = mutation.payload as IdPayload;
        await sdk.items.purge(p.id);
        return;
      }
      case "createEdge": {
        const p = mutation.payload as CreateEdgePayload;
        await sdk.edges.create(p.input);
        return;
      }
      case "updateEdge": {
        const p = mutation.payload as UpdateEdgePayload;
        await sdk.edges.update(p.id, p.properties);
        return;
      }
      case "deleteEdge": {
        const p = mutation.payload as IdPayload;
        await sdk.edges.delete(p.id);
        return;
      }
      case "setMetadata": {
        const p = mutation.payload as SetMetadataPayload;
        await sdk.metadata.set(p.itemId, { tags: p.tags });
        return;
      }
      case "mergeMetadata": {
        const p = mutation.payload as MergeMetadataPayload;
        await sdk.metadata.merge(p.itemId, { tags: p.tags });
        return;
      }
      case "addTags": {
        const p = mutation.payload as TagPayload;
        await sdk.metadata.addTags(p.itemId, p.tags);
        return;
      }
      case "removeTag": {
        const p = mutation.payload as RemoveTagPayload;
        await sdk.metadata.removeTag(p.itemId, p.tag);
        return;
      }
      case "setExtension": {
        const p = mutation.payload as SetExtensionPayload;
        await sdk.metadata.setExtension(p.itemId, p.namespace, p.data);
        return;
      }
      case "deleteExtension": {
        const p = mutation.payload as DeleteExtensionPayload;
        await sdk.metadata.deleteExtension(p.itemId, p.namespace);
        return;
      }
    }
  }
}

function parsePayload(row: QueueRow): MutationPayload | null {
  try {
    const parsed = JSON.parse(row.payload) as MutationPayload["payload"];
    return { kind: row.kind, payload: parsed } as MutationPayload;
  } catch {
    return null;
  }
}

interface ErrorWithStatus {
  status?: number;
  code?: string;
  message?: string;
}

function errorStatus(error: unknown): number | null {
  if (typeof error === "object" && error !== null) {
    const e = error as ErrorWithStatus;
    if (typeof e.status === "number") return e.status;
  }
  return null;
}

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null) {
    const e = error as ErrorWithStatus;
    if (typeof e.code === "string") return e.code;
  }
  return null;
}
