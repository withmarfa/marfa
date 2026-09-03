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
 *                             update_timestamp).
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
  ITEM_STATES,
  validateProperties,
} from "@withmarfa/shared";
import type { Item, Metadata } from "@withmarfa/shared";
import { mergeUpdateProperties } from "../storage/merge-properties.js";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAdmin,
  requireAuth,
  requireTypeAccess,
  requireEdgePermission,
  requireActivityAttribution,
  requireMirrorProtection,
  requireDeclaredTypeMatches,
  permitsActivityAttribution,
  permitsMirrorWrite,
  itemProvenanceSource,
  writerConnectionOf,
  getTypeFilter,
  hasPlatformAuthority,
  INTEGRATION_SOURCE_PREFIX,
} from "../middleware/auth.js";
import { createOwnershipGuard, liveConnectionIds } from "./_orphaned.js";
import type { BulkActionJobRow, Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { publish } from "../pubsub.js";
import { applyInlineEdges, announceInlineEdges } from "./_edges-inline.js";
import type { InlineEdgeChanges } from "./_edges-inline.js";
import { assertTierApplicable } from "./_tier-rules.js";
import { notifyBulkJobEnqueued } from "../bulk-actions/enqueue-signal.js";
import {
  BulkActionJobSchema,
  type BulkActionResult as BulkActionResultType,
} from "../bulk-actions/types.js";
import { refuseRenamedTimeFilterKeys } from "./_renamed-time-filters.js";

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
  state: z.enum(["active", "archived", "trashed"]).optional(),
  tier: z.enum(["library", "feed"]).optional(),
  timestamp: z.string().optional(),
  /** Ignored on the wire — server stamps `source` from the credential. */
  source: z.string().optional(),
  source_id: z.string().optional(),
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

// filter fields — same semantics as GET /items query. One JSON object so
// bulk_action callers don't have to shove a filter expression through
// query-string encoding.
const BulkFilterSchema = z
  .object({
    type: z.string().optional(),
    state: z.enum(["active", "archived", "trashed"]).optional(),
    source: z.string().optional(),
    tier: z.enum(["library", "feed"]).optional(),
    tags: z.array(z.string()).optional(),
    timestamp_after: z.string().optional(),
    timestamp_before: z.string().optional(),
    /** Full filter-SQL DSL string, same grammar as GET /items?filter=. */
    filter: z.string().optional(),
  })
  .optional();

const BulkActionBaseSchema = z.object({
  filter: BulkFilterSchema,
  dry_run: z.boolean().optional(),
  max_items: z.number().int().positive().optional(),
  enable_fanout: z.boolean().optional(),
});

const BulkActionRequestSchema = z.discriminatedUnion("action", [
  BulkActionBaseSchema.extend({
    action: z.literal("transition"),
    state: z.enum(["active", "archived", "trashed"]),
  }),
  BulkActionBaseSchema.extend({
    action: z.literal("purge"),
    confirm: z.literal("PURGE").optional(),
  }),
  BulkActionBaseSchema.extend({
    action: z.literal("update_tags"),
    add: z.array(z.string()).optional(),
    remove: z.array(z.string()).optional(),
  }),
  BulkActionBaseSchema.extend({
    action: z.literal("update_tier"),
    tier: z.enum(["library", "feed"]),
  }),
  BulkActionBaseSchema.extend({
    action: z.literal("update_properties"),
    patch: z.record(z.string(), z.unknown()),
  }),
  BulkActionBaseSchema.extend({
    action: z.literal("update_timestamp"),
    timestamp: z.string(),
  }),
]);

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
    "Creates or upserts up to 5000 items in one call, matching existing rows on `(source, source_id)`. Atomic by default; `source` is server-stamped from the credential, so any caller-supplied value is overwritten. Requires write access to each item's type (admin / space_admin bypass; members need the per-type permission), and operates only within the caller's space.\n\nAn entry that resolves a row of a different type is refused with `type_mismatch` — a write does not re-type the row it lands on. Passing `retype: true` for the batch moves those rows instead, which is how a corpus is brought onto a type a mapping now names. It is opt-in rather than inferred from a differing type, because a declared type accompanies nearly every write and inferring would move a corpus on an ordinary sync bug. Each move requires write on the type being entered as well as the one being left, and the resulting properties are validated against the destination: an item the destination type cannot accept is reported as an `errored` entry naming why, and the rest of the batch proceeds.",
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
        "`atomic: false` to have each entry reported on its own instead; " +
        "the runtime SDK's bulk helper does exactly that.",
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
    "Applies one action (transition, purge, retag, retier, or property/timestamp update) to every item matching a filter. Non-dry-run calls queue an async job; `dry_run: true` returns the matched ids without writing, and `max_items` caps the match set before a `bulk_cap_exceeded` error.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: BulkActionRequestSchema,
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
      description: "Admin required (purge only)",
    },
  },
});

// Poll endpoint for a queued / running / terminal job. The job envelope
// is identical to what `POST /items/bulk-actions` returns initially;
// subsequent calls reflect the worker's progress until the row reaches
// a terminal status. Auth: the originating credential or an admin.
const bulkActionStatusRoute = createRoute({
  method: "get",
  path: "/bulk-actions/jobs/{id}",
  operationId: "getBulkActionJob",
  tags: ["Items"],
  summary: "Get a bulk-action job",
  description:
    "Returns the current state of an asynchronous bulk-action job; once terminal, `result` carries the outcome envelope. Readable by the credential that created it, by an admin within the same space, and by a platform credential. A job in another space reads as absent.",
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
      description:
        "Not the originating credential, and not an admin for this space",
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
      description:
        "Not the originating credential, and not an admin for this space",
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
    spaceId: string | undefined;
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
     * gate (`requireTypeAccess(c, type, "write")`): admin / space_admin
     * bypass; a member must hold write on the item's type. Throws
     * `TYPE_NOT_PERMITTED` (403) which surfaces as a per-item `errored`
     * outcome in best-effort mode and aborts the batch in atomic mode.
     *
     * Takes the whole item rather than its type because authorization
     * here is not a function of the type alone: a `system.activity` row
     * written by a runtime credential is also checked against whose
     * activity it claims to be. Passing the item is what keeps both
     * call sites covered by construction rather than by remembering.
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
    ) => Promise<"own" | "adopt">;
    /**
     * The provenance half of the row-side gate on its own (D63), for the
     * `create_only` arm — which authorizes nothing else and must keep it
     * that way.
     */
    checkProvenance: (existing: Item) => Promise<"own" | "adopt">;
    /**
     * The connection to record as this write's author (D63), or null when
     * the caller is not a runtime credential. Computed once per request in
     * the route rather than per entry, because it is a property of the
     * credential and cannot change inside a batch.
     */
    writerConnectionId: string | null;
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
    spaceId,
    stampedSource,
    atomic,
    retype,
    checkWrite,
    checkUpdate,
    checkProvenance,
    checkEdgeWrite,
    recordEdgeChanges,
    writerConnectionId,
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
        ? await applyInlineEdges(storage, id, edgeSet, spaceId, checkEdgeWrite)
        : await storage.runInTransaction(() =>
            applyInlineEdges(storage, id, edgeSet, spaceId, checkEdgeWrite),
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
  const sourceId = raw.source_id;

  let existing: Item | null = null;
  let matchedBy: "source_id" | "id" | null = null;
  if (stampedSource && sourceId) {
    existing = await storage.items.findBySourceId(
      stampedSource,
      sourceId,
      spaceId,
    );
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
        ? await storage.items.getIncludingTrashed(raw.id, spaceId)
        : await storage.items.get(raw.id, spaceId);
    if (existing) matchedBy = "id";
  }

  // create_only: existing match → skipped. No writes.
  if (existing && mode === "create_only") {
    // Guarded before the skip (D63). A row a live sibling connection owns
    // is not this caller's duplicate, and answering `skipped /
    // duplicate_source` says it is — which reads as "already stored" and
    // sends the handler on believing its record is present.
    //
    // **The provenance guard alone, not `checkUpdate`.** This arm has never
    // run the update authorization and must not start: `create_only` with
    // locally-assigned ids is the offline-first path, and putting
    // `requireMirrorProtection` and `requireTypeAccess` in front of a skip
    // would turn "that id is already taken" into a refusal — and, since
    // `atomic` defaults to true, into a whole-batch rollback.
    try {
      await checkProvenance(existing);
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
    return {
      result: {
        index,
        outcome: "skipped",
        id: existing.id,
        reason: matchedBy === "id" ? "duplicate_id" : "duplicate_source",
      },
    };
  }

  // upsert + existing: update properties/tier/timestamp in place,
  // optionally reconciling edges.
  if (existing) {
    // No initialiser: `checkUpdate` below either assigns it or throws, so
    // a default here would be a value nothing can read.
    let ownership: "own" | "adopt";
    // Authorize against the row about to be overwritten. The entry's own
    // `type` is not what is being written — it describes a create that is
    // no longer happening — so it is checked for agreement rather than
    // used.
    try {
      ownership = await checkUpdate(existing, { properties: raw.properties });
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
      // The runtime SDK's bulk helper sends `atomic: false` deliberately,
      // so the integrations that batch get a per-entry outcome and one
      // bad record does not hold a page of thousands hostage.
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
    if (resultingType !== existing.type) {
      // The one check the ordinary update path does not need and a move
      // cannot go without: the destination may require fields the row has
      // never carried, and its field types may not accept what the old
      // properties hold. Judged on the properties the store is about to
      // write, through the same helper it merges with, so this predicts
      // the write rather than approximating it.
      const merged = mergeUpdateProperties(
        existing.properties,
        raw.properties ?? {},
        false,
        "merge",
      );
      const validation = validateProperties(resultingType, merged, {
        ...(spaceId === undefined ? {} : { spaceId }),
      });
      if (!validation.success) {
        // Named, not counted, and not a reason to abandon the rest — the
        // point of moving a corpus per item is that some of it cannot go.
        return {
          result: {
            index,
            outcome: "errored",
            id: existing.id,
            error: {
              code: ErrorCode.INVALID_PROPERTIES,
              message: `Cannot move item to "${resultingType}": ${validation.errors
                .map((e) => `${e.field}: ${e.message}`)
                .join("; ")}`,
            },
          },
        };
      }
    }
    assertTierApplicable(resultingType, raw.tier);
    const updated = await storage.items.update(
      existing.id,
      {
        properties: raw.properties,
        ...(resultingType === existing.type ? {} : { type: resultingType }),
        tier: raw.tier,
        timestamp: raw.timestamp,
        // Adoption only (D63), matching the single-item doors.
        ...(ownership === "adopt" && {
          written_by_connection_id: writerConnectionId,
        }),
      },
      spaceId,
    );
    if ("error" in updated) {
      return {
        result: {
          index,
          outcome: "errored",
          id: existing.id,
          error: {
            code: updated.error.code,
            message: "Version conflict during bulk upsert",
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
    // in the `system.*` lifecycle at all, so a platform credential could
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
      ...(raw.timestamp !== undefined && { timestamp: raw.timestamp }),
      ...(stampedSource !== undefined && { source: stampedSource }),
      ...(sourceId !== undefined && { source_id: sourceId }),
      ...(raw.device !== undefined && { device: raw.device }),
      ...(raw.tags !== undefined && { tags: raw.tags }),
      written_by_connection_id: writerConnectionId,
    };
    const created = await storage.items.create(createInput, spaceId);
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
    // single-item `POST /items` gate. admin / space_admin bypass type
    // permissions; a member must hold write on each item's type. space
    // scoping is threaded through every storage call below via `spaceId`.
    requireAuth(c);
    const checkWrite = (raw: { type: string; properties?: unknown }): void => {
      requireTypeAccess(c, raw.type, "write");
      requireActivityAttribution(c.get("apiKey"), raw.type, raw.properties);
    };
    // The update half of an upsert, judged on the target row. Mirrors
    // `PATCH /items/{id}` gate for gate, because the two are the same
    // operation reached through different doors: the row's real type
    // decides the type gate, and the attribution check runs on the row
    // both as it stands and as it will stand. Before, so an integration
    // cannot edit a sibling's activity without naming a connection at
    // all; after, so it cannot re-point its own. The merge mirrors the
    // shallow property merge the storage layer performs.
    // One guard for the whole request, so the connection walk behind it is
    // paid once per space rather than once per entry (D63).
    const ownershipGuard = createOwnershipGuard(storage);
    const checkProvenance = (existing: Item): Promise<"own" | "adopt"> =>
      ownershipGuard(c.get("apiKey"), existing);

    const checkUpdate = async (
      existing: Item,
      raw: { properties?: Record<string, unknown> },
    ): Promise<"own" | "adopt"> => {
      const key = c.get("apiKey");
      requireTypeAccess(c, existing.type, "write");
      requireActivityAttribution(key, existing.type, existing.properties);
      requireActivityAttribution(
        key,
        existing.type,
        raw.properties !== undefined
          ? { ...existing.properties, ...raw.properties }
          : existing.properties,
      );
      requireMirrorProtection(key, existing);
      // Last of the row-side gates rather than first, deliberately.
      // `requireActivityAttribution` above is the only thing that can
      // refuse a sibling's `system.activity` row, and a test names it as
      // such; answering ahead of it would leave that test measuring this
      // guard instead, and the gate it names could then be deleted with
      // the file still green.
      return ownershipGuard(key, existing);
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

    const spaceId = c.get("apiKey")?.space_id;
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

    // In atomic mode, pre-validate inputs that can be checked without a DB
    // round-trip BEFORE we start writing. The SQLite storage layer can't
    // roll back async transactions (see sqlite/index.ts:86–92), so once a
    // write lands it's committed. PG does roll back, but pre-validation
    // keeps both dialects consistent for the common "invalid type" /
    // "invalid timestamp" error modes the test suite cares about.
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
        if (raw.timestamp !== undefined && !isValidTimestamp(raw.timestamp)) {
          throw new MarfaError(
            ErrorCode.BULK_ATOMIC_ROLLBACK,
            `Bulk upsert rolled back on item ${String(i)}`,
            {
              index: i,
              code: ErrorCode.VALIDATION_ERROR,
              message: "timestamp must be an ISO 8601 string",
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
          spaceId,
          stampedSource,
          atomic,
          retype,
          checkWrite,
          checkUpdate,
          checkProvenance,
          checkEdgeWrite,
          recordEdgeChanges: (changes) => inlineEdgeChanges.push(changes),
          writerConnectionId: writerConnectionOf(c.get("apiKey")),
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
        spaceId,
        enableFanout,
      });
    }
    // Edges after the items, so a subscriber sees the endpoints before the
    // relationship naming them.
    for (const changes of inlineEdgeChanges) {
      await announceInlineEdges(changes, spaceId, enableFanout);
    }

    await storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
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

    // Purge is admin-only (hard 403). Every other action falls back to
    // type-permission narrowing via computeTypeFilter — non-admin callers
    // see their match set auto-reduced to writable types.
    if (action === "purge") {
      requireAdmin(c);
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
    // "purge", "filter": {"since": "..."}}` becomes a purge with an empty
    // filter, matching every item in the space. Under the match cap it
    // does not even error — it succeeds, against everything.
    //
    // The refusal names no modification-time filter: this door's filter
    // schema has none, and sending a caller to one it would strip is the
    // silence the refusal exists to prevent.
    //
    // After the auth gates rather than before them, matching the other
    // two doors. Nothing leaked either way — schema validation already
    // ran ahead of both — but a request that has not been authorized has
    // no claim on the shape of its own refusal.
    const rawBody: unknown = await c.req.json().catch(() => undefined);
    if (
      typeof rawBody === "object" &&
      rawBody !== null &&
      "filter" in rawBody
    ) {
      refuseRenamedTimeFilterKeys((rawBody as { filter?: unknown }).filter, {
        catchUpFilter: "none",
      });
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
      filter.state &&
      !(ITEM_STATES as readonly string[]).includes(filter.state)
    ) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid state: ${filter.state}`,
      );
    }
    if (action === "update_timestamp" && !isValidTimestamp(body.timestamp)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "timestamp must be an ISO 8601 string",
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
    }

    const spaceId = c.get("apiKey")?.space_id;

    // Non-admin callers see their match set narrowed to writable types.
    // Purge already rejected non-admin above, so getTypeFilter is a no-op
    // for admin callers regardless.
    const { allowed: allowedTypes, excluded: excludedTypes } = getTypeFilter(c);

    // The type axis is not the only one a caller can be narrower than.
    // `system.activity` sits in every runtime credential's type filter —
    // that grant is what lets an integration report its own progress — so a
    // filter naming the type matches every integration's rows in the
    // space, and the worker applies the action to the frozen id list
    // without re-deriving who may write what. One credential could
    // rewrite, retier or revoke every sibling's activity in a single
    // call. Narrowing rather than refusing, because that is the answer
    // this route already gives on the type axis: a row the caller cannot
    // write leaves the match set, instead of failing an action over
    // thousands of rows it legitimately can.
    //
    // Judged on the row as it stands and, for `update_properties`, on the
    // row the patch produces — the same two halves every other door
    // checks. Before, or an integration edits a sibling's activity without
    // naming a connection at all; after, or it re-points its own.
    const callerKey = c.get("apiKey");
    const patch = body.action === "update_properties" ? body.patch : undefined;
    const mayAct = (item: Item): boolean =>
      permitsActivityAttribution(callerKey, item.type, item.properties) &&
      (patch === undefined ||
        (permitsActivityAttribution(callerKey, item.type, {
          ...item.properties,
          ...patch,
        }) &&
          // Property patches answer to the mirror rule; transitions and
          // retiers stay user gestures on rows an integration owns.
          permitsMirrorWrite(callerKey, item)));

    // Paginate through matches up to cap+1. The +1 lets us distinguish
    // "exactly at cap" from "over the cap" without a second COUNT query.
    const matched: Item[] = [];
    let cursor: string | undefined;
    do {
      const page = await storage.items.list({
        spaceId,
        type: filter.type,
        state: filter.state,
        source: filter.source,
        tier: filter.tier,
        tags: filter.tags,
        filter: filter.filter,
        allowed_types: allowedTypes,
        excluded_types: excludedTypes,
        timestamp_after: filter.timestamp_after,
        timestamp_before: filter.timestamp_before,
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

    // The connection axis (D63), batched rather than folded into `mayAct`:
    // it needs one column read over the match set and one connection walk
    // per space, and `mayAct` runs per row inside the page loop.
    //
    // **Narrowing, not refusing**, which is this route's established answer
    // on every other axis: one unreachable row must not fail an action over
    // thousands.
    //
    // **D64 widened which actions this covers, and the rule now follows the
    // actor rather than the gesture.** It used to run only where a patch was
    // being applied, on the reasoning that a transition or a retier is a
    // person's gesture on a row an integration owns. That was coherent while
    // two connections of one integration were indistinguishable. Once the
    // platform refuses B's write to A's row it cannot also permit B to trash
    // it: there is no coherent position in which the stronger harm is the
    // less protected one, and `filter.source` plus `action: "transition"`
    // was one call that reached every row a sibling had written.
    //
    // `update_tags`, `update_tier` and `update_timestamp` stay outside this,
    // deliberately. They are neither the write D63 ruled on nor the destroy
    // D64 ruled on, and widening to them here would be this change deciding
    // a question nobody has put.
    // `purge` is absent deliberately: it is `requireAdmin` above, so no
    // runtime credential reaches it and narrowing it would be unreachable.
    const narrowsOnProvenance = patch !== undefined || action === "transition";
    if (narrowsOnProvenance && matched.length > 0) {
      const mine =
        callerKey?.is_runtime_credential === true
          ? callerKey.connection_id
          : null;
      if (mine !== null && mine !== undefined) {
        const candidates = matched.filter((item) =>
          item.source.startsWith(INTEGRATION_SOURCE_PREFIX),
        );
        if (candidates.length > 0) {
          const writers = await storage.items.writersOf(
            candidates.map((item) => item.id),
          );
          const spaces = new Set(
            candidates.map((item) => item.space_id ?? null),
          );
          const liveBySpace = new Map<string | null, ReadonlySet<string>>();
          for (const space of spaces) {
            liveBySpace.set(space, await liveConnectionIds(storage, space));
          }
          const refused = new Set<string>();
          for (const item of candidates) {
            const writer = writers.get(item.id) ?? null;
            // Null and a dead writer both stay in: this door does not
            // adopt, and a row nobody live owns is not somebody else's.
            if (writer === null || writer === mine) continue;
            const live = liveBySpace.get(item.space_id ?? null);
            if (live?.has(writer) === true) refused.add(item.id);
          }
          if (refused.size > 0) {
            const kept = matched.filter((item) => !refused.has(item.id));
            matched.length = 0;
            matched.push(...kept);
          }
        }
      }
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
      space_id: spaceId ?? null,
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
      space_id: c.get("apiKey")?.space_id ?? null,
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
//   - an unbound admin, which is platform authority, reaches any job;
//   - a space-bound admin reaches every job in its own space, and is
//     cloaked from the rest;
//   - anyone else reaches only jobs their own credential created, since
//     within a space separate credentials do not observe each other's
//     bulk_action jobs.
//
// The role alone is not platform authority: `POST /admin/spaces/:id/keys`
// mints admin keys bound to one space, and `getById` applies no space
// filter, so trusting the role by itself hands a bound key every other
// space's jobs. Postgres row-level security already fences spaceed rows
// independently, but it cannot fence the null-space slice, and every
// purge job is null-space because purge is platform-gated. This function
// is the fence that covers both, and the only one on SQLite.
function assertJobAuth(c: Context<AppEnv>, job: BulkActionJobRow): void {
  const apiKey = c.get("apiKey");
  if (!apiKey) {
    throw new MarfaError(ErrorCode.UNAUTHORIZED, "Missing credential");
  }
  // Platform authority reaches every job: `bulkActionJobs.getById` is
  // deliberately unscoped, so this is the only fence, and a purge job
  // carries no space at all.
  if (hasPlatformAuthority(apiKey)) return;
  if (apiKey.role === "instance_admin") {
    if (apiKey.space_id === job.space_id) return;
    // Cloaked as absent rather than refused, so a cross-space probe
    // cannot enumerate job ids. Matches the treatment of `/keys/:id`.
    // The credential branch below keeps its 403: within one space the
    // job's existence is not a secret, only its contents.
    throw new MarfaError(ErrorCode.BULK_JOB_NOT_FOUND, "Job not found");
  }
  if (job.api_key_id && apiKey.id === job.api_key_id) return;
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
