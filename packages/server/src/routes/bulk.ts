import { runAuditedTransaction } from "../storage/audited-transaction.js";
import { rememberItemSubject } from "../middleware/replay-requirements.js";
/**
 * Bulk operations on items.
 *
 * Two endpoints, two shapes:
 *
 *   POST /items/bulk        — list-in: caller provides explicit items to
 *                             create/upsert. Supports modes, atomic
 *                             control, inline edges, and per-item outcomes.
 *   POST /items/bulk-actions — filter-in: caller provides a filter and an
 *                             action; server applies the action to every
 *                             matched item. Actions are a discriminated
 *                             enum (transition / purge / update_tags /
 *                             update_tier / update_properties /
 *                             update_occurred_at).
 *
 * Each committed unit records its audit before commit, and both endpoints
 * append to the event log for every row they write. That
 * append is unconditional: the log is what a client rebuilding its state
 * replays, so a write missing from it is one that client can never learn
 * about.
 *
 * `enable_fanout` governs the outbound work instead — webhook delivery —
 * and defaults off, because
 * one call here writes thousands of rows and a delivery per row per
 * subscriber is not what the caller asked for.
 */

import { assertFilterEdgeTermsReadable } from "./_edge-visibility.js";
import { assertTypeReadable } from "./_type-filter.js";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  SYSTEM_DEFAULT_STATE,
  validateTransition,
  MarfaError,
  ErrorCode,
  generateId,
  isValidTimestamp,
  isValidTypeIdentifier,
  resolveEnforcement,
  malformedTypeIdentifier,
} from "@withmarfa/shared";
import type { ApiKey, Item } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requirePermission,
  requireAuth,
  checkTypeAccess,
  mayWriteReserved,
  itemProvenanceSource,
  getTypeFilter,
  computeTypeFilter,
  credentialHandle,
  readsSomeType,
} from "../middleware/auth.js";
import { MAX_TAGS_PER_ITEM } from "../tag-limits.js";
import { namesSystemNamespace } from "./_system-type-visibility.js";
import type { BulkActionJobRow, Storage } from "../storage/interface.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import { sourceAllowlistRefusal } from "./_source-allowlist.js";
import { refusedRowId, writeItem } from "../storage/item-write.js";
import type { ItemWriteResult } from "../storage/item-write.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import {
  bulkAtomicRollback,
  countOutcomes,
  failedEntry,
  isWriteOutcomeUnknown,
  mayHaveCommitted,
  isEntryVerdict,
} from "./_bulk-rollback.js";
import {
  BulkResponseSchema,
  ItemStateEnum,
  TierEnum,
  type BulkSkipReason,
  TagSchema,
  WrittenPropertiesSchema,
} from "./_schemas.js";
import { notifyBulkJobEnqueued } from "../bulk-actions/enqueue-signal.js";
import { yieldBulkWork } from "../bulk-actions/yield.js";
import { resolveLiveCredential } from "../auth/live-credential.js";
import { authorizeReplay } from "../middleware/replay-authorization.js";
import { sourceHiddenItemIds } from "../bulk-actions/source-visibility.js";
import {
  BULK_ACTION_SHAPES,
  BulkActionFilterShape,
  BulkActionInputSchema,
  BulkActionJobSchema,
  BulkActionResultSchema,
  type BulkActionResult as BulkActionResultType,
} from "../bulk-actions/types.js";
import {
  refuseUnknownBodyKeys,
  refuseUnknownFilterKeys,
} from "./_unknown-query-keys.js";
import { requestBlobProof } from "./_blob-reach.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BULK_ITEMS = 5000;
const MAX_BULK_ACTION_ITEMS = 10_000;
const MAX_BULK_ACTION_ITEMS_HARD = 50_000;

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

const BulkInputItemSchema = z.object({
  id: z
    .string()
    .optional()
    .describe(
      "A UUIDv7 for the item. Leave it out and Marfa creates one. If no item matches the natural key, an `id` naming an existing item matches that item: under `upsert` only a live item you can read.",
    ),
  type: z.string().describe("The item's type identifier, such as `core.note`."),
  properties: WrittenPropertiesSchema.optional().describe(
    "The item's properties, checked against the type's schema. If the instance's strict mode names the type, an undeclared property is refused as `invalid_properties` with `details.code` `unknown_property`.",
  ),
  properties_mode: z
    .enum(["merge", "replace"])
    .optional()
    .describe(
      "How `properties` applies to an existing item, as in `PATCH /items/{id}`. `merge` (the default) lays them over its properties. `replace` takes them as the whole set. A new item takes them whole either way.",
    ),
  /** Every state the platform has, not the three a non-system type can
   *  reach. Naming a state its type's lifecycle does not contain is
   *  refused further down by `validateTransition`, which gives each type
   *  its own answer — and that is the gate `POST /items` uses, where the
   *  same create in `revoked` on a `system.*` type succeeds. A narrower
   *  enum here would refuse it before the graph is consulted, and the two
   *  create doors would disagree. */
  state: ItemStateEnum.optional(),
  tier: TierEnum.optional(),
  occurred_at: z.string().optional(),
  source: z
    .string()
    .optional()
    .describe(
      "The source to key and stamp the entry's item with, as in `POST /items`. Defaults to your credential's own; it can also name one of your key's `sources`.",
    ),
  source_id: z
    .string()
    .optional()
    .describe(
      "The item's identifier at its source. With `source`, it is the natural key that matches an existing item.",
    ),
  /** The version this entry was based on, where it resolves a row that
   *  already exists. Optional for the same reason it is optional on
   *  `POST /items`: an entry creating a row it has never read has no
   *  version to name. Where it does resolve one, the upsert is conditional
   *  and the entry's outcome carries the refusal rather than the batch
   *  failing — a queue draining a hundred rows should not lose ninety-nine
   *  because one was stale. */
  version: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "The version you read, used when the entry matches an existing item: the update then applies only if the item is still at this version.",
    ),
  tags: z
    .array(TagSchema)
    .optional()
    .describe(
      "Tags to put on the item: at most 100, each up to 128 characters.",
    ),
  /** Inline edges (replace-all semantics per edge_type) applied after
   *  create/update in the same transaction. Absent means leave edges
   *  untouched. */
  edges: z
    .record(z.string(), z.array(z.string()))
    .optional()
    .describe(
      "Edge types to set, each mapped to the target item IDs the item should now point to. Types you don't name are untouched.",
    ),
});

// The request shape is `BulkActionInputSchema`, declared once in the
// bulk-action module and imported here, envelope and filter alike: two
// declarations of one thing let `dry_run` and `max_items` drift out of
// step with the copy the specification is generated from.

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const bulkRoute = createRoute({
  method: "post",
  path: "/bulk",
  operationId: "bulkUpsertItems",
  tags: ["Items"],
  summary: "Upsert items in bulk",
  description:
    "Creates or updates up to 5,000 items in one call, matching existing items on `(source, source_id)`. The batch is atomic by default: one failed entry rolls it all back. Returns each entry's outcome.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            items: z
              .array(BulkInputItemSchema)
              .describe("The entries to write, at most 5,000."),
            mode: z
              .enum(["upsert", "create_only"])
              .optional()
              .describe(
                "`upsert` (the default) updates the item an entry matches. `create_only` skips it, reporting `skipped` with reason `duplicate_source`, or `duplicate_id` if it matched by `id`.",
              ),
            atomic: z
              .boolean()
              .optional()
              .describe(
                "Whether one failed entry rolls back the whole batch. Defaults to `true`. With `false`, that entry is `errored` and the rest are written.",
              ),
            enable_fanout: z
              .boolean()
              .optional()
              .describe(
                "Whether each write also calls outbound webhooks. Defaults to `false`. Marfa logs the events either way.",
              ),
            retype: z
              .boolean()
              .optional()
              .describe(
                "`true` moves an item to the entry's `type` when the entry resolves an existing item of another type. You need write on both types. Defaults to `false`.",
              ),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: BulkResponseSchema },
      },
      description:
        "Returns `counts` and a `results` entry for each item, in order: `created`, `updated`, `skipped` or `errored`. Under `upsert`, an entry that matches a trashed item isn't written and is `skipped` with reason `trashed`. Under `create_only`, a matching entry is `skipped` with reason `duplicate_source` or `duplicate_id`.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "bulk_atomic_rollback",
          ]),
        },
      },
      description:
        "- `validation_error`: the body is malformed, or has more than 5,000 entries.\n- `missing_required_field`: a required field is missing.\n- `bulk_atomic_rollback`: with `atomic` true, an entry was refused and nothing was written. `details.code` and `details.index` give its code and position. The status is the one that refusal carries alone.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "bulk_atomic_rollback",
            "forbidden",
            "type_not_permitted",
          ]),
        },
      },
      description:
        "- `type_not_permitted`: you don't have write on an entry's type, or on the type its natural key matches, or your credential reaches no type.\n- `forbidden`: an entry names a source your key doesn't claim or the instance's source allow-list excludes, or moves a natural key under a source your key doesn't write under.\n- `bulk_atomic_rollback`: one of these under `atomic`.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["bulk_atomic_rollback"]),
        },
      },
      description:
        "- `bulk_atomic_rollback`: with `atomic` true, an entry names an item or edge type that isn't there, such as an edge target. `details.code` is `item_not_found` or `edge_type_not_found`.",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["bulk_atomic_rollback"]),
        },
      },
      description:
        "- `bulk_atomic_rollback`: with `atomic` true, an entry's item has moved or is taken. `details.code` names the cause, such as `version_conflict`, `link_taken`, `type_mismatch` (the natural key matched an item of another type) or `id_reused` (the entry's `id` belongs to an item it doesn't describe).",
    },
  },
});

const bulkActionRoute = createRoute({
  method: "post",
  path: "/bulk-actions",
  operationId: "applyBulkAction",
  tags: ["Bulk actions"],
  summary: "Apply a bulk action",
  description:
    "Applies one action to every item that matches a filter: change state, purge, update tags, tier, properties or own time. It matches only items you can write. With `dry_run: true` it returns the matched IDs; otherwise it queues a job.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    body: {
      content: {
        "application/json": {
          schema: BulkActionInputSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: BulkActionResultSchema },
      },
      description:
        "Dry run: returns `matched` and the matched `ids` without writing anything. A purge dry run also lists matches that aren't in the trash. The purge skips those.",
    },
    202: {
      content: { "application/json": { schema: BulkActionJobSchema } },
      description:
        "Returns the queued job. Poll `GET /items/bulk-actions/jobs/{id}` until `status` is `completed`, `failed` or `canceled`. The job acts for your credential as it stands. If your key is revoked or expires, your app's access is revoked, or a purge loses `items.purge`, the job ends `failed` and keeps its `result`.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "bulk_confirmation_required",
            "bulk_cap_exceeded",
          ]),
        },
      },
      description:
        '- `validation_error`: the body or `filter` is malformed or has an undeclared key not starting with `_`, `update_tags` has neither `add` nor `remove`, or `expected_ids` is empty or not on a purge.\n- `missing_required_field`: a field the action needs is missing.\n- `bulk_confirmation_required`: a purge without `confirm: "PURGE"`.\n- `bulk_cap_exceeded`: more items match than `max_items` allows.',
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "edge_permission_denied",
            "forbidden",
            "type_not_permitted",
          ]),
        },
      },
      description:
        "- `forbidden`: you don't have `items.purge` for a purge, or the instance's source filter changed while Marfa selected items. Repeat the request.\n- `type_not_permitted`: your credential reaches no type, or `filter.type` is a type you can't read.\n- `edge_permission_denied`: the filter names an edge type you can't read.",
    },
  },
});

// Poll endpoint for a queued / running / terminal job. The job envelope
// is identical to what `POST /items/bulk-actions` returns initially;
// subsequent calls reflect the worker's progress until the row reaches
// a terminal status. Auth: the originating credential or the operator key.
const bulkActionStatusRoute = createRoute({
  method: "get",
  path: "/bulk-actions/jobs/{id}",
  operationId: "getBulkActionJob",
  tags: ["Bulk actions"],
  summary: "Get a bulk-action job",
  description:
    "Returns a bulk-action job's status and counts, and its `result` once it has finished. Only the credential that queued the job, or an operator key, can read it.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("The ID of the bulk-action job."),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: BulkActionJobSchema } },
      description:
        "Returns the job. Once it is terminal, `result.errors` lists each item left unchanged, with a code such as `invalid_transition` (a purge of an item not in the trash), `type_not_permitted` (a type you can no longer write), `item_not_found` (a type you can no longer read) or `invalid_properties`.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description:
        "- `forbidden`: another credential queued the job, and yours is not an operator key.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["bulk_job_not_found"]),
        },
      },
      description: "- `bulk_job_not_found`: no job has this ID.",
    },
  },
});

// Request cancellation. The door sets the row itself, whether it is
// queued or running, and answers what it wrote; a row already terminal is
// left alone and answered as it stands.
const bulkActionCancelRoute = createRoute({
  method: "delete",
  path: "/bulk-actions/jobs/{id}",
  operationId: "cancelBulkActionJob",
  tags: ["Bulk actions"],
  summary: "Cancel a bulk-action job",
  description:
    "Cancels a bulk-action job and returns it. Items the job already processed stay processed. A job that has already finished is left as it is.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("The ID of the bulk-action job."),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: BulkActionJobSchema } },
      description:
        "Returns the job: `canceled` if it was queued or running, otherwise its final state unchanged.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description:
        "- `forbidden`: another credential queued the job, and yours is not an operator key.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["bulk_job_not_found"]),
        },
      },
      description: "- `bulk_job_not_found`: no job has this ID.",
    },
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One entry of the response array. This is the wire shape — it is handed
 *  to `c.json` as-is, and a response is documented rather than validated,
 *  so anything added here ships. */
interface BulkItemResult {
  index: number;
  outcome: "created" | "updated" | "skipped" | "errored";
  id?: string;
  reason?: BulkSkipReason;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** What one processed entry yields: its wire entry. */
interface ProcessedBulkItem {
  result: BulkItemResult;
}

function erroredEntry(
  index: number,
  err: MarfaError,
  id: string | undefined,
): ProcessedBulkItem {
  return {
    result: {
      index,
      outcome: "errored",
      ...(id !== undefined && { id }),
      error: {
        code: err.code,
        message: err.message,
        ...(err.details && { details: err.details }),
      },
    },
  };
}

/**
 * One bulk entry, through the item write that resolves, gates and writes it
 * in one transaction: nested in the page's in atomic mode, its own in
 * best-effort mode. A refused entry rolls back; the outer audited unit
 * separately reports a commit it cannot confirm.
 */
async function processBulkItem(
  storage: Storage,
  raw: z.infer<typeof BulkInputItemSchema>,
  index: number,
  options: {
    key: ApiKey;
    mode: "upsert" | "create_only";
    blobProof: (hash: string) => Promise<boolean>;
    /**
     * Opt-in re-typing on the update half of an upsert, per batch. Never
     * inferred from a differing type: the fleet declares one on nearly
     * every write, so inferring would move a corpus on an ordinary sync bug.
     */
    retype: boolean;
    /** Whether the entry's events drive outbound work: off unless the page
     *  asks, and never whether the entry is logged. */
    enableFanout: boolean;
  },
): Promise<ProcessedBulkItem> {
  if (!isValidTypeIdentifier(raw.type)) {
    return erroredEntry(
      index,
      new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid type identifier: ${raw.type}`,
      ),
      undefined,
    );
  }
  let result: ItemWriteResult;
  try {
    result = await writeItem(
      storage,
      { kind: "credential", key: options.key },
      {
        op: "put",
        door: options.mode === "upsert" ? "bulk_upsert" : "bulk_create_only",
        index,
        type: raw.type,
        ...(raw.properties !== undefined && { properties: raw.properties }),
        ...(raw.properties_mode !== undefined && {
          properties_mode: raw.properties_mode,
        }),
        ...(raw.id !== undefined && { id: raw.id }),
        ...(raw.state !== undefined && { state: raw.state }),
        ...(raw.tier !== undefined && { tier: raw.tier }),
        ...(raw.occurred_at !== undefined && { occurred_at: raw.occurred_at }),
        ...(raw.source !== undefined && { source: raw.source }),
        ...(raw.source_id !== undefined && { source_id: raw.source_id }),
        ...(raw.version !== undefined && { version: raw.version }),
        ...(raw.tags !== undefined && { tags: raw.tags }),
        ...(raw.edges !== undefined && { edges: raw.edges }),
        retype: options.retype,
        blob_proof: options.blobProof,
      },
      { fanout: options.enableFanout },
    );
  } catch (err) {
    if (isEntryVerdict(err)) {
      // The row's id only where its own gates passed: a key that may not
      // write the row learns only that its key is taken.
      return erroredEntry(index, err, refusedRowId(err));
    }
    throw err;
  }
  switch (result.outcome) {
    case "created":
    case "updated":
      return {
        result: { index, outcome: result.outcome, id: result.item.id },
      };
    case "unchanged":
      // Only `POST /items` is answered `repeat`; a bulk door never is.
      if (result.reason === "repeat") {
        throw new Error("unreachable: a bulk entry answered as a repeat");
      }
      return {
        result: {
          index,
          outcome: "skipped",
          ...(result.disclosed && { id: result.item.id }),
          reason: result.reason,
        },
      };
    case "stale":
    case "conflict":
      // Reachable only for an entry that named a version. The message is
      // the store's own, because the codes it can carry say different
      // things: a stale version, or a base version no snapshot covers.
      return {
        result: {
          index,
          outcome: "errored",
          id: result.id,
          error: {
            code: result.conflict.error.code,
            message: result.conflict.error.message,
          },
        },
      };
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function bulkRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  // POST /items/bulk — list-in
  router.openapi(bulkRoute, async (c) => {
    const key = requireAuth(c);

    const body = c.req.valid("json");
    const items = body.items;
    const mode = body.mode ?? "upsert";
    const atomic = body.atomic ?? true;
    const retype = body.retype === true;
    const enableFanout = body.enable_fanout ?? false;

    if (items.length > MAX_BULK_ITEMS) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Maximum ${String(MAX_BULK_ITEMS)} items per call`,
        { cap: MAX_BULK_ITEMS, provided: items.length },
      );
    }

    if (items.length === 0) {
      return c.json(
        {
          counts: { created: 0, updated: 0, skipped: 0, errored: 0 },
          results: [],
        },
        200,
      );
    }

    const operationId = generateId();
    const run = async (): Promise<ProcessedBulkItem[]> => {
      // In atomic mode, judge what every entry names before any entry is
      // looked up. The transaction is what undoes a refused page; this pass
      // decides which refusal the page answers with. Nothing here reads an
      // item row, so a page carrying an entry its key may not write, or
      // naming a source its key does not claim, is refused for that entry
      // whatever rows the store holds. Left to the per-entry pass, a stale
      // entry ahead of it would answer first, as a `409`, and the caller
      // would re-read the row over a refusal whose cause is a permission it
      // lacks (`items.md` 31).
      if (atomic) {
        const enforcement = resolveEnforcement(
          await readInstanceConfig(storage.settings),
          key,
        );
        for (const [i, raw] of items.entries()) {
          if (!isValidTypeIdentifier(raw.type)) {
            throw bulkAtomicRollback(i, {
              code: ErrorCode.VALIDATION_ERROR,
              message: `Invalid type identifier: ${raw.type}`,
            });
          }
          if (
            raw.occurred_at !== undefined &&
            !isValidTimestamp(raw.occurred_at)
          ) {
            throw bulkAtomicRollback(i, {
              code: ErrorCode.VALIDATION_ERROR,
              message: "occurred_at must be an ISO 8601 string",
            });
          }
          // Before the write gate, because the single door asks it first
          // (`item-state-doors.test.ts`). Only for an entry that can be
          // nothing but a create, one naming neither an `id` nor a
          // `source_id`: the update path does not read `state`, and refusing
          // it here would roll a page back over a field the write it
          // describes was going to ignore.
          const mustCreate =
            raw.id === undefined && raw.source_id === undefined;
          if (mustCreate && raw.state && raw.state !== SYSTEM_DEFAULT_STATE) {
            const stateError = validateTransition(
              raw.type,
              SYSTEM_DEFAULT_STATE,
              raw.state,
            );
            if (stateError) {
              throw bulkAtomicRollback(i, {
                code: ErrorCode.VALIDATION_ERROR,
                message: stateError,
              });
            }
          }
          try {
            checkTypeAccess(key, raw.type, "write");
            const notAllowed = sourceAllowlistRefusal(
              enforcement,
              raw.type,
              itemProvenanceSource(key, raw.source),
            );
            if (notAllowed) throw notAllowed;
          } catch (err) {
            if (isEntryVerdict(err)) {
              throw bulkAtomicRollback(i, {
                code: err.code,
                message: err.message,
                details: err.details,
              });
            }
            throw err;
          }
        }
      }

      const out: ProcessedBulkItem[] = [];
      for (const [i, raw] of items.entries()) {
        const work = () =>
          processBulkItem(storage, raw, i, {
            key,
            mode,
            blobProof: requestBlobProof(c, storage),
            retype,
            enableFanout,
          });
        const entry = () =>
          atomic
            ? work()
            : runAuditedTransaction(storage, work, ({ result }) =>
                result.outcome === "created" || result.outcome === "updated"
                  ? {
                      client_ip: c.get("clientIp") ?? null,
                      key_id: key.id,
                      action: "items.bulk",
                      resource_type: "items.bulk",
                      resource_id: result.id,
                      details: {
                        operation_id: operationId,
                        mode,
                        atomic: false,
                        total: items.length,
                        index: i,
                        outcome: result.outcome,
                      },
                    }
                  : null,
              );
        let processed: ProcessedBulkItem;
        const committed = out.some((p) => mayHaveCommitted(p.result));
        if (atomic) {
          processed = await entry();
        } else {
          try {
            processed = await entry();
          } catch (err) {
            if (!committed && !isWriteOutcomeUnknown(err)) throw err;
            processed = {
              result: { index: i, outcome: "errored", error: failedEntry(err) },
            };
          }
        }
        if (atomic && processed.result.outcome === "errored") {
          // One failure aborts the whole batch: thrown so the transaction
          // rolls back, carrying the entry's refusal out.
          throw bulkAtomicRollback(i, {
            code: processed.result.error?.code,
            message: processed.result.error?.message,
            details: processed.result.error?.details,
          });
        }
        out.push(processed);
      }
      return out;
    };

    // Atomic: one transaction around the page, each entry a savepoint of
    // it. Best-effort: each entry its own transaction, opened by the write.
    const processed = atomic
      ? await runAuditedTransaction(storage, run, (processed) => ({
          client_ip: c.get("clientIp") ?? null,
          key_id: key.id,
          action: "items.bulk",
          resource_type: "items.bulk",
          details: {
            operation_id: operationId,
            mode,
            atomic,
            total: items.length,
            ...countOutcomes(processed.map(({ result }) => result)),
          },
        }))
      : await run();
    const results = processed.map((p) => p.result);

    const counts = countOutcomes(results);

    return c.json({ counts, results }, 200);
  });

  // POST /items/bulk-actions — filter-in
  router.openapi(bulkActionRoute, async (c) => {
    const body = c.req.valid("json");
    const action = body.action;
    const filter = body.filter ?? {};
    const dryRun = body.dry_run ?? false;

    const cap = Math.min(
      body.max_items ?? MAX_BULK_ACTION_ITEMS,
      MAX_BULK_ACTION_ITEMS_HARD,
    );

    // **Purge asks for `items.purge`, the same permission the single-item
    // door asks for.** It is the same act on more rows, and a caller that may
    // destroy one row irrecoverably may destroy a hundred; a second, stricter
    // gate here would only mean the permission a person granted did not mean
    // what the consent screen said. Every other action falls back to
    // type-permission narrowing via `computeTypeFilter`, so a caller holding
    // less sees its match set reduced rather than refused.
    if (action === "purge") {
      requireAuth(c);
      requirePermission(c, "items.purge");
      if (body.confirm !== "PURGE") {
        throw new MarfaError(
          ErrorCode.BULK_CONFIRMATION_REQUIRED,
          'Purge requires { "confirm": "PURGE" }',
        );
      }
    } else {
      requireAuth(c);
    }

    // Read from the raw body rather than the validated one, which has
    // already had an unknown key stripped from it.
    //
    // This is the door where silence costs the most. The filter *is* the
    // match set, so a dropped bound does not narrow anything: `{"action":
    // "purge", "filter": {"occurred_before": "..."}}` becomes a purge with
    // an empty filter, matching every item stored. Under the match
    // cap it does not even error — it succeeds, against everything.
    //
    // After the auth gates rather than before them, matching the other
    // two doors. Nothing leaked either way — schema validation already
    // ran ahead of both — but a request that has not been authorized has
    // no claim on the shape of its own refusal.
    const rawBody: unknown = await c.req.json().catch(() => undefined);
    if (typeof rawBody === "object" && rawBody !== null) {
      const raw = rawBody as { filter?: unknown };
      // The envelope first, then what it carries. The envelope is the more
      // dangerous of the two: `dry_run` is read as `?? false`, so a
      // misspelling is stripped and the action runs for real. `confirm` is
      // checked by name, which is why `purge` fails safe and nothing else
      // does.
      refuseUnknownBodyKeys(raw, BULK_ACTION_SHAPES[action]);
      // Then the filter. Unconditional on this door regardless of what the
      // read doors do: a dropped filter field here is not a narrower match
      // set but every item, and under the match cap it succeeds.
      refuseUnknownFilterKeys(raw.filter, BulkActionFilterShape);
    }

    // Validate filter fields up-front so a caller with a bad filter gets
    // a 400 before any matching happens.
    if (filter.type) {
      if (!isValidTypeIdentifier(filter.type)) {
        throw malformedTypeIdentifier(
          "filter.type",
          `Invalid type identifier: ${filter.type}`,
        );
      }
      // The type is named outright, so a credential that may not read it is
      // told so rather than handed a match set of nothing. Readable and not
      // writable is still narrowed to nothing below, as it is for a filter
      // naming no type. Registration is not asked: this door takes no
      // pattern, so the name is the only way to select the rows a type
      // removed with `force` left behind.
      assertTypeReadable(c, filter.type);
    }
    if (
      action === "update_occurred_at" &&
      !isValidTimestamp(body.occurred_at)
    ) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "occurred_at must be an ISO 8601 string",
      );
    }
    if (action === "update_tags") {
      const addCount = body.add?.length ?? 0;
      const removeCount = body.remove?.length ?? 0;
      if (addCount === 0 && removeCount === 0) {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          "update_tags requires at least one of `add` or `remove`",
        );
      }
      // The same bound the single-item tag doors put on a body, and the same
      // reason: an `add` array over it cannot land on any row the action
      // matches, so accepting the request only defers a refusal into a job's
      // error list, once per matched item. The store still bounds what the
      // merged set may reach; this bounds what may be asked for.
      if (addCount > MAX_TAGS_PER_ITEM) {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `Maximum ${String(MAX_TAGS_PER_ITEM)} tags per item`,
        );
      }
    }

    let callerKey = c.get("apiKey");
    assertFilterEdgeTermsReadable(c, filter.filter);

    // Purge permission does not grant write access to every type.
    let { allowed: allowedTypes, excluded: excludedTypes } = getTypeFilter(
      c,
      "write",
    );

    // Selection discloses IDs, so it uses the source filter that read doors use.
    const instanceConfigForAction = await readInstanceConfig(storage.settings);
    const enforcementForAction = resolveEnforcement(
      instanceConfigForAction,
      callerKey,
    );

    // A purge naming the ids its dry run returned is narrowed while the
    // match set is gathered, so a row the filter reached since is never
    // handed to the worker, and the cap counts what the purge takes rather
    // than what the filter reaches.
    const expected =
      action === "purge" && body.expected_ids !== undefined
        ? new Set(body.expected_ids)
        : undefined;

    // Paginate through matches up to cap+1. The +1 lets us distinguish
    // "exactly at cap" from "over the cap" without a second COUNT query.
    const matched: Item[] = [];
    const credentialId = callerKey?.id ?? null;
    const authorizeSelection = async () => {
      await authorizeReplay(
        c,
        storage,
        matched.map(({ id, type }) => ({
          kind: "item" as const,
          id,
          type,
          level: "write" as const,
          permissionOnly: false,
        })),
      );
      if (enforcementForAction.source_filter) {
        for (let offset = 0; offset < matched.length; offset += 500) {
          const current = await storage.items.getMany(
            matched.slice(offset, offset + 500).map(({ id }) => id),
            { includeTrashed: true },
          );
          const hidden = await sourceHiddenItemIds(
            storage,
            current,
            enforcementForAction.source_filter,
          );
          if (hidden.size > 0)
            throw new MarfaError(
              ErrorCode.FORBIDDEN,
              "The selection must be repeated under the current source filter.",
            );
        }
      }
    };
    const refreshAuthority = async () => {
      const live = await resolveLiveCredential(storage, credentialId, {
        tokenOutlivesExpiry: false,
      });
      c.set("apiKey", live?.key);
      requireAuth(c);
      const grant = c.get("oauthGrant");
      if (live?.kind === "oauth" && grant)
        c.set("oauthGrant", { ...grant, scopes: live.permissions });
      getTypeFilter(c);
      if (action === "purge") requirePermission(c, "items.purge");
      assertFilterEdgeTermsReadable(c, filter.filter);
      const currentEnforcement = resolveEnforcement(
        await readInstanceConfig(storage.settings),
        live?.key,
      );
      // Selection is private until it is returned or queued. A changed
      // source lever requires a fresh selection, without disclosing its old
      // count or identifiers or implementing another copy of that filter.
      if (
        JSON.stringify(currentEnforcement.source_filter) !==
        JSON.stringify(enforcementForAction.source_filter)
      )
        throw new MarfaError(
          ErrorCode.FORBIDDEN,
          "The source filter changed while selecting this action. Retry the request.",
        );
      if (
        JSON.stringify(callerKey?.type_permissions) !==
        JSON.stringify(live?.key.type_permissions)
      )
        await authorizeSelection();
      callerKey = live?.key;
      ({ allowed: allowedTypes, excluded: excludedTypes } = getTypeFilter(
        c,
        "write",
      ));
    };
    let cursor: string | undefined;
    do {
      const page = await storage.items.list({
        type: filter.type,
        state: filter.state,
        source: filter.source,
        tier: filter.tier,
        tags: filter.tags,
        filter: filter.filter,
        // What the caller reads, not writes: an edge is readable by its source.
        readable_sources: computeTypeFilter(callerKey, "read"),
        allowed_types: allowedTypes,
        excluded_types: excludedTypes,
        // Per row, from the row's own type, as on every read door.
        source_filter: enforcementForAction.source_filter,
        // Naming system types still requires the canonical reserved-namespace write gate.
        exclude_system_types: !(
          namesSystemNamespace(filter.type) &&
          callerKey !== undefined &&
          mayWriteReserved(callerKey, filter.type ?? "")
        ),
        occurred_after: filter.occurred_after,
        occurred_before: filter.occurred_before,
        limit: expected ? 200 : Math.min(200, cap + 1 - matched.length),
        cursor,
      });
      for (const item of page.data) {
        if (expected && !expected.has(item.id)) continue;
        rememberItemSubject(item, "write");
        matched.push(item);
        if (matched.length > cap) break;
      }
      cursor =
        matched.length <= cap && matched.length !== expected?.size
          ? (page.next_cursor ?? undefined)
          : undefined;
      if (cursor) {
        await yieldBulkWork();
        await refreshAuthority();
      }
    } while (cursor);

    await refreshAuthority();
    await authorizeSelection();

    if (matched.length > cap) {
      throw new MarfaError(
        ErrorCode.BULK_CAP_EXCEEDED,
        `Bulk action matched more than ${String(cap)} items`,
        { matched: matched.length, cap },
      );
    }

    // Dry run: report matched ids without mutating anything. No audit.
    if (dryRun) {
      return c.json(
        {
          action,
          matched: matched.length,
          succeeded: 0,
          errored: 0,
          dry_run: true,
          ids: matched.map((i) => i.id),
        },
        200,
      );
    }

    // Non-dry-run async path: INSERT a job row carrying the frozen matched
    // ids + the auth context; respond 202; the in-process worker
    // (packages/server/src/bulk-actions/worker.ts) picks the row up and
    // runs it.
    //
    // Publishing belongs to whoever performs the write, and the write
    // happens in the worker: this handler freezes a match set and answers
    // 202. `enable_fanout` is never read here for that reason — it travels
    // to the worker inside the stored input, which is the request body
    // verbatim.
    const apiKeyId = c.get("apiKey")?.id ?? null;
    const job = await runAuditedTransaction(
      storage,
      () =>
        storage.bulkActionJobs.create({
          id: generateId(),
          api_key_id: apiKeyId,
          credential: credentialHandle(c),
          action,
          input: JSON.stringify(body),
          matched_ids: JSON.stringify(matched.map((i) => i.id)),
          matched_count: matched.length,
          created_at: new Date().toISOString(),
        }),
      (job) => ({
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: "items.bulk_action",
        resource_type: "items.bulk_action",
        details: {
          sub_action: action,
          matched: matched.length,
          job_id: job.id,
        },
      }),
    );
    notifyBulkJobEnqueued();

    return c.json(jobRowToEnvelope(job), 202);
  });

  // GET /items/bulk-actions/jobs/:id — poll status.
  router.openapi(bulkActionStatusRoute, async (c) => {
    requireAuth(c);
    const id = c.req.valid("param").id;
    const job = await storage.bulkActionJobs.getById(id);
    if (!job) {
      throw new MarfaError(ErrorCode.BULK_JOB_NOT_FOUND, "Job not found");
    }
    assertJobAuth(c, job);
    return c.json(jobRowToEnvelope(job), 200);
  });

  // DELETE /items/bulk-actions/jobs/:id — request cancellation.
  router.openapi(bulkActionCancelRoute, async (c) => {
    requireAuth(c);
    const id = c.req.valid("param").id;
    const { after } = await runAuditedTransaction(
      storage,
      async () => {
        const existing = await storage.bulkActionJobs.getById(id);
        if (!existing)
          throw new MarfaError(ErrorCode.BULK_JOB_NOT_FOUND, "Job not found");
        assertJobAuth(c, existing);
        await storage.bulkActionJobs.cancel(id, new Date().toISOString());
        const after = await storage.bulkActionJobs.getById(id);
        if (!after)
          throw new MarfaError(ErrorCode.BULK_JOB_NOT_FOUND, "Job not found");
        return { after, changed: after.status !== existing.status };
      },
      ({ changed }) =>
        changed
          ? {
              client_ip: c.get("clientIp") ?? null,
              key_id: requireAuth(c).id,
              action: "items.bulk_action.cancel",
              resource_type: "items.bulk_action",
              resource_id: id,
            }
          : null,
    );
    return c.json(jobRowToEnvelope(after), 200);
  });

  return router;
}

// Who may read or cancel a job, in the order the checks run:
//
//   - the operator key reaches any job, which is what the instance tier is;
//   - anyone else reaches only jobs their own credential created, since
//     separate credentials do not observe each other's bulk_action jobs;
//   - a job another credential created is refused, not cloaked: its
//     existence is not a secret, only its contents.
//
// `bulkActionJobs.getById` applies no filter, so this function is the whole
// fence.
function assertJobAuth(c: Context<AppEnv>, job: BulkActionJobRow): void {
  const apiKey = c.get("apiKey");
  if (!apiKey) {
    throw new MarfaError(ErrorCode.UNAUTHORIZED, "Missing credential");
  }
  // Operator authority reaches every job: `bulkActionJobs.getById` is
  // deliberately unscoped, so this is the only fence.
  if (apiKey.is_operator) return;
  // **A job belongs to the credential that started it, and to nothing else.**
  // No permission says "read another credential's bulk jobs", and an arm
  // admitting an administrator to any job anyone else had started would need
  // one invented for it — widening the model to fit a line rather than the
  // other way round. A signed-in app is its app and person, so the token it
  // refreshes to still owns what the earlier token queued.
  if (credentialHandle(c) === job.credential) return;
  // The job's existence is not a secret, only its contents, so this is a
  // 403 rather than a cloaked 404.
  throw new MarfaError(
    ErrorCode.FORBIDDEN,
    "This job belongs to a different credential",
  );
}

// Render a server-internal row as the envelope shape a caller reads. Strips
// `matched_ids` (frozen list — large, not useful to callers), `input`
// (already known to the caller), `worker_id`, `worker_heartbeat_at`,
// `api_key_id`. Parses the JSON-encoded `result` if present.
function jobRowToEnvelope(
  job: BulkActionJobRow,
): z.infer<typeof BulkActionJobSchema> {
  const envelope: z.infer<typeof BulkActionJobSchema> = {
    id: job.id,
    action: job.action,
    status: job.status,
    matched: job.matched_count,
    processed: job.processed_count,
    succeeded: job.succeeded_count,
    errored: job.errored_count,
  };
  if (job.started_at) envelope.started_at = job.started_at;
  if (job.finished_at) envelope.finished_at = job.finished_at;
  if (job.error) envelope.error = job.error;
  if (job.result) {
    envelope.result = JSON.parse(job.result) as BulkActionResultType;
  }
  return envelope;
}
