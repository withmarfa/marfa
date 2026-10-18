import {
  ErrorCode,
  MarfaError,
  getTypeSchema,
  hasBoundedLifecycle,
  listTypes,
  type Item,
} from "@withmarfa/shared";
import { yieldBulkWork } from "../bulk-actions/yield.js";
import { log } from "../middleware/logger.js";
import { errorMessage } from "../error-text.js";
import * as clock from "../clock.js";
import { runAuditedTransaction } from "./audited-transaction.js";
import { planCascadeDelete } from "./edge-cascade.js";
import type { Storage } from "./interface.js";
import { writeItem } from "./item-write.js";
import { isConnectionLostError } from "./job-tick.js";
import { resolveRetentionPolicy } from "./policy.js";

const MS_PER_DAY = 86_400_000;

/** The most items one transaction moves to the bin. */
const CHUNK_SIZE = 100;

/** A type's window: whole days, no window, or a chain that cannot be read. */
type Window = number | "none" | "unresolvable";

interface Chunk {
  moved: number;
  held: number;
  itemIds: string[];
  before: string;
  /** The last row read, where the next chunk starts. */
  last: { created_at: string; id: string } | undefined;
  /** Fewer rows than a full chunk came back. */
  done: boolean;
}

/**
 * Moves feed items that have outlived their type's `retention_policy` to the
 * bin, through the write a delete uses, so every reader sees an ordinary
 * move to the bin: the audit, the events and the bin's cascade rules. The
 * trash purge then deletes them for good at its own retention.
 *
 * An item is expired when it is an active feed item of a type whose resolved
 * `feed_days` has fully passed since `created_at`. An archived item, a
 * library item and an item brought back from the bin are never expired, nor
 * is an item whose type is no longer registered or whose inheritance chain
 * cannot be resolved.
 *
 * **A cascade never carries away what is not itself expired.** Binning a
 * parent also bins the items its `cascade` edges reach. The job moves an item
 * only when everything that reaches is already in the bin or is an expired
 * feed item itself, and counts the item as held otherwise. A `block` edge
 * holds an item the same way, as it refuses a delete.
 */
export class FeedExpirer {
  constructor(private storage: Storage) {}

  /** One sweep. Reports the items moved to the bin, those a cascade took with
   *  them included, the expired items held
   *  back, the types that have a window, and the types skipped because
   *  their chain cannot be resolved. */
  async runOnce(): Promise<{
    moved: number;
    held: number;
    types: number;
    unresolvable: number;
  }> {
    let moved = 0;
    let held = 0;
    let types = 0;
    let unresolvable = 0;

    for (const { id: type } of listTypes()) {
      const window = windowOf(type);
      if (window === "unresolvable") {
        unresolvable += 1;
        log(
          "warn",
          `Feed expiry skipped the items of type "${type}": its inheritance chain cannot be resolved`,
          { type_id: type },
        );
        continue;
      }
      if (window === "none") continue;
      types += 1;

      let after: Chunk["last"];
      for (;;) {
        // A read outside any transaction decides whether a write is worth
        // opening. The transaction reads the window and the rows again.
        const cutoff = cutoffOf(window);
        const peek = await this.storage.items.listExpiredFeed(
          type,
          cutoff,
          after,
          1,
        );
        if (peek.length === 0) break;

        const chunk = await runAuditedTransaction(
          this.storage,
          () => this.expireChunk(type, after),
          (result) =>
            result.moved > 0
              ? {
                  action: "items.feed_expired",
                  resource_type: "item",
                  client_ip: null,
                  details: {
                    type,
                    before: result.before,
                    moved: result.moved,
                    item_ids: result.itemIds,
                  },
                }
              : null,
        );
        moved += chunk.moved;
        held += chunk.held;
        if (chunk.done || chunk.last === undefined) break;
        after = chunk.last;
        await yieldBulkWork();
      }
    }

    if (moved > 0) log("info", "Feed expiry", { moved, held });
    return { moved, held, types, unresolvable };
  }

  /** One bounded chunk, judged on the types and rows as they stand inside
   *  the transaction that writes it. */
  private async expireChunk(
    type: string,
    after: Chunk["last"],
  ): Promise<Chunk> {
    const window = windowOf(type);
    const none: Chunk = {
      moved: 0,
      held: 0,
      itemIds: [],
      before: "",
      last: undefined,
      done: true,
    };
    if (typeof window !== "number") return none;
    const before = cutoffOf(window);
    const rows = await this.storage.items.listExpiredFeed(
      type,
      before,
      after,
      CHUNK_SIZE,
    );

    // Every row the chunk put in the bin, the ones a cascade took included.
    const itemIds = new Set<string>();
    let held = 0;
    for (const { id } of rows) {
      try {
        // A row an earlier one in this chunk took with it is already there.
        if (!(await this.storage.items.get(id))) continue;
        if (await this.heldBack(id)) {
          held += 1;
          continue;
        }
        const result = await writeItem(
          this.storage,
          { kind: "platform", by: null },
          { op: "delete", id },
        );
        if (result.outcome === "moved") {
          itemIds.add(id);
          for (const taken of result.trashed) itemIds.add(taken.id);
        }
      } catch (err) {
        this.storage.assertTransactionUsable();
        if (isConnectionLostError(err)) throw err;
        held += 1;
        log("error", "Feed expiry error", {
          item_id: id,
          error: errorMessage(err),
        });
      }
    }
    return {
      moved: itemIds.size,
      held,
      itemIds: [...itemIds],
      before,
      last: rows.at(-1),
      done: rows.length < CHUNK_SIZE,
    };
  }

  /** Whether binning `id` would take something that is not expired. */
  private async heldBack(id: string): Promise<boolean> {
    let reached: string[];
    try {
      reached = await planCascadeDelete(this.storage.edges, id);
    } catch (err) {
      if (
        err instanceof MarfaError &&
        err.code === ErrorCode.EDGE_CONSTRAINT_VIOLATION
      ) {
        return true;
      }
      throw err;
    }
    const others = reached.filter((reachedId) => reachedId !== id);
    if (others.length === 0) return false;

    const rows = await this.storage.items.getMany(others, {
      includeTrashed: true,
    });
    const restored = await this.storage.items.restoredAtOf(others);
    for (const other of others) {
      const row = rows.get(other);
      if (!row || row.state === "trashed") continue;
      if (restored.has(other) || !isExpired(row)) return true;
    }
    return false;
  }
}

/** The window of `type` as the registry resolves it now. */
function windowOf(type: string): Window {
  // A platform record has no feed tier and its own lifecycle.
  if (hasBoundedLifecycle(type)) return "none";
  try {
    const days = resolveRetentionPolicy(type, (typeId) =>
      getTypeSchema(typeId),
    )?.feed_days;
    return typeof days === "number" ? days : "none";
  } catch (error) {
    if (
      error instanceof MarfaError &&
      error.code === ErrorCode.TYPE_CHAIN_UNRESOLVABLE
    ) {
      return "unresolvable";
    }
    throw error;
  }
}

/** The instant before which an item has outlived `days`. */
function cutoffOf(days: number): string {
  return new Date(clock.nowMs() - days * MS_PER_DAY).toISOString();
}

/** Whether `item` is an active feed item past its own type's window. */
function isExpired(item: Item): boolean {
  if (item.tier !== "feed" || item.state !== "active") return false;
  const window = windowOf(item.type);
  return typeof window === "number" && item.created_at < cutoffOf(window);
}
