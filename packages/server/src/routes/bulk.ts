/**
 * Bulk operations on items.
 *
 * Two endpoints, two shapes:
 *
 *   POST /items/bulk        — list-in: caller provides explicit items to
 *                             create/upsert. Replaces the historical /import
 *                             with modes, atomic control, inline edges, and
 *                             per-item outcomes.
 *   POST /items/bulk_action — filter-in: caller provides a filter and an
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
import {
  MymeError,
  ErrorCode,
  isValidTimestamp,
  isValidTypeIdentifier,
  ITEM_STATES,
} from "@mymehq/shared";
import type { ItemState, Item } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAdmin,
  requireAuth,
  requireTypeAccess,
  getTypeFilter,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { publish } from "../pubsub.js";
import { collectBlobHashes } from "../storage/blob-utils.js";
import { applyInlineEdges } from "./_edges-inline.js";

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
  tags: ["Items"],
  summary: "Bulk upsert items",
  description:
    "Creates or upserts up to 5000 items in one call. Use for tenant migrations, importer runs, replays of an external source. Replaces the historical `/import` endpoint.\n\nModes: `upsert` (default) matches existing rows on `(source, source_id)` and updates in place — properties shallow-merge, tags replace if provided, edges union-merge if provided; `create_only` surfaces matching rows as `skipped`. Atomic by default — `atomic: true` wraps the batch in one transaction; `atomic: false` runs per-item with per-item outcomes. `emit_events: false` is the default; opt in with `emit_events: true` if subscribers should fan out per item.\n\nInline `edges` blocks on items have replace-all-per-type semantics within the batch. For cross-batch edges, use `POST /edges/bulk` after items land.\n\nAdmin-only. `source` is server-stamped from the credential — any caller-supplied `source` is silently overwritten. See [Bulk operations](/api/bulk-operations).",
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
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Admin required",
    },
  },
});

const bulkActionRoute = createRoute({
  method: "post",
  path: "/bulk_action",
  tags: ["Items"],
  summary: "Apply a bulk action",
  description:
    "Applies one action to every item matching a filter. Use to archive everything tagged `wip`, purge every trashed item older than 90 days, retier a slice of items, retag a source's items in bulk.\n\nSix actions, discriminated on `action`: `transition` (move to a target state), `purge` (hard-delete; admin-only; requires `confirm: PURGE`), `update_tags` (`add` / `remove`), `update_tier`, `update_properties` (shallow merge into properties), `update_timestamp`.\n\nNon-admin callers see their match set narrowed to types they hold write on. `purge` is admin-only regardless of filter. Safety rails: `dry_run: true` returns matched ids and count without writing; `max_items` caps the match set (default 10000, hard ceiling 50000); going over returns `400 bulk_cap_exceeded`. See [Bulk operations](/api/bulk-operations).",
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
      description: "Bulk action result",
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
// upsert short-circuit on POST /items per T-038).

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

  const { mode, tenantId, stampedSource } = options;
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
      await applyInlineEdges(storage, existing.id, raw.edges, tenantId);
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
      await applyInlineEdges(storage, created.id, raw.edges, tenantId);
    }
    return { index, outcome: "created", id: created.id };
  } catch (err) {
    if (err instanceof MymeError) {
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
    requireAdmin(c);

    const body = c.req.valid("json");
    const items = body.items;
    const mode = body.mode ?? "upsert";
    const atomic = body.atomic ?? true;
    const emitEvents = body.emit_events ?? false;

    if (items.length > MAX_BULK_ITEMS) {
      throw new MymeError(
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
          throw new MymeError(
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
          throw new MymeError(
            ErrorCode.BULK_ATOMIC_ROLLBACK,
            `Bulk upsert rolled back on item ${String(i)}`,
            {
              index: i,
              code: ErrorCode.VALIDATION_ERROR,
              message: "timestamp must be an ISO 8601 string",
            },
          );
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
        });
        if (atomic && result.outcome === "errored") {
          // In atomic mode a single failure aborts the whole batch. Throw
          // so runInTransaction rolls back; carry the failure context out
          // via the error details.
          throw new MymeError(
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
              ...c.var.cycle,
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

  // POST /items/bulk_action — filter-in
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
        throw new MymeError(
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
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid type identifier: ${filter.type}`,
      );
    }
    if (
      filter.state &&
      !(ITEM_STATES as readonly string[]).includes(filter.state)
    ) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid state: ${filter.state}`,
      );
    }
    if (action === "update_timestamp" && !isValidTimestamp(body.timestamp)) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "timestamp must be an ISO 8601 string",
      );
    }
    if (action === "update_tags") {
      const addCount = body.add?.length ?? 0;
      const removeCount = body.remove?.length ?? 0;
      if (addCount === 0 && removeCount === 0) {
        throw new MymeError(
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
        state: filter.state as ItemState | undefined,
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
      throw new MymeError(
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

    // Per-item transactions. A failure on one row leaves the others
    // applied — matches "best-effort cleanup" intent.
    const errors: { id: string; code: string; message: string }[] = [];
    const succeededIds: string[] = [];
    const blobHashes = new Set<string>();

    for (const item of matched) {
      try {
        await storage.runInTransaction(async () => {
          switch (action) {
            case "transition": {
              if (item.state !== body.state) {
                await storage.items.transition(item.id, body.state, tenantId);
              }
              break;
            }
            case "purge": {
              collectBlobHashes(item.properties, blobHashes);
              await storage.edges.deleteBySource(item.id);
              await storage.edges.deleteByTarget(item.id);
              await storage.items.bulkPurge([item.id], tenantId);
              break;
            }
            case "update_tags": {
              if (body.add && body.add.length > 0) {
                await storage.metadata.addTags(item.id, body.add);
              }
              if (body.remove && body.remove.length > 0) {
                for (const tag of body.remove) {
                  await storage.metadata.removeTag(item.id, tag);
                }
              }
              break;
            }
            case "update_tier": {
              const updated = await storage.items.update(
                item.id,
                { tier: body.tier },
                tenantId,
              );
              if ("error" in updated) {
                throw new MymeError(
                  ErrorCode.CONFLICT,
                  "Version conflict during bulk update_tier",
                );
              }
              break;
            }
            case "update_properties": {
              // Shallow merge, matches PATCH /items/{id} semantics.
              const updated = await storage.items.update(
                item.id,
                { properties: body.patch },
                tenantId,
              );
              if ("error" in updated) {
                throw new MymeError(
                  ErrorCode.CONFLICT,
                  "Version conflict during bulk update_properties",
                );
              }
              break;
            }
            case "update_timestamp": {
              const updated = await storage.items.update(
                item.id,
                { timestamp: body.timestamp },
                tenantId,
              );
              if ("error" in updated) {
                throw new MymeError(
                  ErrorCode.CONFLICT,
                  "Version conflict during bulk update_timestamp",
                );
              }
              break;
            }
          }
        });

        // Non-admin callers: belt-and-braces check that the caller had
        // type-write access on this specific item. getTypeFilter already
        // narrowed the match set, but the check here keeps the contract
        // explicit in case a type permission changes mid-batch.
        if (action !== "purge") {
          requireTypeAccess(c, item.type, "write");
        }

        succeededIds.push(item.id);
      } catch (err) {
        errors.push({
          id: item.id,
          code: err instanceof MymeError ? err.code : "internal_error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Events (opt-in). Fire one per succeeded id; no aggregate event.
    if (emitEvents) {
      for (const id of succeededIds) {
        if (action === "purge") {
          // There's no "item purged" event in the current pubsub enum.
          // Purge is not a lifecycle state a subscriber observes; skip.
          continue;
        }
        const fresh = await storage.items.get(id, tenantId);
        if (!fresh) continue;
        const metadata = await storage.metadata.get(id);
        const eventType =
          action === "transition"
            ? "state_changed"
            : action === "update_tags"
              ? "metadata_changed"
              : "updated";
        await publish({
          type: eventType,
          item: fresh,
          metadata,
          tenantId,
          ...c.var.cycle,
        });
      }
    }

    await storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "items.bulk_action",
      resource_type: "items.bulk_action",
      details: {
        sub_action: action,
        matched: matched.length,
        succeeded: succeededIds.length,
        errored: errors.length,
      },
    });

    const response: z.infer<typeof BulkActionResponseSchema> = {
      action,
      matched: matched.length,
      succeeded: succeededIds.length,
      errored: errors.length,
      dry_run: false,
    };

    // Return ids inline when the result set is small enough to be useful
    // (similar pattern to dry_run). Callers wanting the full set should
    // rerun with dry_run=true first.
    if (succeededIds.length > 0 && succeededIds.length <= 100) {
      response.ids = succeededIds;
    }
    if (errors.length > 0) {
      response.errors = errors;
    }
    if (action === "purge") {
      response.blob_hashes_referenced = blobHashes.size;
    }

    return c.json(response, 200);
  });

  return router;
}
