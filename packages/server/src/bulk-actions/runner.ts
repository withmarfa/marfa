/**
 * Per-action execution for the bulk_action worker.
 *
 * Each `run<Action>Chunk` takes a slice of matched item ids (default
 * chunk size 100) plus the action input and runs it inside one shared
 * `storage.runInTransaction`. The transaction boundary is what wins
 * the perf vs per-item transactions; the SQL inside the transaction
 * can stay per-row.
 *
 * Authorization: matched_ids were resolved at job-create-time inside a
 * request context with full type-permission narrowing, the worker hands
 * each chunk only the ids the queuing credential may still write, and every
 * arm asks again of each row inside the chunk's transaction, as it stands
 * when it is written: the item arms through the item write, the tag arm
 * itself. Each row is a savepoint of that transaction, so a row reported
 * errored has written nothing.
 *
 * Every chunk publishes what it wrote, on every action. The publish is
 * what appends to the event log, and the log is what a client rebuilding
 * its state replays — so a chunk that stayed quiet wrote rows no client
 * could ever learn about. The job's `enable_fanout` decides only whether
 * those events also drive outbound work, never whether they are logged.
 *
 * Each row's events are written with the row, inside the chunk's
 * transaction, and reach this process's subscribers once it commits.
 */
import { collectBlobHashes } from "../storage/blob-utils.js";
import type { Storage } from "../storage/interface.js";
import type { Metadata } from "@withmarfa/shared";
import type { BulkActionErrorEntry, BulkActionInput } from "./types.js";
import { publish } from "../pubsub.js";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import { checkTypeAccess, mayReadType } from "../middleware/auth.js";
import { blobProof } from "../routes/_blob-reach.js";
import { writeItem } from "../storage/item-write.js";
import type { ItemUpdate } from "../storage/item-write.js";
import type { LiveCredential } from "../auth/live-credential.js";

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
  /** The full BulkActionInput sent to `POST /items/bulk-actions`. */
  input: BulkActionInput;
  /** Ids the worker has assigned to this chunk. */
  ids: string[];
  /**
   * Rows an earlier row of the same job carried where the job moves them: a
   * restore out of the bin bringing back what the trash took with it, or a
   * trash taking what its cascading edges reach. Such a row is in the match
   * set too, and moving it again would refuse a row that is already where
   * the job put it.
   */
  carried?: Set<string>;
  /** The credential that queued the job, as the worker resolved it for this
   *  chunk; its enforcement override is resolved against the levers as it
   *  is on the door it called. */
  credential: LiveCredential;
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
    case "update_occurred_at":
      return runUpdateOccurredAtChunk(ctx);
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
  input,
  ids,
  carried: carriedByJob,
  credential,
}: RunChunkContext): Promise<ChunkOutcome> {
  if (input.action !== "transition")
    throw new Error("runTransitionChunk: wrong action");
  const succeeded: string[] = [];
  const errors: BulkActionErrorEntry[] = [];
  const alreadyCarried = carriedByJob ?? new Set<string>();
  // Joined to the job's set only once this chunk's transaction commits: a
  // chunk rolled back as a whole carried nothing.
  const carriedInChunk = new Set<string>();
  await storage.runInTransaction(async () => {
    for (const id of ids) {
      if (alreadyCarried.has(id) || carriedInChunk.has(id)) {
        succeeded.push(id);
        continue;
      }
      try {
        // Each row is a savepoint of the chunk's transaction, its events
        // with it, so one that fails leaves nothing behind and the rest
        // still land.
        const result = await writeItem(
          storage,
          { kind: "credential", key: credential.key },
          { op: "transition", id, state: input.state },
          { fanout: fansOutFor(input) },
        );
        for (const item of [...result.broughtBack, ...result.trashed]) {
          carriedInChunk.add(item.id);
        }
        succeeded.push(id);
      } catch (err) {
        storage.assertTransactionUsable();
        errors.push(toErrorEntry(id, err));
      }
    }
    storage.assertTransactionUsable();
  });
  for (const id of carriedInChunk) alreadyCarried.add(id);
  return { succeeded, errors };
}

async function runPurgeChunk({
  storage,
  input,
  ids,
  credential,
}: RunChunkContext): Promise<ChunkOutcome> {
  const succeeded: string[] = [];
  const errors: BulkActionErrorEntry[] = [];
  const blob_hashes = new Set<string>();
  await storage.runInTransaction(async () => {
    for (const id of ids) {
      try {
        // The single purge's write, judged inside the chunk's transaction
        // and as a savepoint of it: a row restored since the job was queued
        // is one the person took back and is refused, and a row whose purge
        // fails part-way leaves nothing behind, its events included.
        const result = await writeItem(
          storage,
          { kind: "credential", key: credential.key },
          { op: "purge", id },
          { fanout: fansOutFor(input) },
        );
        if (result.outcome !== "moved") continue;
        collectBlobHashes(result.item.properties, blob_hashes);
        succeeded.push(id);
      } catch (err) {
        storage.assertTransactionUsable();
        errors.push(toErrorEntry(id, err));
      }
    }
    storage.assertTransactionUsable();
  });
  return { succeeded, errors, blob_hashes };
}

async function runUpdateTagsChunk({
  storage,
  input,
  ids,
  credential,
}: RunChunkContext): Promise<ChunkOutcome> {
  if (input.action !== "update_tags")
    throw new Error("runUpdateTagsChunk: wrong action");
  const succeeded: string[] = [];
  const errors: BulkActionErrorEntry[] = [];
  const add = input.add ?? [];
  const remove = input.remove ?? [];
  await storage.runInTransaction(async () => {
    for (const id of ids) {
      try {
        // A savepoint per row, holding the row's gate, its tag writes and
        // the event that announces them, so the gate is asked of the row as
        // it stands when it is written and a row that fails leaves nothing.
        await storage.runInTransaction(async () => {
          const row = await storage.items.getIncludingTrashed(id);
          if (!row || !mayReadType(credential.key, row.type)) {
            throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
          }
          checkTypeAccess(credential.key, row.type, "write");
          let metadata: Metadata | undefined;
          if (add.length > 0) {
            metadata = await storage.metadata.addTags(id, add);
          }
          for (const tag of remove) {
            // Announced whether or not the tag was there to remove. That is
            // deliberate: the doors report on the request rather than on
            // the diff, a caller cannot tell the two apart from the
            // response either, and comparing before and after per tag
            // would cost a read per row to suppress an event a subscriber
            // treats as idempotent anyway.
            metadata = await storage.metadata.removeTag(id, tag);
          }
          if (!metadata) return;
          // The row as the tag write left it, its modification time moved.
          // Read past the bin: the filter takes `state: "trashed"`, and a
          // row trashed after the job was queued is announced like any other.
          await publish({
            type: "metadata_changed",
            item: (await storage.items.getIncludingTrashed(id)) ?? row,
            metadata,
            enableFanout: fansOutFor(input),
          });
        });
        succeeded.push(id);
      } catch (err) {
        storage.assertTransactionUsable();
        errors.push(toErrorEntry(id, err));
      }
    }
    storage.assertTransactionUsable();
  });
  return { succeeded, errors };
}

async function runUpdateTierChunk(ctx: RunChunkContext): Promise<ChunkOutcome> {
  const { input } = ctx;
  if (input.action !== "update_tier")
    throw new Error("runUpdateTierChunk: wrong action");
  return await runUpdateChunk(ctx, { tier: input.tier }, "update_tier");
}

async function runUpdatePropertiesChunk(
  ctx: RunChunkContext,
): Promise<ChunkOutcome> {
  const { input, storage, credential } = ctx;
  if (input.action !== "update_properties")
    throw new Error("runUpdatePropertiesChunk: wrong action");
  // The patch is judged against each row it lands on, as the row stands when
  // the chunk writes it rather than when the job was queued: strict mode and
  // the merged result's validity, both asked by the item write.
  return await runUpdateChunk(
    ctx,
    {
      properties: input.patch,
      blob_proof: blobProof(storage, credential.key, credential.kind),
    },
    "update_properties",
  );
}

async function runUpdateOccurredAtChunk(
  ctx: RunChunkContext,
): Promise<ChunkOutcome> {
  const { input } = ctx;
  if (input.action !== "update_occurred_at")
    throw new Error("runUpdateOccurredAtChunk: wrong action");
  return await runUpdateChunk(
    ctx,
    { occurred_at: input.occurred_at },
    "update_occurred_at",
  );
}

/**
 * The three property-shaped actions: the same change to every row, each row
 * through the item write, which runs as a savepoint of the chunk's
 * transaction, so a row that fails leaves nothing behind and the rest land.
 */
async function runUpdateChunk(
  { storage, input, ids, credential }: RunChunkContext,
  change: Omit<ItemUpdate, "op" | "id">,
  action: string,
): Promise<ChunkOutcome> {
  const succeeded: string[] = [];
  const errors: BulkActionErrorEntry[] = [];
  await storage.runInTransaction(async () => {
    for (const id of ids) {
      try {
        const result = await writeItem(
          storage,
          { kind: "credential", key: credential.key },
          { op: "update", id, ...change },
          { fanout: fansOutFor(input) },
        );
        if (result.outcome === "updated") {
          succeeded.push(id);
        } else {
          errors.push({
            id,
            code: "conflict",
            message: `Version conflict during bulk ${action}`,
          });
        }
      } catch (err) {
        storage.assertTransactionUsable();
        errors.push(toErrorEntry(id, err));
      }
    }
    storage.assertTransactionUsable();
  });
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

function toErrorEntry(id: string, err: unknown): BulkActionErrorEntry {
  if (err instanceof MarfaError) {
    return {
      id,
      code: err.code,
      message: err.message,
      ...(err.details && { details: err.details }),
    };
  }
  if (err instanceof Error && "code" in err && typeof err.code === "string") {
    return { id, code: err.code, message: err.message };
  }
  return {
    id,
    code: "internal_error",
    message: err instanceof Error ? err.message : String(err),
  };
}
