/**
 * Per-action execution for the bulk_action worker.
 *
 * Each `run<Action>Chunk` takes a slice of matched item ids (default
 * chunk size 100) plus the action input and runs it inside one shared
 * `storage.runInTransaction`. The transaction boundary is what wins
 * the perf vs per-item transactions; the SQL inside the transaction
 * can stay per-row.
 *
 * Authorisation: the worker passes the job's `tenant_id` explicitly
 * to every storage method. RLS, if enforced, is belt-and-braces —
 * matched_ids were resolved at job-create-time inside a request
 * context with full type-permission narrowing.
 */
import { collectBlobHashes } from "../storage/blob-utils.js";
import type { Storage } from "../storage/interface.js";
import type { BulkActionErrorEntry, BulkActionInput } from "./types.js";

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
  tenantId: string | null;
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
  tenantId,
  input,
  ids,
}: RunChunkContext): Promise<ChunkOutcome> {
  if (input.action !== "transition")
    throw new Error("runTransitionChunk: wrong action");
  const succeeded: string[] = [];
  const errors: BulkActionErrorEntry[] = [];
  await storage.runInTransaction(async () => {
    for (const id of ids) {
      try {
        await storage.items.transition(id, input.state, tenantId ?? undefined);
        succeeded.push(id);
      } catch (err) {
        errors.push(toErrorEntry(id, err));
      }
    }
  });
  return { succeeded, errors };
}

async function runPurgeChunk({
  storage,
  tenantId,
  ids,
}: RunChunkContext): Promise<ChunkOutcome> {
  const succeeded: string[] = [];
  const errors: BulkActionErrorEntry[] = [];
  const blob_hashes = new Set<string>();
  await storage.runInTransaction(async () => {
    const items = await storage.items.getMany(ids, tenantId ?? undefined);
    for (const item of items.values()) {
      collectBlobHashes(item.properties, blob_hashes);
    }
    // One DELETE per direction + one DELETE on items = 3 statements instead
    // of 3 × ids.length.
    try {
      await storage.edges.deleteBySourceBatch(ids);
      await storage.edges.deleteByTargetBatch(ids);
      const purged = await storage.items.bulkPurge(ids, tenantId ?? undefined);
      // Ids in `items` were in-scope and purged; ids absent from the map
      // weren't found in the tenant and surface as not-found errors.
      for (const id of items.keys()) succeeded.push(id);
      const seen = new Set(items.keys());
      for (const id of ids) {
        if (!seen.has(id)) {
          errors.push({
            id,
            code: "item_not_found",
            message: "Item not found in tenant scope at purge time",
          });
        }
      }
      void purged;
    } catch (err) {
      const entry = toErrorEntry("", err);
      for (const id of ids) {
        errors.push({ id, code: entry.code, message: entry.message });
      }
    }
  });
  return { succeeded, errors, blob_hashes };
}

async function runUpdateTagsChunk({
  storage,
  input,
  ids,
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
        if (add.length > 0) {
          await storage.metadata.addTags(id, add);
        }
        for (const tag of remove) {
          await storage.metadata.removeTag(id, tag);
        }
        succeeded.push(id);
      } catch (err) {
        errors.push(toErrorEntry(id, err));
      }
    }
  });
  return { succeeded, errors };
}

async function runUpdateTierChunk({
  storage,
  tenantId,
  input,
  ids,
}: RunChunkContext): Promise<ChunkOutcome> {
  if (input.action !== "update_tier")
    throw new Error("runUpdateTierChunk: wrong action");
  const succeeded: string[] = [];
  const errors: BulkActionErrorEntry[] = [];
  await storage.runInTransaction(async () => {
    for (const id of ids) {
      try {
        const result = await storage.items.update(
          id,
          { tier: input.tier },
          tenantId ?? undefined,
        );
        if ("error" in result) {
          errors.push({
            id,
            code: "conflict",
            message: "Version conflict during bulk update_tier",
          });
        } else {
          succeeded.push(id);
        }
      } catch (err) {
        errors.push(toErrorEntry(id, err));
      }
    }
  });
  return { succeeded, errors };
}

async function runUpdatePropertiesChunk({
  storage,
  tenantId,
  input,
  ids,
}: RunChunkContext): Promise<ChunkOutcome> {
  if (input.action !== "update_properties")
    throw new Error("runUpdatePropertiesChunk: wrong action");
  const succeeded: string[] = [];
  const errors: BulkActionErrorEntry[] = [];
  await storage.runInTransaction(async () => {
    for (const id of ids) {
      try {
        const result = await storage.items.update(
          id,
          { properties: input.patch },
          tenantId ?? undefined,
        );
        if ("error" in result) {
          errors.push({
            id,
            code: "conflict",
            message: "Version conflict during bulk update_properties",
          });
        } else {
          succeeded.push(id);
        }
      } catch (err) {
        errors.push(toErrorEntry(id, err));
      }
    }
  });
  return { succeeded, errors };
}

async function runUpdateTimestampChunk({
  storage,
  tenantId,
  input,
  ids,
}: RunChunkContext): Promise<ChunkOutcome> {
  if (input.action !== "update_timestamp")
    throw new Error("runUpdateTimestampChunk: wrong action");
  const succeeded: string[] = [];
  const errors: BulkActionErrorEntry[] = [];
  await storage.runInTransaction(async () => {
    for (const id of ids) {
      try {
        const result = await storage.items.update(
          id,
          { timestamp: input.timestamp },
          tenantId ?? undefined,
        );
        if ("error" in result) {
          errors.push({
            id,
            code: "conflict",
            message: "Version conflict during bulk update_timestamp",
          });
        } else {
          succeeded.push(id);
        }
      } catch (err) {
        errors.push(toErrorEntry(id, err));
      }
    }
  });
  return { succeeded, errors };
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
