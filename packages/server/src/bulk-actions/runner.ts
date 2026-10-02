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
 * request context with full type-permission narrowing, and the worker
 * hands each chunk only the ids the queuing credential may still write.
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
import type { CascadeRoot, Storage } from "../storage/interface.js";
import type { Edge, Item, Metadata } from "@withmarfa/shared";
import type { BulkActionErrorEntry, BulkActionInput } from "./types.js";
import { publish, publishEdge } from "../pubsub.js";
import {
  getTypeSchema,
  resolveEnforcement,
  softDeleteState,
  validateProperties,
} from "@withmarfa/shared";
import {
  mergeUpdateProperties,
  resolveIncomingProperties,
} from "../storage/merge-properties.js";
import { log } from "../middleware/logger.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import { undeclaredPropertyRefusal } from "../routes/_undeclared-property.js";
import { blobProof } from "../routes/_blob-reach.js";
import { sourceTypesFor } from "../routes/_edge-visibility.js";
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
   * Rows a restore out of the bin brought back earlier in the same job,
   * because the trash that took them was undone. Such a row is in the match
   * set too, and moving it again would refuse a row that is already where
   * the job put it.
   */
  broughtBack?: Set<string>;
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
  broughtBack: brought,
}: RunChunkContext): Promise<ChunkOutcome> {
  if (input.action !== "transition")
    throw new Error("runTransitionChunk: wrong action");
  const succeeded: string[] = [];
  const errors: BulkActionErrorEntry[] = [];
  // Collected inside the transaction and published after it commits, so a
  // subscriber is never told about a row a rollback then took away.
  const moved: Item[] = [];
  // Rows a restore out of the bin brought back because the trash that took
  // them was undone, announced as the single restore door announces them.
  const broughtBack: { item: Item; restoredWith: CascadeRoot }[] = [];
  const alreadyBack = brought ?? new Set<string>();
  // Joined to the job's set only once this chunk's transaction commits: a
  // chunk rolled back as a whole brought nothing back.
  const backInChunk = new Set<string>();
  await storage.runInTransaction(async () => {
    for (const id of ids) {
      try {
        // **No live-connection refusal here.** The door's
        // reserved-namespace narrowing keeps every `system.connection` out
        // of the match set this runner is handed: it admits a reserved type
        // only to a credential that may write it, and the one credential
        // `mayWriteReserved` admits is the operator key, whose own type map
        // is empty. So no id
        // reaching this loop can name a connection, and a refusal here
        // could never fire. `bulk-action-spares-live-connections.test.ts`
        // asserts the outcome that narrowing produces instead.
        if (
          input.state === "active" &&
          (alreadyBack.has(id) || backInChunk.has(id))
        ) {
          succeeded.push(id);
          continue;
        }
        const row =
          input.state === "active"
            ? await storage.items.getIncludingTrashed(id)
            : null;
        const root = row?.state === "trashed" ? { id, type: row.type } : null;
        const back = root
          ? (await storage.items.restoreBeneath(id)).map((item) => ({
              item,
              restoredWith: root,
            }))
          : [];
        moved.push(await storage.items.transition(id, input.state));
        for (const entry of back) {
          broughtBack.push(entry);
          backInChunk.add(entry.item.id);
        }
        succeeded.push(id);
      } catch (err) {
        errors.push(toErrorEntry(id, err));
      }
    }
  });
  for (const id of backInChunk) alreadyBack.add(id);
  for (const item of moved) {
    await publish({
      type: "state_changed",
      item,
      enableFanout: fansOutFor(input),
    });
  }
  for (const { item, restoredWith } of broughtBack) {
    await publish({
      type: "restored",
      item,
      restoredWith,
      enableFanout: fansOutFor(input),
    });
  }
  return { succeeded, errors };
}

async function runPurgeChunk({
  storage,
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
  // The rows themselves, read before they are deleted because there is
  // nothing to read afterwards. Staged the same way and discarded by the
  // same gate below.
  const removed: Item[] = [];
  // Read with the rows, since the purge takes each mark with its row.
  let marks = new Map<string, CascadeRoot>();
  // The type of each cascaded edge's source, which its announcement
  // carries: a purged source's from the rows read here, any other's read
  // before the transaction ends.
  const sourceTypes = new Map<string, string>();
  // Set only when the chunk itself failed, so a chunk that committed still
  // announces what it purged. A holder rather than a bare boolean, because
  // the write happens inside the transaction callback where control-flow
  // analysis cannot see it.
  const chunk = { failed: false };
  await storage.runInTransaction(async () => {
    // Trashed included, because the trashed rows are the ones a purge takes.
    const found = await storage.items.getMany(ids, { includeTrashed: true });
    // No live-connection refusal, for the reason the transition chunk
    // carries: the door's reserved-namespace narrowing means a
    // `system.connection` never reaches this runner's match set.
    //
    // Read before the purge, which takes each mark with its row.
    marks = await storage.items.cascadeMarks([...found.keys()]);
    try {
      // The store takes only rows in their type's soft-deleted state, judged
      // inside this transaction rather than when the job was queued: a row
      // restored since then is one the person took back, and the filter may
      // have matched a row that was never in the trash at all. Edges go
      // with the rows taken, in one DELETE per direction.
      const taken = new Set(await storage.items.bulkPurge([...found.keys()]));
      if (taken.size > 0) {
        cascaded.push(
          ...(await storage.edges.deleteBySourceBatch([...taken])),
          ...(await storage.edges.deleteByTargetBatch([...taken])),
        );
        for (const item of found.values()) sourceTypes.set(item.id, item.type);
        const others = cascaded
          .map((edge) => edge.source_id)
          .filter((id) => !sourceTypes.has(id));
        for (const [id, type] of await sourceTypesFor(storage, others)) {
          sourceTypes.set(id, type);
        }
      }
      for (const item of found.values()) {
        if (taken.has(item.id)) {
          succeeded.push(item.id);
          collectBlobHashes(item.properties, blob_hashes);
          removed.push(item);
        } else {
          errors.push({
            id: item.id,
            code: "invalid_transition",
            message: `Only ${softDeleteState(item.type)} items can be purged`,
          });
        }
      }
      for (const id of ids) {
        if (!found.has(id)) {
          errors.push({
            id,
            code: "item_not_found",
            message: "Item not found at purge time",
          });
        }
      }
    } catch (err) {
      chunk.failed = true;
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
      removed.length = 0;
      const entry = toErrorEntry("", err);
      for (const id of ids) {
        errors.push({ id, code: entry.code, message: entry.message });
      }
    }
  });
  // Outside the transaction and outside the try, so a transient publish
  // failure cannot be recorded as a per-item error on a purge that
  // completed — and gated on the chunk having failed, so a chunk that did
  // announces nothing. See the `catch` above for why that gate fires
  // whenever the chunk failed.
  //
  // An edge pointing AT one of these items lives on an item that is NOT
  // being purged, so nothing else tells its holder the relationship is
  // gone — which is why the cascade is announced per edge.
  //
  // **The items too, not only the edges.** The trash transition before a
  // purge announced `item.deleted`, which says recoverable, and a client
  // that acted on it would hold a trashed row nothing ever corrects. One
  // event per row, which is what the trash arm of this same runner already
  // writes, so a purge is no noisier than the transition it follows.
  //
  // Edges first and rows after, the ordering the single-item door states.
  if (!chunk.failed) {
    const purgedIds = new Set(succeeded);
    for (const edge of cascaded) {
      await publishEdge({
        type: "edge_deleted",
        edge,
        sourceType: sourceTypes.get(edge.source_id),
        // The source side runs first, taking any edge whose source is purged.
        purgedWith: purgedIds.has(edge.source_id)
          ? edge.source_id
          : edge.target_id,
        enableFanout: fansOutFor(input),
      });
    }
    for (const item of removed) {
      const trashedWith = marks.get(item.id);
      await publish({
        type: "purged",
        item,
        ...(trashedWith && { trashedWith }),
        enableFanout: fansOutFor(input),
      });
    }
  }
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
          // Announced whether or not the tag was there to remove. That is
          // deliberate: the doors report on the request rather than on the
          // diff, a caller cannot tell the two apart from the response
          // either, and comparing before and after per tag would cost a
          // read per row to suppress an event a subscriber treats as
          // idempotent anyway.
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
  //
  // `includeTrashed` is load-bearing rather than defensive. `addTags` has no
  // trashed guard, so the write lands on a trashed row and the id is
  // reported as succeeded; without this the read comes back empty and the
  // publish is skipped, which is a write with no event-log row — the exact
  // shape this whole change exists to remove. Two ordinary paths reach it:
  // the filter accepts `state: "trashed"` outright, and the match set is
  // frozen at job creation while the worker runs later, so anything trashed
  // in that window arrives here trashed. The same omission has now cost the
  // purge runner a four-thousand-row miscount; see `getMany`'s own comment.
  if (changed.size > 0) {
    const items = await storage.items.getMany([...changed.keys()], {
      includeTrashed: true,
    });
    for (const [id, metadata] of changed) {
      const item = items.get(id);
      if (!item) {
        // Reachable only if the row was hard-deleted between the write and
        // this read. Said out loud rather than skipped silently: the write
        // happened and nothing will ever announce it, so a client rebuilding
        // from the stream is now behind by one row with no way to find out.
        log("warn", "Bulk tag update wrote a row it could not announce", {
          item_id: id,
          reason: "item absent at publish time",
        });
        continue;
      }
      await publish({
        type: "metadata_changed",
        item,
        metadata,
        enableFanout: fansOutFor(input),
      });
    }
  }
  return { succeeded, errors };
}

async function runUpdateTierChunk({
  storage,
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
        const result = await storage.items.update(id, { tier: input.tier });
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
  await publishUpdated(updated, input);
  return { succeeded, errors };
}

async function runUpdatePropertiesChunk({
  storage,
  input,
  ids,
  credential,
}: RunChunkContext): Promise<ChunkOutcome> {
  if (input.action !== "update_properties")
    throw new Error("runUpdatePropertiesChunk: wrong action");
  const succeeded: string[] = [];
  const errors: BulkActionErrorEntry[] = [];
  // Read when the chunk writes rather than when the job was queued, as every
  // other write door reads the lever when it writes: a lever set while the
  // job waited holds for the rows it has not yet reached.
  const enforcement = resolveEnforcement(
    await readInstanceConfig(storage.settings),
    credential.key,
  );
  // Collected inside the transaction, published after it commits.
  const updated: Item[] = [];
  await storage.runInTransaction(async () => {
    for (const id of ids) {
      try {
        // The patch is judged against the row it lands on, which means
        // reading the row: this door takes a filter rather than a list, so
        // the ids were frozen when the job was made and the rows may have
        // moved since. The single-item door judges the merged result rather
        // than the body, so a patch removing a required field is refused
        // even though it names no invalid value, and this judges the same
        // thing through the same helper.
        //
        // Nothing judged it before, and this is the widest of the six
        // enumerated item-write doors: one patch reaches every row the
        // filter matched, so a single call could leave thousands invalid
        // against their own schemas.
        //
        // The schema guard is the single-item door's. `validateProperties`
        // reports an absent schema as `Unknown type` rather than as no
        // opinion, so judging unguarded would refuse every row of a type
        // this worker's registry does not carry.
        const before = await storage.items.get(id);
        // Of the patch the caller sent, per row of a type the lever names,
        // through the function the other item write doors ask.
        const undeclared =
          before &&
          undeclaredPropertyRefusal(enforcement, before.type, input.patch);
        if (undeclared) {
          errors.push({
            id,
            code: undeclared.code,
            message: undeclared.message,
            ...(undeclared.details && { details: undeclared.details }),
          });
          continue;
        }
        if (before && getTypeSchema(before.type)) {
          const merged = mergeUpdateProperties(
            before.properties,
            resolveIncomingProperties(before.type, input.patch) ?? {},
            "merge",
          );
          const validation = validateProperties(before.type, merged);
          if (!validation.success) {
            // Errored per row rather than thrown for the chunk: this route's
            // established answer is that one unreachable row must not fail an
            // action over thousands, and the loop already reports a version
            // conflict that way.
            errors.push({
              id,
              code: "invalid_properties",
              message: `Invalid properties: ${validation.errors
                .map((e) => `${e.field}: ${e.message}`)
                .join("; ")}`,
            });
            continue;
          }
        }
        const result = await storage.items.update(id, {
          properties: input.patch,
          blob_proof: blobProof(storage, credential.key, credential.kind),
        });
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
  await publishUpdated(updated, input);
  return { succeeded, errors };
}

async function runUpdateOccurredAtChunk({
  storage,
  input,
  ids,
}: RunChunkContext): Promise<ChunkOutcome> {
  if (input.action !== "update_occurred_at")
    throw new Error("runUpdateOccurredAtChunk: wrong action");
  const succeeded: string[] = [];
  const errors: BulkActionErrorEntry[] = [];
  // Collected inside the transaction, published after it commits.
  const updated: Item[] = [];
  await storage.runInTransaction(async () => {
    for (const id of ids) {
      try {
        const result = await storage.items.update(id, {
          occurred_at: input.occurred_at,
        });
        if ("error" in result) {
          errors.push({
            id,
            code: "conflict",
            message: "Version conflict during bulk update_occurred_at",
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
  await publishUpdated(updated, input);
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
  input: BulkActionInput,
): Promise<void> {
  for (const item of items) {
    await publish({
      type: "updated",
      item,
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
