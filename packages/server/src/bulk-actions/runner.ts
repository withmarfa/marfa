/**
 * Per-action execution for the bulk_action worker.
 *
 * Each `run<Action>Chunk` takes a slice of matched item ids (default
 * chunk size 100) plus the action input and runs it inside one shared
 * `storage.runInTransaction`. The transaction boundary is what wins
 * the perf vs per-item transactions; the SQL inside the transaction
 * can stay per-row.
 *
 * Authorization: the worker passes the job's `space_id` explicitly
 * to every storage method. RLS, if enforced, is belt-and-braces —
 * matched_ids were resolved at job-create-time inside a request
 * context with full type-permission narrowing.
 *
 * Every chunk publishes what it wrote, on every action. The publish is
 * what appends to the event log, and the log is what a client rebuilding
 * its state replays — so a chunk that stayed quiet wrote rows no client
 * could ever learn about. The job's `enable_fanout` decides only whether
 * those events also drive outbound work, never whether they are logged.
 *
 * Each publish happens after the chunk's transaction commits, and reuses
 * the rows the writes returned rather than reading them back.
 */
import { collectBlobHashes } from "../storage/blob-utils.js";
import type { Storage } from "../storage/interface.js";
import type { Edge, Item, Metadata } from "@withmarfa/shared";
import type { BulkActionErrorEntry, BulkActionInput } from "./types.js";
import { publish, publishEdge } from "../pubsub.js";

export interface ChunkOutcome {
  succeeded: string[];
  errors: BulkActionErrorEntry[];
  /** Populated only for the `purge` action: unique blob hashes
   *  referenced by the items in this chunk. The worker unions these
   *  across chunks for the final response envelope. */
  blob_hashes?: Set<string>;
}

export interface RunChunkContext {
  storage: Storage;
  spaceId: string | null;
  /** The full BulkActionInput sent to `POST /items/bulk-actions`. */
  input: BulkActionInput;
  /** Ids the worker has assigned to this chunk. */
  ids: string[];
}

export async function runChunk(ctx: RunChunkContext): Promise<ChunkOutcome> {
  const { input } = ctx;
  switch (input.action) {
    case "transition":
      return runTransitionChunk(ctx);
    case "purge":
      return runPurgeChunk(ctx);
    case "update_tags":
      return runUpdateTagsChunk(ctx);
    case "update_tier":
      return runUpdateTierChunk(ctx);
    case "update_properties":
      return runUpdatePropertiesChunk(ctx);
    case "update_timestamp":
      return runUpdateTimestampChunk(ctx);
    default: {
      // Exhaustiveness check — discriminated union covers all six.
      const _exhaustive: never = input;
      throw new Error(
        `runChunk: unhandled action ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

async function runTransitionChunk({
  storage,
  spaceId,
  input,
  ids,
}: RunChunkContext): Promise<ChunkOutcome> {
  if (input.action !== "transition")
    throw new Error("runTransitionChunk: wrong action");
  const succeeded: string[] = [];
  const errors: BulkActionErrorEntry[] = [];
  // Collected inside the transaction and published after it commits, so a
  // subscriber is never told about a row a rollback then took away.
  const moved: Item[] = [];
  await storage.runInTransaction(async () => {
    for (const id of ids) {
      try {
        moved.push(
          await storage.items.transition(id, input.state, spaceId ?? undefined),
        );
        succeeded.push(id);
      } catch (err) {
        errors.push(toErrorEntry(id, err));
      }
    }
  });
  for (const item of moved) {
    await publish({
      type: "state_changed",
      item,
      ...(spaceId != null && { spaceId }),
      enableFanout: fansOutFor(input),
    });
  }
  return { succeeded, errors };
}

async function runPurgeChunk({
  storage,
  spaceId,
  input,
  ids,
}: RunChunkContext): Promise<ChunkOutcome> {
  const succeeded: string[] = [];
  const errors: BulkActionErrorEntry[] = [];
  const blob_hashes = new Set<string>();
  // Collected inside the transaction and announced after it, so a publish
  // that fails cannot turn a committed purge into an all-errored chunk —
  // and nothing is announced that a rollback took away.
  const cascaded: Edge[] = [];
  await storage.runInTransaction(async () => {
    // Trashed included: purge is the terminal step after a soft delete, so
    // every id it is handed is trashed. Excluding them left this map empty,
    // which sent every id down the not-found branch below while `bulkPurge`
    // deleted them anyway — and took the blob-hash collection with it, so the
    // hashes a purged item referenced were never reported for collection.
    const items = await storage.items.getMany(ids, spaceId ?? undefined, {
      includeTrashed: true,
    });
    for (const item of items.values()) {
      collectBlobHashes(item.properties, blob_hashes);
    }
    // One DELETE per direction + one DELETE on items = 3 statements
    // instead of 3 × ids.length. The two edge deletes return the rows
    // they removed, which is what the announcement below names.
    try {
      cascaded.push(
        ...(await storage.edges.deleteBySourceBatch(
          ids,
          undefined,
          spaceId ?? undefined,
        )),
        ...(await storage.edges.deleteByTargetBatch(
          ids,
          undefined,
          spaceId ?? undefined,
        )),
      );
      const purged = await storage.items.bulkPurge(ids, spaceId ?? undefined);
      // Ids in `items` were in-scope and purged; ids absent from the map
      // weren't found in the space and surface as not-found errors.
      for (const id of items.keys()) succeeded.push(id);
      const seen = new Set(items.keys());
      for (const id of ids) {
        if (!seen.has(id)) {
          errors.push({
            id,
            code: "item_not_found",
            message: "Item not found in space scope at purge time",
          });
        }
      }
      void purged;
    } catch (err) {
      // The chunk did not complete, so nothing it staged may be
      // announced.
      //
      // Unreachable as the code stands, and kept anyway: both deletes are
      // arguments to ONE `push`, so a throw from the second means the
      // push never runs and `cascaded` is still empty. Split that into
      // two statements — an ordinary-looking tidy-up — and the first
      // delete's rows are staged while the chunk reports every id as
      // errored. This line and the gate below are what make that
      // refactor safe rather than silent.
      cascaded.length = 0;
      const entry = toErrorEntry("", err);
      for (const id of ids) {
        errors.push({ id, code: entry.code, message: entry.message });
      }
    }
  });
  // Outside the transaction and outside the try, so a transient publish
  // failure cannot be recorded as a per-item error on a purge that
  // completed — and gated on the chunk having no errors, so a chunk that
  // failed announces nothing. See the `catch` above for why that gate
  // cannot fire today and is kept regardless.
  //
  // **Edges only. A purge publishes no item event**, on this door or the
  // single-item one: there is no purge event in the contract, and the
  // trash transition that precedes a purge already announced the item.
  // Inventing one here would make a bulk purge noisier than the door it
  // mirrors.
  //
  // An edge pointing AT one of these items lives on an item that is NOT
  // being purged, so nothing else tells its holder the relationship is
  // gone — which is why the cascade is announced per edge.
  if (errors.length === 0) {
    for (const edge of cascaded) {
      await publishEdge({
        type: "edge_deleted",
        edge,
        ...(spaceId != null && { spaceId }),
        enableFanout: fansOutFor(input),
      });
    }
  }
  return { succeeded, errors, blob_hashes };
}

async function runUpdateTagsChunk({
  storage,
  spaceId,
  input,
  ids,
}: RunChunkContext): Promise<ChunkOutcome> {
  if (input.action !== "update_tags")
    throw new Error("runUpdateTagsChunk: wrong action");
  const succeeded: string[] = [];
  const errors: BulkActionErrorEntry[] = [];
  const add = input.add ?? [];
  const remove = input.remove ?? [];
  // Collected inside the transaction and published after it commits, so a
  // subscriber is never told about a change a rollback took away.
  const changed = new Map<string, Metadata>();
  await storage.runInTransaction(async () => {
    for (const id of ids) {
      try {
        let metadata: Metadata | undefined;
        if (add.length > 0) {
          metadata = await storage.metadata.addTags(id, add);
        }
        for (const tag of remove) {
          metadata = await storage.metadata.removeTag(id, tag);
        }
        if (metadata) changed.set(id, metadata);
        succeeded.push(id);
      } catch (err) {
        errors.push(toErrorEntry(id, err));
      }
    }
  });
  // A tag change is a metadata-layer change, and the single-item tag doors
  // announce it as one. The item is fetched in a single batch read because
  // the tag stores return the metadata row alone.
  if (changed.size > 0) {
    const items = await storage.items.getMany(
      [...changed.keys()],
      spaceId ?? undefined,
    );
    for (const [id, metadata] of changed) {
      const item = items.get(id);
      if (!item) continue;
      await publish({
        type: "metadata_changed",
        item,
        metadata,
        ...(spaceId != null && { spaceId }),
        enableFanout: fansOutFor(input),
      });
    }
  }
  return { succeeded, errors };
}

async function runUpdateTierChunk({
  storage,
  spaceId,
  input,
  ids,
}: RunChunkContext): Promise<ChunkOutcome> {
  if (input.action !== "update_tier")
    throw new Error("runUpdateTierChunk: wrong action");
  const succeeded: string[] = [];
  const errors: BulkActionErrorEntry[] = [];
  // Collected inside the transaction, published after it commits.
  const updated: Item[] = [];
  await storage.runInTransaction(async () => {
    for (const id of ids) {
      try {
        const result = await storage.items.update(
          id,
          { tier: input.tier },
          spaceId ?? undefined,
        );
        if ("error" in result) {
          errors.push({
            id,
            code: "conflict",
            message: "Version conflict during bulk update_tier",
          });
        } else {
          updated.push(result);
          succeeded.push(id);
        }
      } catch (err) {
        errors.push(toErrorEntry(id, err));
      }
    }
  });
  await publishUpdated(updated, spaceId, input);
  return { succeeded, errors };
}

async function runUpdatePropertiesChunk({
  storage,
  spaceId,
  input,
  ids,
}: RunChunkContext): Promise<ChunkOutcome> {
  if (input.action !== "update_properties")
    throw new Error("runUpdatePropertiesChunk: wrong action");
  const succeeded: string[] = [];
  const errors: BulkActionErrorEntry[] = [];
  // Collected inside the transaction, published after it commits.
  const updated: Item[] = [];
  await storage.runInTransaction(async () => {
    for (const id of ids) {
      try {
        const result = await storage.items.update(
          id,
          { properties: input.patch },
          spaceId ?? undefined,
        );
        if ("error" in result) {
          errors.push({
            id,
            code: "conflict",
            message: "Version conflict during bulk update_properties",
          });
        } else {
          updated.push(result);
          succeeded.push(id);
        }
      } catch (err) {
        errors.push(toErrorEntry(id, err));
      }
    }
  });
  await publishUpdated(updated, spaceId, input);
  return { succeeded, errors };
}

async function runUpdateTimestampChunk({
  storage,
  spaceId,
  input,
  ids,
}: RunChunkContext): Promise<ChunkOutcome> {
  if (input.action !== "update_timestamp")
    throw new Error("runUpdateTimestampChunk: wrong action");
  const succeeded: string[] = [];
  const errors: BulkActionErrorEntry[] = [];
  // Collected inside the transaction, published after it commits.
  const updated: Item[] = [];
  await storage.runInTransaction(async () => {
    for (const id of ids) {
      try {
        const result = await storage.items.update(
          id,
          { timestamp: input.timestamp },
          spaceId ?? undefined,
        );
        if ("error" in result) {
          errors.push({
            id,
            code: "conflict",
            message: "Version conflict during bulk update_timestamp",
          });
        } else {
          updated.push(result);
          succeeded.push(id);
        }
      } catch (err) {
        errors.push(toErrorEntry(id, err));
      }
    }
  });
  await publishUpdated(updated, spaceId, input);
  return { succeeded, errors };
}

/**
 * Whether this job's events drive outbound side effects. Absent reads as
 * off: the bulk doors default that way, and an input stored by an earlier
 * build carries no such field.
 */
function fansOutFor(input: BulkActionInput): boolean {
  return input.enable_fanout ?? false;
}

/** The `item.updated` announcement the three property-shaped chunks share. */
async function publishUpdated(
  items: Item[],
  spaceId: string | null,
  input: BulkActionInput,
): Promise<void> {
  for (const item of items) {
    await publish({
      type: "updated",
      item,
      ...(spaceId != null && { spaceId }),
      enableFanout: fansOutFor(input),
    });
  }
}

function toErrorEntry(id: string, err: unknown): BulkActionErrorEntry {
  if (err instanceof Error && "code" in err && typeof err.code === "string") {
    return { id, code: err.code, message: err.message };
  }
  return {
    id,
    code: "internal_error",
    message: err instanceof Error ? err.message : String(err),
  };
}
