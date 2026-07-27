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
 * rows). Both default `emit_events: false` so per-item webhook fanout is
 * opt-in — bulk calls should not flood subscribers.
 */

import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  MarfaError,
  ErrorCode,
  generateId,
  isValidTimestamp,
  isValidTypeIdentifier,
  ITEM_STATES,
} from "@withmarfa/shared";
import type { Item } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAdmin,
  requireAuth,
  requireTypeAccess,
  getTypeFilter,
} from "../middleware/auth.js";
import type { BulkActionJobRow, Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { publish } from "../pubsub.js";
import { applyInlineEdges } from "./_edges-inline.js";
import {
  BulkActionJobSchema,
  type BulkActionResult as BulkActionResultType,
} from "../bulk-actions/types.js";

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
    since: z.string().optional(),
    until: z.string().optional(),
    /** Full filter-SQL DSL string, same grammar as GET /items?filter=. */
    filter: z.string().optional(),
  })
  .optional();

const BulkActionBaseSchema = z.object({
  filter: BulkFilterSchema,
  dry_run: z.boolean().optional(),
  max_items: z.number().int().positive().optional(),
  emit_events: z.boolean().optional(),
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
    "Creates or upserts up to 5000 items in one call, matching existing rows on `(source, source_id)`. Atomic by default; `source` is server-stamped from the credential, so any caller-supplied value is overwritten. Requires write access to each item's type (admin / tenant_admin bypass; members need the per-type permission), and operates only within the caller's tenant.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(BulkInputItemSchema),
            mode: z.enum(["upsert", "create_only"]).optional(),
            atomic: z.boolean().optional(),
            emit_events: z.boolean().optional(),
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
      description: "Validation error or atomic rollback",
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
    "Returns the current state of an asynchronous bulk-action job; once terminal, `result` carries the outcome envelope. Only the credential that created the job or an admin can read it.",
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
      description: "Not the originating credential and not an admin",
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
      description: "Not the originating credential and not an admin",
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

interface BulkItemResult {
  index: number;
  outcome: "created" | "updated" | "skipped" | "errored";
  id?: string;
  reason?: string;
  error?: { code: string; message: string };
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
    tenantId: string | undefined;
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
     * Per-item write authorization. Mirrors the single-item `POST /items`
     * gate (`requireTypeAccess(c, type, "write")`): admin / tenant_admin
     * bypass; a member must hold write on the item's type. Throws
     * `TYPE_NOT_PERMITTED` (403) which surfaces as a per-item `errored`
     * outcome in best-effort mode and aborts the batch in atomic mode.
     */
    checkWrite: (type: string) => void;
  },
): Promise<BulkItemResult> {
  if (!isValidTypeIdentifier(raw.type)) {
    return {
      index,
      outcome: "errored",
      error: {
        code: ErrorCode.INVALID_TYPE,
        message: `Invalid type identifier: ${raw.type}`,
      },
    };
  }

  const { mode, tenantId, stampedSource, atomic, checkWrite } = options;

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
    if (atomic) {
      await applyInlineEdges(storage, id, edgeSet, tenantId);
    } else {
      await storage.runInTransaction(() =>
        applyInlineEdges(storage, id, edgeSet, tenantId),
      );
    }
  };

  try {
    checkWrite(raw.type);
  } catch (err) {
    if (err instanceof MarfaError) {
      return {
        index,
        outcome: "errored",
        error: { code: err.code, message: err.message },
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
      tenantId,
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
    existing = await storage.items.get(raw.id, tenantId);
    if (existing) matchedBy = "id";
  }

  // create_only: existing match → skipped. No writes.
  if (existing && mode === "create_only") {
    return {
      index,
      outcome: "skipped",
      id: existing.id,
      reason: matchedBy === "id" ? "duplicate_id" : "duplicate_source",
    };
  }

  // upsert + existing: update properties/tier/timestamp in place,
  // optionally reconciling edges.
  if (existing) {
    const updated = await storage.items.update(
      existing.id,
      {
        properties: raw.properties,
        tier: raw.tier,
        timestamp: raw.timestamp,
      },
      tenantId,
    );
    if ("error" in updated) {
      return {
        index,
        outcome: "errored",
        id: existing.id,
        error: {
          code: updated.error.code,
          message: "Version conflict during bulk upsert",
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
            index,
            outcome: "errored",
            id: existing.id,
            error: { code: err.code, message: err.message },
          };
        }
        throw err;
      }
    }

    return { index, outcome: "updated", id: updated.id };
  }

  // No match → create. Stamp source from credential; caller-supplied source
  // is ignored on the wire (preserves /import non-forgeability contract).
  try {
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
    };
    const created = await storage.items.create(createInput, tenantId);
    if (raw.edges) {
      await reconcileEdges(created.id, raw.edges);
    }
    return { index, outcome: "created", id: created.id };
  } catch (err) {
    if (err instanceof MarfaError) {
      return {
        index,
        outcome: "errored",
        error: { code: err.code, message: err.message },
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
    // single-item `POST /items` gate. admin / tenant_admin bypass type
    // permissions; a member must hold write on each item's type. tenant
    // scoping is threaded through every storage call below via `tenantId`.
    requireAuth(c);
    const checkWrite = (type: string): void => {
      requireTypeAccess(c, type, "write");
    };

    const body = c.req.valid("json");
    const items = body.items;
    const mode = body.mode ?? "upsert";
    const atomic = body.atomic ?? true;
    const emitEvents = body.emit_events ?? false;

    if (items.length > MAX_BULK_ITEMS) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Maximum ${String(MAX_BULK_ITEMS)} items per call`,
        { cap: MAX_BULK_ITEMS, provided: items.length },
      );
    }

    const tenantId = c.get("apiKey")?.tenant_id;
    const stampedSource = c.get("apiKey")?.source;

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
          checkWrite(raw.type);
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

    const run = async (): Promise<BulkItemResult[]> => {
      const out: BulkItemResult[] = [];
      for (const [i, raw] of items.entries()) {
        const result = await processBulkItem(storage, raw, i, {
          mode,
          tenantId,
          stampedSource,
          atomic,
          checkWrite,
        });
        if (atomic && result.outcome === "errored") {
          // In atomic mode a single failure aborts the whole batch. Throw
          // so runInTransaction rolls back; carry the failure context out
          // via the error details.
          throw new MarfaError(
            ErrorCode.BULK_ATOMIC_ROLLBACK,
            `Bulk upsert rolled back on item ${String(i)}`,
            {
              index: i,
              code: result.error?.code,
              message: result.error?.message,
            },
          );
        }
        out.push(result);
      }
      return out;
    };

    // atomic=true → one transaction wraps every item write. atomic=false
    // → each item gets its own transaction (composed inside storage.items
    // methods); route iterates without an outer wrapper.
    const results = atomic ? await storage.runInTransaction(run) : await run();

    const counts = { created: 0, updated: 0, skipped: 0, errored: 0 };
    for (const r of results) counts[r.outcome] += 1;

    // Events fire only after the batch commits (or on each item in
    // non-atomic mode). Missing from the /import precedent because
    // /import never had the opt-in switch.
    if (emitEvents) {
      for (const r of results) {
        if (r.id && (r.outcome === "created" || r.outcome === "updated")) {
          const item = await storage.items.get(r.id, tenantId);
          if (item) {
            const metadata = await storage.metadata.get(r.id);
            await publish({
              type: r.outcome === "created" ? "created" : "updated",
              item,
              metadata,
              tenantId,
            });
          }
        }
      }
    }

    await storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
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
    const emitEvents = body.emit_events ?? false;

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

    const tenantId = c.get("apiKey")?.tenant_id;

    // Non-admin callers see their match set narrowed to writable types.
    // Purge already rejected non-admin above, so getTypeFilter is a no-op
    // for admin callers regardless.
    const allowedTypes = getTypeFilter(c);

    // Paginate through matches up to cap+1. The +1 lets us distinguish
    // "exactly at cap" from "over the cap" without a second COUNT query.
    const matched: Item[] = [];
    let cursor: string | undefined;
    do {
      const page = await storage.items.list({
        tenantId,
        type: filter.type,
        state: filter.state,
        source: filter.source,
        tier: filter.tier,
        tags: filter.tags,
        filter: filter.filter,
        allowed_types: allowedTypes,
        since: filter.since,
        until: filter.until,
        limit: Math.min(200, cap + 1 - matched.length),
        cursor,
      });
      for (const item of page.data) {
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
    // `emit_events` is stored on the row (worker honors it) but not
    // fired here. The synchronous endpoint fired per-item events after
    // every mutation; the worker does the same once implemented in
    // `runChunk`. For now, emit_events is a no-op — runner.ts
    // intentionally drops the flag.
    void emitEvents;
    const idempotencyKey = c.req.header("Idempotency-Key") ?? null;
    const apiKeyId = c.get("apiKey")?.id ?? null;
    const job = await storage.bulkActionJobs.create({
      id: generateId(),
      tenant_id: tenantId ?? null,
      api_key_id: apiKeyId,
      action,
      input: JSON.stringify(body),
      matched_ids: JSON.stringify(matched.map((i) => i.id)),
      matched_count: matched.length,
      idempotency_key: idempotencyKey,
      created_at: new Date().toISOString(),
    });

    await storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
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

// Caller is allowed to read/cancel a job only if it created the job
// (api_key_id match) or holds platform admin. Tenant match alone is not
// sufficient — within a tenant, separate credentials don't observe each
// other's bulk_action jobs (consistent with how other ops surfaces
// behave).
function assertJobAuth(c: Context<AppEnv>, job: BulkActionJobRow): void {
  const apiKey = c.get("apiKey");
  if (!apiKey) {
    throw new MarfaError(ErrorCode.UNAUTHORIZED, "Missing credential");
  }
  // `role: "admin"` alone is not platform authority — `POST
  // /admin/tenants/:id/keys` mints admin keys bound to one tenant, and
  // `getById` applies no tenant filter, so trusting the role by itself
  // would hand a tenant-bound key every other tenant's jobs. Mirror
  // `checkAdmin`: only an unbound admin has instance-wide reach, and a
  // bound one stays admin-shaped inside its own tenant.
  if (apiKey.role === "admin") {
    if (!apiKey.tenant_id) return;
    if (apiKey.tenant_id === job.tenant_id) return;
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      "This job belongs to a different tenant",
    );
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
