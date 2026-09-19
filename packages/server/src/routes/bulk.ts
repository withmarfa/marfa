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
 * Both endpoints write one aggregate audit entry per call (never N per-item
 * rows), and both append to the event log for every row they write. That
 * append is unconditional: the log is what a client rebuilding its state
 * replays, so a write missing from it is one that client can never learn
 * about.
 *
 * `enable_fanout` governs the outbound work instead — webhook delivery and
 * the integration reactions the bridge enqueues — and defaults off, because
 * one call here writes thousands of rows and a delivery per row per
 * subscriber is not what the caller asked for.
 */

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
  validateProperties,
  getTypeSchema,
  resolveEnforcement,
} from "@withmarfa/shared";
import type { Item, Metadata } from "@withmarfa/shared";
import {
  mergeUpdateProperties,
  resolveIncomingProperties,
} from "../storage/merge-properties.js";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireSpacePermission,
  requireAuth,
  requireTypeAccess,
  requireEdgePermission,
  requireMirrorProtection,
  mayWriteReserved,
  requireDeclaredTypeMatches,
  permitsMirrorWrite,
  itemProvenanceSource,
  getTypeFilter,
} from "../middleware/auth.js";
import { MAX_TAGS_PER_ITEM } from "../tag-limits.js";
import { namesSystemNamespace } from "./_system-type-visibility.js";
import type { BulkActionJobRow, Storage } from "../storage/interface.js";
import { readSpaceConfig } from "../storage/space-config.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { publish } from "../pubsub.js";
import { applyInlineEdges, announceInlineEdges } from "./_edges-inline.js";
import type { InlineEdgeChanges } from "./_edges-inline.js";
import { assertTierApplicable } from "./_tier-rules.js";
import { ItemStateEnum } from "./_schemas.js";
import { notifyBulkJobEnqueued } from "../bulk-actions/enqueue-signal.js";
import {
  BULK_ACTION_SHAPES,
  BulkActionFilterShape,
  BulkActionInputSchema,
  BulkActionJobSchema,
  type BulkActionResult as BulkActionResultType,
} from "../bulk-actions/types.js";
import {
  refuseUnknownBodyKeys,
  refuseUnknownFilterKeys,
  UNKNOWN_FILTER_FIELD_NOTE,
} from "./_unknown-query-keys.js";

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
  id: z.string().optional(),
  type: z.string(),
  properties: z.record(z.string(), z.unknown()).optional(),
  /** Every state the platform has, not the three a non-system type can
   *  reach. Naming a state its type's lifecycle does not contain is
   *  refused further down by `validateTransition`, which gives each type
   *  its own answer — and that is the gate `POST /items` uses, where the
   *  same create in `revoked` on a `system.*` type succeeds. A narrower
   *  enum here refused it before the graph was consulted, so the two
   *  create doors disagreed. */
  state: ItemStateEnum.optional(),
  tier: z.enum(["library", "feed"]).optional(),
  occurred_at: z.string().optional(),
  /** Ignored on the wire — server stamps `source` from the credential. */
  source: z.string().optional(),
  source_id: z.string().optional(),
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
      "The version this entry was based on, where it resolves a row that already exists. Optional, as on `POST /items`: an entry creating a row it has never read has no version to name. A stale one is refused like every other per-entry refusal here — the page rolls back under the default `atomic`, carrying `version_conflict` in `details.code`, or it is that entry's own `errored` outcome when `atomic` is false.",
    ),
  device: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** Inline edges (replace-all semantics per edge_type) applied after
   *  create/update in the same transaction. Absent means leave edges
   *  untouched. */
  edges: z.record(z.string(), z.array(z.string())).optional(),
});

const BulkResultOutcomeSchema = z.enum([
  "created",
  "updated",
  "skipped",
  "errored",
]);

const BulkResultEntrySchema = z.object({
  index: z.number().int(),
  outcome: BulkResultOutcomeSchema,
  id: z.string().optional(),
  reason: z.string().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

const BulkResponseSchema = z.object({
  counts: z.object({
    created: z.number().int(),
    updated: z.number().int(),
    skipped: z.number().int(),
    errored: z.number().int(),
  }),
  results: z.array(BulkResultEntrySchema),
});

// The request shape is `BulkActionInputSchema`, declared once in the
// bulk-action substrate and imported here. The filter half was deduped
// first and the envelope around it was left behind, which is the same
// two-declarations-of-one-thing that let `dry_run` and `max_items` drift
// out of step with the copy the specification is generated from.

const BulkActionErrorSchema = z.object({
  id: z.string(),
  code: z.string(),
  message: z.string(),
});

const BulkActionResponseSchema = z.object({
  action: z.string(),
  matched: z.number().int(),
  succeeded: z.number().int(),
  errored: z.number().int(),
  dry_run: z.boolean(),
  ids: z.array(z.string()).optional(),
  errors: z.array(BulkActionErrorSchema).optional(),
  /** Unique blob hashes referenced by the items that were purged. Not a
   *  strict orphan count — callers that need a true reference scan should
   *  consult the blob GC job once it lands. Omitted for non-purge actions. */
  blob_hashes_referenced: z.number().int().optional(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const bulkRoute = createRoute({
  method: "post",
  path: "/bulk",
  operationId: "bulkUpsertItems",
  tags: ["Items"],
  summary: "Bulk upsert items",
  description:
    "Creates or upserts up to 5000 items in one call, matching existing rows on `(source, source_id)`. Atomic by default; `source` is server-stamped from the credential, so any caller-supplied value is overwritten. Requires write access to each item's type — the credential's own type permissions decide, and nothing bypasses them — and operates only within the caller's space.\n\nAn entry that resolves a row of a different type is refused with `type_mismatch` — a write does not re-type the row it lands on. Passing `retype: true` for the batch moves those rows instead, which is how a corpus is brought onto a type a mapping now names. It is opt-in rather than inferred from a differing type, because a declared type accompanies nearly every write and inferring would move a corpus on an ordinary sync bug. Each move requires write on the type being entered as well as the one being left, and the resulting properties are validated against the destination: an item the destination type cannot accept is reported as an `errored` entry naming why, and the rest of the batch proceeds.\n\nAn ordinary update is validated too, against the row's own type and on the properties the write would leave on it rather than on the body alone, so a patch removing a required field is refused even though it names no invalid value. A refusal is an `errored` entry under `invalid_properties`; with the default `atomic` it rolls the page back instead, carrying that code in `details.code`. An entry may also carry the `version` it was based on, which makes its upsert conditional and is refused the same two ways.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(BulkInputItemSchema),
            mode: z.enum(["upsert", "create_only"]).optional(),
            atomic: z.boolean().optional(),
            enable_fanout: z.boolean().optional(),
            retype: z.boolean().optional(),
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
      description: "Bulk upsert result",
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
        "Validation error, or an atomic rollback. `atomic` defaults to " +
        "true, so a single refused entry aborts the whole page and the " +
        "per-entry reason travels in `details.code` — `type_mismatch` " +
        "among them, when an entry declares a `type` that is not the " +
        "type of the row its natural key or id resolved. Send " +
        "`atomic: false` to have each entry reported on its own instead.",
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
          schema: makeErrorResponseSchema(["forbidden", "type_not_permitted"]),
        },
      },
      description: "Write access denied for one of the item types",
    },
  },
});

const bulkActionRoute = createRoute({
  method: "post",
  path: "/bulk-actions",
  operationId: "applyBulkAction",
  tags: ["Items"],
  summary: "Apply a bulk action",
  description:
    "Applies one action (transition, purge, retag, retier, or a property or own-time update) to every item matching a filter. Non-dry-run calls queue an async job; `dry_run: true` returns the matched ids without writing, and `max_items` caps the match set before a `bulk_cap_exceeded` error.\n\n" +
    UNKNOWN_FILTER_FIELD_NOTE,
  security: [{ bearerAuth: [] }],
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
        "application/json": { schema: BulkActionResponseSchema },
      },
      description: "Dry-run result (synchronous; non-dry-run goes async)",
    },
    202: {
      content: { "application/json": { schema: BulkActionJobSchema } },
      description:
        "Job queued. Poll GET /items/bulk-actions/jobs/{id} until status is terminal (completed / failed / cancelled). SDKs do this transparently for callers; the envelope is exposed for explicit-control use cases.",
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
      description: "Validation error, missing confirm, or cap exceeded",
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
      description: "`items.purge` required (purge only)",
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
  tags: ["Items"],
  summary: "Get a bulk-action job",
  description:
    'Returns the current state of an asynchronous bulk-action job; once terminal, `result` carries the outcome envelope. Readable by the credential that created it and by the operator key, and by nothing else: no space permission says "read another credential\'s bulk jobs". A job in another space reads as absent.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("Bulk-action job id."),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: BulkActionJobSchema } },
      description: "Current job state",
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
      description: "Not the originating credential, and not the operator key",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["bulk_job_not_found"]),
        },
      },
      description: "Job not found",
    },
  },
});

// Request cancellation. Idempotent — already-terminal rows return
// their final state without mutation. The worker observes the
// `cancelled` flag between chunks and stops; the response from this
// endpoint surfaces the row as-of-now, which may still show
// `in_progress` if the worker hasn't yet observed the flag.
const bulkActionCancelRoute = createRoute({
  method: "delete",
  path: "/bulk-actions/jobs/{id}",
  operationId: "cancelBulkActionJob",
  tags: ["Items"],
  summary: "Cancel a bulk-action job",
  description:
    "Signals cancellation of a bulk-action job. Queued jobs flip to `cancelled` immediately and in-progress jobs flip when the worker next checks between chunks; already-terminal jobs return their final state unchanged.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("Bulk-action job id."),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: BulkActionJobSchema } },
      description: "Job state after the cancel signal",
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
      description: "Not the originating credential, and not the operator key",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["bulk_job_not_found"]),
        },
      },
      description: "Job not found",
    },
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CreateInput = Parameters<Storage["items"]["create"]>[0];

/** One entry of the response array. This is the wire shape — it is handed
 *  to `c.json` as-is, and a response is documented rather than validated,
 *  so anything added here ships. */
interface BulkItemResult {
  index: number;
  outcome: "created" | "updated" | "skipped" | "errored";
  id?: string;
  reason?: string;
  error?: { code: string; message: string };
}

/**
 * What one processed entry yields: the wire entry, plus the row as written
 * when there was one.
 *
 * The row travels beside the wire object rather than inside it, exactly as
 * `processBulkEdge` returns its `created` / `updated`. It exists so the
 * publish loop does not read back what the batch just wrote, and it must
 * not reach the response: five thousand entries each carrying a full item,
 * on the endpoint this change was making cheaper, would more than undo the
 * saving. Keeping it out of `BulkItemResult` is what makes that structural
 * rather than a thing to remember at the boundary.
 */
interface ProcessedBulkItem {
  result: BulkItemResult;
  item?: Item;
}

/**
 * Apply inline edges replace-all-for-specified-types style. Any edge_type
 * in the map wipes existing outbound edges of that type from `itemId`,
 * then creates edges to each listed target. Empty arrays delete all edges
 * of that type. Unmentioned types are untouched. Matches PATCH /items/{id}
 * edge semantics.
 */
// applyInlineEdges lives in _edges-inline.ts (shared with the natural-key
// upsert short-circuit on POST /items).

/**
 * Process a single bulk-upsert input. Caller decides the transaction
 * envelope (one-big-tx for atomic mode, per-call for best-effort mode).
 */
async function processBulkItem(
  storage: Storage,
  raw: z.infer<typeof BulkInputItemSchema>,
  index: number,
  options: {
    mode: "upsert" | "create_only";
    stampedSource: string | undefined;
    /**
     * Whether the caller has already opened the batch transaction (atomic
     * mode) or runs each item bare (best-effort mode). `applyInlineEdges`
     * deletes then validates then recreates and relies on a transaction to
     * roll the deletes back when validation rejects the set. In atomic mode
     * the outer `runInTransaction` covers that; in best-effort mode this
     * function opens a per-item transaction around the edge reconciliation so
     * a rejected set doesn't strand the deletes. The transaction wrapper is
     * NOT reentrant on SQLite, so it must only ever be opened on the
     * best-effort path — never nested inside the atomic outer transaction.
     */
    atomic: boolean;
    /**
     * Opt-in re-typing on the update half of an upsert.
     *
     * Off by default, and deliberately not inferred from a differing
     * type: the fleet declares a type on nearly every write, so inferring
     * would move a corpus on somebody's ordinary sync bug. When on, an
     * entry that resolves a row of another type moves that row instead of
     * being refused — the operation `requireDeclaredTypeMatches` says a
     * caller meaning to move a corpus has.
     *
     * Per batch rather than per entry, because the caller asking for it
     * is answering one question about one corpus rather than making a
     * judgment per record.
     */
    retype: boolean;
    /**
     * Per-item write authorization. Mirrors the single-item `POST /items`
     * gate (`requireTypeAccess(c, type, "write")`): the credential must hold
     * write on the item's type, and nothing bypasses that. Throws
     * `TYPE_NOT_PERMITTED` (403) which surfaces as a per-item `errored`
     * outcome in best-effort mode and aborts the batch in atomic mode.
     *
     * Takes the whole item rather than its type so both call sites stay
     * covered by construction rather than by remembering.
     *
     * Authorizes the *claim*, which is the whole story only on the
     * create path, where the row that lands is the one the entry
     * describes. An update is authorized by `checkUpdate` instead.
     */
    checkWrite: (raw: { type: string; properties?: unknown }) => void;
    /**
     * Authorization for the update half of an upsert, against the row
     * being overwritten rather than the entry describing it.
     *
     * An entry that carries an `id` addresses a row directly, and so
     * does one that carries a natural key: neither resolution consults
     * the entry's `type`, so the write lands on whatever type that row
     * already is. Authorizing the claim therefore checks a type nothing
     * is about to be written to: naming a type the credential does hold
     * write on admits an update to a row of any other type, and skips
     * every gate keyed on the real one. `PATCH /items/{id}` accepts a
     * `type` too, but never authorizes against it — there it is checked
     * for agreement with the row and otherwise ignored, which is what
     * makes the doors agree.
     *
     * Authorizing against the row closes the escalation. It does not make
     * the entry's `type` meaningful, and a claim that disagrees with the
     * row used to be merged in regardless — so the caller is separately
     * held to the type it named, by `requireDeclaredTypeMatches` at the
     * call site below.
     */
    checkUpdate: (
      existing: Item,
      raw: { properties?: Record<string, unknown> },
    ) => void;
    /**
     * The edge half of the dual gate, mirroring `requireEdgePermission` on
     * `POST /edges` and on `POST /items` with an inline `edges` payload.
     * Edge writes need write on the source item's type AND on the edge
     * type; `checkWrite` above is only the first of those, so without this
     * a credential refused an edge on the direct routes could create the
     * same edge here — and clear existing ones, since an empty target list
     * is a delete instruction.
     */
    checkEdgeWrite: (edgeType: string) => void;
    /**
     * Where this item's inline-edge changes go, for the caller to
     * announce once its transaction has committed. A callback rather
     * than a return value because the edges are written several layers
     * below the result this function reports.
     */
    recordEdgeChanges: (changes: InlineEdgeChanges) => void;
  },
): Promise<ProcessedBulkItem> {
  if (!isValidTypeIdentifier(raw.type)) {
    return {
      result: {
        index,
        outcome: "errored",
        error: {
          code: ErrorCode.INVALID_TYPE,
          message: `Invalid type identifier: ${raw.type}`,
        },
      },
    };
  }

  const {
    mode,
    stampedSource,
    atomic,
    retype,
    checkWrite,
    checkUpdate,
    checkEdgeWrite,
    recordEdgeChanges,
  } = options;

  // Reconcile inline edges. `applyInlineEdges` deletes-then-validates-then-
  // recreates and needs a transaction so a validation failure rolls the
  // deletes back. Atomic mode already runs inside the outer batch
  // transaction; best-effort mode runs each item bare, so wrap the edge step
  // here. The SQLite transaction wrapper is not reentrant — only open one on
  // the best-effort path.
  const reconcileEdges = async (
    id: string,
    edgeSet: Record<string, string[]>,
  ): Promise<void> => {
    // Handed to the caller rather than announced here. In atomic mode
    // this runs inside the batch transaction, so a publish from here
    // would describe edges a later item's failure then rolls back.
    recordEdgeChanges(
      atomic
        ? await applyInlineEdges(storage, id, edgeSet, checkEdgeWrite)
        : await storage.runInTransaction(() =>
            applyInlineEdges(storage, id, edgeSet, checkEdgeWrite),
          ),
    );
  };

  try {
    checkWrite(raw);
  } catch (err) {
    if (err instanceof MarfaError) {
      return {
        result: {
          index,
          outcome: "errored",
          error: { code: err.code, message: err.message },
        },
      };
    }
    throw err;
  }

  // What a caller may *send*, which is this door's question rather than the
  // store's: a hundred and one copies of one tag projects to a single tag, so
  // the store would accept it and should. The same check the single-item
  // create runs, and it has to be here because the create arm below writes
  // tags through `storage.items.create` — the archive restore's writer, left
  // unbounded on purpose so an archive of rows written before this rule
  // existed stays restorable.
  if (raw.tags && raw.tags.length > MAX_TAGS_PER_ITEM) {
    return {
      result: {
        index,
        outcome: "errored",
        ...(raw.id !== undefined && { id: raw.id }),
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: `Maximum ${String(MAX_TAGS_PER_ITEM)} tags per item`,
        },
      },
    };
  }

  const sourceId = raw.source_id;

  let existing: Item | null = null;
  let matchedBy: "source_id" | "id" | null = null;
  if (stampedSource && sourceId) {
    existing = await storage.items.findBySourceId(stampedSource, sourceId);
    if (existing) matchedBy = "source_id";
  }
  // Fall back to primary-id lookup when no (source, source_id) match was
  // found AND the caller supplied an id. This is the path offline-first
  // clients take: the Swift / TS SDKs assign UUIDs locally and expect
  // `mode: upsert` to update by id when the row already exists
  // server-side (e.g. migrating a local-mode Notes store that was
  // partially synced earlier). Without this fallback the code below
  // would fall through to `storage.items.create(...)`, which trips a
  // unique-constraint violation and surfaces as an opaque 500.
  if (!existing && raw.id !== undefined) {
    // `create_only` decides on presence, not on state. A repeat landing
    // on a row the user has since trashed is still a repeat, and hiding
    // the row here sends it to `create`, which trips the primary key and
    // — since `atomic` defaults to true — rolls the whole batch back for
    // a write the server already performed. `upsert` keeps the narrower
    // lookup: there the match is an instruction to write, and a trashed
    // row is not something a re-sync silently edits.
    existing =
      mode === "create_only"
        ? await storage.items.getIncludingTrashed(raw.id)
        : await storage.items.get(raw.id);
    if (existing) matchedBy = "id";
  }

  // create_only: existing match → skipped. No writes.
  if (existing && mode === "create_only") {
    return {
      result: {
        index,
        outcome: "skipped",
        id: existing.id,
        reason: matchedBy === "id" ? "duplicate_id" : "duplicate_source",
      },
    };
  }

  // upsert + existing: update properties/tier/occurred_at in place,
  // optionally reconciling edges.
  if (existing) {
    // Authorize against the row about to be overwritten. The entry's own
    // `type` is not what is being written — it describes a create that is
    // no longer happening — so it is checked for agreement rather than
    // used.
    try {
      checkUpdate(existing, { properties: raw.properties });
      // Both resolutions above land here, and neither used the entry's
      // `type` to get here: the natural key ignores it, and the id
      // fallback ignores it too. Declaring one type and resolving another
      // was merged in silently, per entry, inside a page of thousands.
      // Same guard the single-item door runs.
      //
      // Blast radius differs from the single-item doors and it is worth
      // knowing which mode you are in. `atomic` defaults to true, so one
      // refused entry rolls the page back as `bulk_atomic_rollback`, a
      // 400 carrying this refusal in `details.code` rather than the 409
      // the other doors answer with. That is this route's established
      // answer to any per-entry refusal rather than something new here.
      if (!(retype && raw.type !== existing.type)) {
        requireDeclaredTypeMatches(raw.type, existing);
      }
      // A re-type needs write on the type being entered as well as the
      // one being left, and both are already held: `checkUpdate` above
      // covers the row's own type, and every entry's declared type is
      // authorized by the `checkWrite` at the top of this function,
      // before resolution. Repeating it here read as belt and braces and
      // was dead code — the door refuses `user.dest_log` to a caller
      // without it whether or not the re-type arm asks again. The test
      // pins the outcome rather than this call site, so the guarantee
      // survives that gate moving.
    } catch (err) {
      if (err instanceof MarfaError) {
        return {
          result: {
            index,
            outcome: "errored",
            id: existing.id,
            error: { code: err.code, message: err.message },
          },
        };
      }
      throw err;
    }

    // The type the row ends up as. Without a re-type that is the
    // resolved row's own, never the entry's claim; with one it is the
    // entry's, and everything judged below has to be judged against the
    // destination rather than the origin — validating a move against the
    // type being left would admit one whose result the destination calls
    // invalid, which is the whole hazard of moving a corpus.
    const resultingType =
      retype && raw.type !== existing.type ? raw.type : existing.type;
    const isMove = resultingType !== existing.type;
    // Both arms, and it used to be only the move. A same-type update ran
    // no property validation at all, so this door stored the number 12345
    // into `core.note.body`, a required string, and reported the entry as
    // `updated`, while `PATCH /items/{id}` refuses the identical payload. The row was then invalid against its own type for every
    // reader that trusts the declared shape because the server enforced
    // it, and the door that skipped the check is the one built for volume.
    //
    // A move cannot go without it either, for its own reason: the
    // destination may require fields the row has never carried, and its
    // field types may not accept what the old properties hold.
    //
    // Judged on the properties the store is about to write, through the
    // same helper it merges with, so this predicts the write rather than
    // approximating it — and against the type the row ends up as, because
    // judging a move against the type being left would admit one whose
    // result the destination calls invalid.
    if (isMove || raw.properties !== undefined) {
      const merged = mergeUpdateProperties(
        existing.properties,
        // Through `resolveIncomingProperties` rather than the raw payload,
        // because that is the first thing the store does with it: it drops a
        // `null` on any field the type does not require, so a body clearing an
        // optional field writes nothing for it. Judging the raw payload
        // validated a row carrying that `null` while the store wrote the old
        // value — which is exactly the shape an integration's re-sync sends,
        // and it is the difference between predicting the write and
        // approximating it. `existing.type` rather than the destination for
        // the same reason: the store resolves against the row's own type.
        resolveIncomingProperties(existing.type, raw.properties, false) ?? {},
        false,
        "merge",
      );
      // The move stays unguarded, which is not an oversight: a destination
      // with nothing registered is a destination that does not exist, and
      // `validateProperties` answering `Unknown type` is the right refusal
      // for a move into it. A same-type update cannot say that about the
      // row's own type without refusing every write to a type whose schema
      // this request's registry does not carry, so it asks first — the
      // same guard the single-item door runs.
      if (isMove || getTypeSchema(resultingType) !== undefined) {
        const validation = validateProperties(resultingType, merged);
        if (!validation.success) {
          // Named, not counted, and not a reason to abandon the rest — the
          // point of moving a corpus per item is that some of it cannot go,
          // and the point of validating an ordinary update is that the one
          // bad record is identifiable.
          const detail = validation.errors
            .map((e) => `${e.field}: ${e.message}`)
            .join("; ");
          return {
            result: {
              index,
              outcome: "errored",
              id: existing.id,
              error: {
                code: ErrorCode.INVALID_PROPERTIES,
                message: isMove
                  ? `Cannot move item to "${resultingType}": ${detail}`
                  : `Invalid properties: ${detail}`,
              },
            },
          };
        }
      }
    }
    assertTierApplicable(resultingType, raw.tier);
    const updated = await storage.items.update(existing.id, {
      properties: raw.properties,
      ...(resultingType === existing.type ? {} : { type: resultingType }),
      tier: raw.tier,
      occurred_at: raw.occurred_at,
      ...(raw.version !== undefined && { version: raw.version }),
    });
    if ("error" in updated) {
      // Reachable only for an entry that named a version. The message comes
      // off the store's own refusal rather than being written here, because
      // the two codes it can carry say different things: one is a stale
      // version, the other a base version no snapshot still covers.
      return {
        result: {
          index,
          outcome: "errored",
          id: existing.id,
          error: {
            code: updated.error.code,
            message: updated.error.message,
          },
        },
      };
    }

    if (raw.tags) {
      await storage.metadata.set(existing.id, raw.tags);
    }
    if (raw.edges) {
      // Inline-edge reconciliation can reject the proposed set (cardinality,
      // type constraint, cycle). Surface it as a per-item `errored` outcome
      // so best-effort mode reports it per item and atomic mode rolls the
      // whole batch back via `bulk_atomic_rollback` — matching the create
      // branch below.
      try {
        await reconcileEdges(existing.id, raw.edges);
      } catch (err) {
        if (err instanceof MarfaError) {
          return {
            result: {
              index,
              outcome: "errored",
              id: existing.id,
              error: { code: err.code, message: err.message },
            },
          };
        }
        throw err;
      }
    }

    return {
      result: { index, outcome: "updated", id: updated.id },
      item: updated,
    };
  }

  // No match → create. Stamp source from credential; caller-supplied source
  // is ignored on the wire (preserves /import non-forgeability contract).
  try {
    assertTierApplicable(raw.type, raw.tier);
    // The same question `POST /items` asks, and it has to be asked here for
    // the same reason: a create is not a transition, so it reaches none of
    // the graph, and a membership test against the universal state list is
    // weaker than the one that matters. `trashed` is a valid state and is not
    // in the `system.*` lifecycle at all, so the operator key could
    // create a `system.connection` directly in `trashed` — a state no
    // transition can produce and none can leave — through this door while the
    // single-item door beside it refused.
    //
    // In the route rather than in `storage.items.create`, matching the
    // sibling: the store's `create` is also the archive restore's writer, and
    // an archive is a faithful record of rows written before this rule
    // existed. Tightening the store would make those unrestorable.
    if (raw.state && raw.state !== SYSTEM_DEFAULT_STATE) {
      const stateError = validateTransition(
        raw.type,
        SYSTEM_DEFAULT_STATE,
        raw.state,
      );
      if (stateError) {
        throw new MarfaError(ErrorCode.VALIDATION_ERROR, stateError);
      }
    }
    const createInput: CreateInput = {
      type: raw.type,
      properties: raw.properties ?? {},
      ...(raw.id !== undefined && { id: raw.id }),
      ...(raw.state !== undefined && { state: raw.state }),
      ...(raw.tier !== undefined && { tier: raw.tier }),
      ...(raw.occurred_at !== undefined && { occurred_at: raw.occurred_at }),
      ...(stampedSource !== undefined && { source: stampedSource }),
      ...(sourceId !== undefined && { source_id: sourceId }),
      ...(raw.device !== undefined && { device: raw.device }),
      ...(raw.tags !== undefined && { tags: raw.tags }),
    };
    const created = await storage.items.create(createInput);
    if (raw.edges) {
      await reconcileEdges(created.id, raw.edges);
    }
    return {
      result: { index, outcome: "created", id: created.id },
      item: created,
    };
  } catch (err) {
    if (err instanceof MarfaError) {
      return {
        result: {
          index,
          outcome: "errored",
          error: { code: err.code, message: err.message },
        },
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function bulkRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  // POST /items/bulk — list-in
  router.openapi(bulkRoute, async (c) => {
    // Authenticated + per-item type-write authorization, mirroring the
    // single-item `POST /items` gate: the credential must hold write on each
    // item's type, and nothing bypasses that.
    requireAuth(c);
    const checkWrite = (raw: { type: string; properties?: unknown }): void => {
      requireTypeAccess(c, raw.type, "write");
    };
    // The update half of an upsert, judged on the target row. Mirrors
    // `PATCH /items/{id}` gate for gate, because the two are the same
    // operation reached through different doors: the row's real type
    // decides the type gate, and the mirror rule answers to the row.
    const checkUpdate = (existing: Item): void => {
      requireTypeAccess(c, existing.type, "write");
      requireMirrorProtection(existing);
    };
    // The edge half of the dual gate. Same call the direct routes make,
    // so the three doors that accept an inline `edges` payload agree.
    const checkEdgeWrite = (edgeType: string): void => {
      requireEdgePermission(c, edgeType, "write");
    };

    const body = c.req.valid("json");
    const items = body.items;
    const mode = body.mode ?? "upsert";
    const atomic = body.atomic ?? true;
    // Off unless asked for. Never inferred from a differing type: the
    // fleet declares one on nearly every write, so inference would move a
    // corpus on an ordinary sync bug.
    const retype = body.retype === true;
    const enableFanout = body.enable_fanout ?? false;
    // Filled by each item's edge reconciliation and drained after the
    // batch commits, so an inline edge and the item that owns it reach
    // the log together. Declared here so an atomic rollback discards it
    // along with the writes it describes.
    const inlineEdgeChanges: InlineEdgeChanges[] = [];

    if (items.length > MAX_BULK_ITEMS) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Maximum ${String(MAX_BULK_ITEMS)} items per call`,
        { cap: MAX_BULK_ITEMS, provided: items.length },
      );
    }

    const stampedSource = itemProvenanceSource(c.get("apiKey"));

    if (items.length === 0) {
      return c.json(
        {
          counts: { created: 0, updated: 0, skipped: 0, errored: 0 },
          results: [],
        },
        200,
      );
    }

    // In atomic mode, pre-validate what can be checked without a database
    // round trip before any writing starts. The store rolls back for real,
    // so this is belt and braces rather than the mechanism. It is kept
    // because refusing a malformed type or instant before touching the
    // database gives the caller the reason rather than a rollback.
    if (atomic) {
      for (const [i, raw] of items.entries()) {
        if (!isValidTypeIdentifier(raw.type)) {
          throw new MarfaError(
            ErrorCode.BULK_ATOMIC_ROLLBACK,
            `Bulk upsert rolled back on item ${String(i)}`,
            {
              index: i,
              code: ErrorCode.INVALID_TYPE,
              message: `Invalid type identifier: ${raw.type}`,
            },
          );
        }
        if (
          raw.occurred_at !== undefined &&
          !isValidTimestamp(raw.occurred_at)
        ) {
          throw new MarfaError(
            ErrorCode.BULK_ATOMIC_ROLLBACK,
            `Bulk upsert rolled back on item ${String(i)}`,
            {
              index: i,
              code: ErrorCode.VALIDATION_ERROR,
              message: "occurred_at must be an ISO 8601 string",
            },
          );
        }
        // Authorize the write up-front so an unauthorized type aborts the
        // batch before any row lands (SQLite can't roll back async txns).
        try {
          checkWrite(raw);
        } catch (err) {
          if (err instanceof MarfaError) {
            throw new MarfaError(
              ErrorCode.BULK_ATOMIC_ROLLBACK,
              `Bulk upsert rolled back on item ${String(i)}`,
              { index: i, code: err.code, message: err.message },
            );
          }
          throw err;
        }
      }
    }

    const run = async (): Promise<ProcessedBulkItem[]> => {
      const out: ProcessedBulkItem[] = [];
      for (const [i, raw] of items.entries()) {
        const processed = await processBulkItem(storage, raw, i, {
          mode,
          stampedSource,
          atomic,
          retype,
          checkWrite,
          checkUpdate,
          checkEdgeWrite,
          recordEdgeChanges: (changes) => inlineEdgeChanges.push(changes),
        });
        if (atomic && processed.result.outcome === "errored") {
          // In atomic mode a single failure aborts the whole batch. Throw
          // so runInTransaction rolls back; carry the failure context out
          // via the error details.
          throw new MarfaError(
            ErrorCode.BULK_ATOMIC_ROLLBACK,
            `Bulk upsert rolled back on item ${String(i)}`,
            {
              index: i,
              code: processed.result.error?.code,
              message: processed.result.error?.message,
            },
          );
        }
        out.push(processed);
      }
      return out;
    };

    // atomic=true → one transaction wraps every item write. atomic=false
    // → each item gets its own transaction (composed inside storage.items
    // methods); route iterates without an outer wrapper.
    const processed = atomic
      ? await storage.runInTransaction(run)
      : await run();
    // The wire array, and nothing else. The written rows stay on
    // `processed` for the publish loop below.
    const results = processed.map((p) => p.result);

    const counts = { created: 0, updated: 0, skipped: 0, errored: 0 };
    for (const r of results) counts[r.outcome] += 1;

    // Published only after the batch commits, so a subscriber is never
    // told about a write a rollback then took away — an atomic batch that
    // rolled back throws and never reaches here.
    //
    // Every written row publishes. `enable_fanout` decides what happens
    // downstream of the log, not whether the row is logged.
    //
    // The rows come from the batch that wrote them rather than from a
    // second read: re-reading each item and its metadata put two queries
    // per row on a door that accepts five thousand of them, a cost the
    // old opt-in default kept out of sight.
    const published = processed.filter(
      (p): p is ProcessedBulkItem & { item: Item } =>
        p.item !== undefined &&
        (p.result.outcome === "created" || p.result.outcome === "updated"),
    );
    const metadataById = new Map<string, Metadata>();
    if (published.length > 0) {
      for (const m of await storage.metadata.getMany(
        published.map((r) => r.item.id),
      )) {
        metadataById.set(m.item_id, m);
      }
    }
    for (const r of published) {
      const metadata = metadataById.get(r.item.id);
      await publish({
        type: r.result.outcome === "created" ? "created" : "updated",
        item: r.item,
        ...(metadata && { metadata }),
        enableFanout,
      });
    }
    // Edges after the items, so a subscriber sees the endpoints before the
    // relationship naming them.
    for (const changes of inlineEdgeChanges) {
      await announceInlineEdges(changes, enableFanout);
    }

    await storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: c.get("apiKey")?.id,
      action: "items.bulk",
      resource_type: "items.bulk",
      details: {
        mode,
        atomic,
        total: items.length,
        ...counts,
      },
    });

    return c.json({ counts, results }, 200);
  });

  // POST /items/bulk-actions — filter-in
  router.openapi(bulkActionRoute, async (c) => {
    const body = c.req.valid("json");
    const action = body.action;
    const filter = body.filter ?? {};
    const dryRun = body.dry_run ?? false;
    const enableFanout = body.enable_fanout ?? false;

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
      requireSpacePermission(c, "items.purge");
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
    // an empty filter, matching every item in the space. Under the match
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
      // set but the whole space, and under the match cap it succeeds.
      refuseUnknownFilterKeys(raw.filter, BulkActionFilterShape);
    }

    // Validate filter fields up-front so a caller with a bad filter gets
    // a 400 before any matching happens.
    if (filter.type && !isValidTypeIdentifier(filter.type)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid type identifier: ${filter.type}`,
      );
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

    const callerKey = c.get("apiKey");

    // Narrowed to what the caller may *write*, which this comment claimed
    // before the code did it. The filter compiled readable patterns, so a
    // key holding `{"*": "read"}` arrived with nothing narrowed at all and
    // the actions below then wrote to everything it matched — a reach
    // `PATCH /items/{id}` refuses the same key on the same row. This door
    // runs no per-row permission check, so the filter is the whole of it.
    //
    // **Purge narrows here too, and that is new.** It used to be a no-op for
    // the only callers who reached purge, because a rank admitted them past
    // their maps. Under one model a caller purges what it may write: holding
    // `items.purge` says a credential may destroy rows irrecoverably, and
    // its type permissions say which.
    const { allowed: allowedTypes, excluded: excludedTypes } = getTypeFilter(
      c,
      "write",
    );

    // The space's source filter, resolved the way the four list reads resolve
    // it. This door passed nothing, so a match set included rows every read
    // hides.
    //
    // That is a defect rather than a policy call, and `dry_run` is what makes
    // it one: it answers with the matched ids, so this door is *already* a
    // list read, and one that bypassed the lever entirely. The lever exists
    // to stop a caller switching the control off by broadening a query, and
    // reaching the same rows by swapping endpoint is that hole with an extra
    // step. Once the query narrows, the actions behind it narrow with it,
    // because it is one query.
    //
    // The cost is real and worth knowing: an action aimed at a source the
    // filter excludes now matches nothing and reports `matched: 0` rather
    // than refusing, which is the shape of a filter that found nothing. A
    // Whoever needs those rows lifts the lever, acts, and restores it.
    const spaceConfigForAction = await readSpaceConfig(storage.settings);
    const enforcementForAction = resolveEnforcement(
      spaceConfigForAction,
      callerKey,
    );

    // The type axis is not the only one a caller can be narrower than: a
    // row an integration owns is not this caller's to patch. Narrowing
    // rather than refusing, because that is the answer this route already
    // gives on the type axis: a row the caller cannot write leaves the match
    // set, instead of failing an action over thousands of rows it
    // legitimately can.

    const patch = body.action === "update_properties" ? body.patch : undefined;
    // Property patches answer to the mirror rule; transitions and retiers
    // stay user gestures on rows an integration owns.
    const mayAct = (item: Item): boolean =>
      patch === undefined || permitsMirrorWrite(item);

    // Paginate through matches up to cap+1. The +1 lets us distinguish
    // "exactly at cap" from "over the cap" without a second COUNT query.
    const matched: Item[] = [];
    let cursor: string | undefined;
    do {
      const page = await storage.items.list({
        type: filter.type,
        state: filter.state,
        source: filter.source,
        tier: filter.tier,
        tags: filter.tags,
        filter: filter.filter,
        allowed_types: allowedTypes,
        excluded_types: excludedTypes,
        // Per row, from the row's own type, as on every read door.
        source_filter: enforcementForAction.source_filter,
        // The reserved namespace, and this door narrows harder than the
        // read doors it agrees with.
        //
        // It passed nothing, so a filter naming no type matched
        // platform-internal rows the sibling read hides — `revoked` is
        // reachable only on a `system.*` type and the default state mask
        // drops only trashed rows, so nothing else stood in the way. A dry
        // run then enumerated them and every unbounded action acted on what
        // it enumerated.
        //
        // One flag closes both ways in, because it narrows the type column
        // rather than the state one: the structured `state` and the
        // free-text grammar, which recognizes `state` with no value
        // allowlist, reach the same rows.
        //
        // **The opt-in asks who may write the type, not merely who named
        // it.** On a read this rule shapes an unnarrowed query and
        // permissions decide the rest. Here they do not: this door runs no
        // per-row `requireTypeAccess`, so whatever reaches the match query
        // never meets the fence that guards the reserved namespace on every
        // single-item write door. The type filter beside this is not that
        // fence and cannot be: a credential holding `write` across the
        // board passes it and is still not a platform one. Widening
        // on the name alone would therefore publish a write path into that
        // namespace which `PATCH /items/{id}` refuses to the same key.
        //
        // `mayWriteReserved` is that fence in predicate form rather than a
        // second copy of it, so the integration that legitimately reaches
        // its own `system.activity` rows here still does — narrowed per row
        // afterwards by the attribution rule, which is where whose rows it
        // may touch is decided.
        //
        // There is no widening token beside it for the ordinary reason: a
        // read widened by one answers a bigger question, an action widened
        // by one acts on more rows.
        exclude_system_types: !(
          namesSystemNamespace(filter.type) &&
          callerKey !== undefined &&
          mayWriteReserved(callerKey, filter.type ?? "")
        ),
        occurred_after: filter.occurred_after,
        occurred_before: filter.occurred_before,
        limit: Math.min(200, cap + 1 - matched.length),
        cursor,
      });
      for (const item of page.data) {
        if (!mayAct(item)) continue;
        matched.push(item);
        if (matched.length > cap) break;
      }
      cursor =
        page.has_more && matched.length <= cap
          ? (page.cursor ?? undefined)
          : undefined;
    } while (cursor);

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
    // 202. The flag travels to the worker inside the stored input, which
    // is the request body verbatim.
    void enableFanout;
    const idempotencyKey = c.req.header("Idempotency-Key") ?? null;
    const apiKeyId = c.get("apiKey")?.id ?? null;
    const job = await storage.bulkActionJobs.create({
      id: generateId(),
      api_key_id: apiKeyId,
      action,
      input: JSON.stringify(body),
      matched_ids: JSON.stringify(matched.map((i) => i.id)),
      matched_count: matched.length,
      idempotency_key: idempotencyKey,
      created_at: new Date().toISOString(),
    });
    // Wake the worker rather than leaving the job to be found by the idle
    // poll, whose backoff widens to a minute while the queue is quiet.
    notifyBulkJobEnqueued();

    await storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: c.get("apiKey")?.id,
      action: "items.bulk_action",
      resource_type: "items.bulk_action",
      details: {
        sub_action: action,
        matched: matched.length,
        job_id: job.id,
        idempotency_replay: !!(
          idempotencyKey &&
          job.created_at < new Date(Date.now() - 1000).toISOString()
        ),
      },
    });

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
    const existing = await storage.bulkActionJobs.getById(id);
    if (!existing) {
      throw new MarfaError(ErrorCode.BULK_JOB_NOT_FOUND, "Job not found");
    }
    assertJobAuth(c, existing);
    await storage.bulkActionJobs.cancel(id, new Date().toISOString());
    const after = await storage.bulkActionJobs.getById(id);
    // After cancel() either flipped to cancelled or the job had already
    // reached a terminal state — either way, surface the row as-of-now.
    return c.json(jobRowToEnvelope(after ?? existing), 200);
  });

  return router;
}

// Who may read or cancel a job, in the order the checks run:
//
//   - the operator key reaches any job, which is what the instance tier is;
//   - anyone else reaches only jobs their own credential created, since
//     within a space separate credentials do not observe each other's
//     bulk_action jobs;
//   - a job in another space is cloaked as absent rather than refused.
//
// `bulkActionJobs.getById` applies no space filter, so this function is the
// whole fence.
function assertJobAuth(c: Context<AppEnv>, job: BulkActionJobRow): void {
  const apiKey = c.get("apiKey");
  if (!apiKey) {
    throw new MarfaError(ErrorCode.UNAUTHORIZED, "Missing credential");
  }
  // Operator authority reaches every job: `bulkActionJobs.getById` is
  // deliberately unscoped, so this is the only fence, and a purge job
  // carries no space at all.
  if (apiKey.is_operator) return;
  // **A job belongs to the credential that started it, and to nothing else.**
  // There used to be a rank arm above this one, admitting an admin to any job
  // in its own space; with rank retired there is no space permission that says
  // "read another credential's bulk jobs", and inventing one to preserve the
  // arm would be widening the model to fit a line rather than the other way
  // round. What is left is the narrower half that was always here.
  if (job.api_key_id && apiKey.id === job.api_key_id) return;
  // The job's existence is not a secret, only its contents, so this is a
  // 403 rather than a cloaked 404.
  throw new MarfaError(
    ErrorCode.FORBIDDEN,
    "This job belongs to a different credential",
  );
}

// Render a server-internal row as the SDK-facing envelope shape. Strips
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
