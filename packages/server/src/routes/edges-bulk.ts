/**
 * Bulk edge creation — `POST /edges/bulk`.
 *
 * Parallel to `POST /items/bulk`: caller provides an explicit list of edges
 * to create or upsert; server returns per-edge outcomes plus aggregate
 * counts. Used by mode-transition flows (Local → Marfa, iCloud → Marfa) to
 * migrate edges in a second pass after items.bulk lands — items.bulk's
 * inline `edges` block only handles edges whose source and target both live
 * inside a single batch, which is not the case during multi-batch space
 * migration.
 *
 * One aggregate audit row per call (never N per edge). Every created or
 * updated edge appends to the event log, unconditionally: the log is what
 * a client rebuilding its state replays, so an edge missing from it is one
 * that client can never learn about. The update half was silent while the
 * pubsub enum had no `edge_updated` variant; it does now, and a bulk edit
 * propagates like a single one.
 *
 * `enable_fanout` governs the outbound work instead — webhook delivery and
 * the integration reactions the bridge enqueues — and defaults off, so a
 * multi-batch migration does not call out once per edge it moves.
 *
 * Authorization mirrors single-edge `POST /edges`: the caller needs write
 * on the source item's type AND write on the edge type (admin /
 * space_admin bypass both). Operates only within the caller's space —
 * every storage query is threaded with `key.space_id`, so a space-scoped
 * caller can neither resolve nor mutate another space's edges. Same
 * 5000-edge cap as items.bulk.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode, isValidId } from "@withmarfa/shared";
import type { Edge } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  requireTypeAccess,
  requireEdgePermission,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { assertEdgeCanBeCreated } from "../storage/edge-constraints.js";
import { publishEdge } from "../pubsub.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BULK_EDGES = 5000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const BulkEdgeInputItemSchema = z.object({
  id: z.string().optional(),
  source_id: z.string(),
  target_id: z.string(),
  edge_type: z.string(),
  properties: z.record(z.string(), z.unknown()).optional(),
});

const BulkEdgeResultOutcomeSchema = z.enum([
  "created",
  "updated",
  "skipped",
  "errored",
]);

const BulkEdgeResultEntrySchema = z.object({
  index: z.number().int(),
  outcome: BulkEdgeResultOutcomeSchema,
  id: z.string().optional(),
  reason: z.string().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

const BulkEdgeResponseSchema = z.object({
  counts: z.object({
    created: z.number().int(),
    updated: z.number().int(),
    skipped: z.number().int(),
    errored: z.number().int(),
  }),
  results: z.array(BulkEdgeResultEntrySchema),
});

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const edgesBulkRoute = createRoute({
  method: "post",
  path: "/bulk",
  operationId: "bulkUpsertEdges",
  tags: ["Edges"],
  summary: "Bulk upsert edges",
  description:
    "Creates or upserts up to 5000 edges in one call, matching existing rows on `(source_id, target_id, edge_type)`. Atomic by default; the items being wired together must already exist. Requires write access to each edge's source-item type and edge type (admin / space_admin bypass; members need both per-type permissions), and operates only within the caller's space.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            edges: z.array(BulkEdgeInputItemSchema),
            mode: z.enum(["upsert", "create_only"]).optional(),
            atomic: z.boolean().optional(),
            enable_fanout: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: BulkEdgeResponseSchema },
      },
      description: "Bulk edge result",
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
          schema: makeErrorResponseSchema([
            "forbidden",
            "type_not_permitted",
            "edge_permission_denied",
          ]),
        },
      },
      description: "Write access denied for a source type or edge type",
    },
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BulkEdgeInputItem {
  id?: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  properties?: Record<string, unknown>;
}

interface BulkEdgeResult {
  index: number;
  outcome: "created" | "updated" | "skipped" | "errored";
  id?: string;
  reason?: string;
  error?: { code: string; message: string };
}

/**
 * Process a single bulk-edge input. Caller owns the transaction envelope
 * (one-big-tx for atomic, per-call for best-effort).
 *
 * Duplicate detection is pre-computed by the caller and passed in via
 * `existingByTriple` so a 5000-edge batch hits the DB once per distinct
 * edge_type for existence, not N times.
 */
async function processBulkEdge(
  storage: Storage,
  raw: BulkEdgeInputItem,
  index: number,
  options: {
    mode: "upsert" | "create_only";
    spaceId: string | undefined;
    existingByTriple: Map<string, Edge>;
    /**
     * Per-edge write authorization, mirroring single-edge `POST /edges`:
     * write on the source item's type AND write on the edge type. Admin /
     * space_admin bypass both. The source item is resolved space-scoped,
     * so a cross-space source returns `null` and the edge-type gate alone
     * applies (matching `PATCH /edges/:id`, where a trashed/cross-space
     * source skips the type gate but RLS remains the data-plane fence).
     * Throws on denial; the caller routes that to an `errored` outcome /
     * atomic rollback.
     */
    checkEdgeWrite: (sourceType: string | null, edgeType: string) => void;
  },
): Promise<{ result: BulkEdgeResult; created?: Edge; updated?: Edge }> {
  const { mode, spaceId, existingByTriple, checkEdgeWrite } = options;

  if (!isValidId(raw.source_id)) {
    return {
      result: {
        index,
        outcome: "errored",
        error: {
          code: ErrorCode.INVALID_ID,
          message: `Invalid source_id: ${raw.source_id}`,
        },
      },
    };
  }
  if (!isValidId(raw.target_id)) {
    return {
      result: {
        index,
        outcome: "errored",
        error: {
          code: ErrorCode.INVALID_ID,
          message: `Invalid target_id: ${raw.target_id}`,
        },
      },
    };
  }
  // The same gate the single-edge door runs on a client-supplied id.
  // This door declared the field first and stored it verbatim, so an id
  // that is not an identifier reached the row — and `PATCH` and `DELETE
  // /edges/{id}` address any string, so nothing downstream would have
  // objected. Two doors writing one column answer to one rule.
  if (raw.id !== undefined && !isValidId(raw.id)) {
    return {
      result: {
        index,
        outcome: "errored",
        error: {
          code: ErrorCode.INVALID_ID,
          message: `Invalid id: ${raw.id}`,
        },
      },
    };
  }

  // Authorize the write before any mutation. Resolve the source item's
  // type space-scoped (getIncludingTrashed so a trashed source still runs
  // the gate, matching PATCH /edges/:id). A cross-space source resolves to
  // null and the edge-type gate alone applies.
  try {
    const srcItem = await storage.items.getIncludingTrashed(
      raw.source_id,
      spaceId,
    );
    checkEdgeWrite(srcItem?.type ?? null, raw.edge_type);
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

  const tripleKey = `${raw.source_id}|${raw.target_id}|${raw.edge_type}`;
  const existing = existingByTriple.get(tripleKey);

  if (existing) {
    if (mode === "create_only") {
      return {
        result: {
          index,
          outcome: "skipped",
          id: existing.id,
          reason: "duplicate_edge",
        },
      };
    }
    // upsert — replace properties in place. Matches PATCH /edges/:id
    // semantics (properties overwrite; source/target/type immutable).
    // Space-fenced so a triple that collided with another space's edge
    // (defense-in-depth beyond the space-scoped duplicate lookup) cannot
    // be mutated here.
    //
    // No precondition. A per-entry version would be a different contract
    // from the single door's — it needs a partial-failure shape for a
    // batch where some entries are stale and others are not — and nobody
    // has asked for one. The write still moves the version on, because
    // the bump lives in the statement rather than in the route that
    // reached it.
    //
    // Wrapped for the same reason the authorization step above is: one
    // entry's failure is that entry's result, not the batch's. The store
    // refuses a row that has gone since the duplicate lookup read it,
    // which a concurrent delete produces, and an unwrapped refusal would
    // fail every other entry in the request along with it.
    let outcome;
    try {
      outcome = await storage.edges.updateProperties(
        existing.id,
        raw.properties ?? {},
        spaceId,
      );
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
    if (!outcome.ok) {
      // Unreachable: a conflict needs a precondition, and this door sends
      // none. Refused rather than ignored, so that adding one here has to
      // decide what a batch does about it instead of silently reporting
      // the entry as updated.
      throw new Error(
        "Edge upsert reported a version conflict without a precondition",
      );
    }
    const updated = outcome.edge;
    return {
      result: { index, outcome: "updated", id: updated.id },
      updated,
    };
  }

  try {
    await assertEdgeCanBeCreated(storage.edges, storage.items, {
      source_id: raw.source_id,
      target_id: raw.target_id,
      edge_type: raw.edge_type,
      space_id: spaceId,
    });
    const createInput = {
      source_id: raw.source_id,
      target_id: raw.target_id,
      edge_type: raw.edge_type,
      ...(raw.properties !== undefined && { properties: raw.properties }),
      ...(raw.id !== undefined && { id: raw.id }),
    };
    const created = await storage.edges.createRaw(createInput, spaceId);
    return {
      result: { index, outcome: "created", id: created.id },
      created,
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
// Router (mounted at /edges)
// ---------------------------------------------------------------------------

export function edgesBulkRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(edgesBulkRoute, async (c) => {
    // Authenticated + per-edge dual gate (source-type write + edge-type
    // write), mirroring single-edge `POST /edges`. admin / space_admin
    // bypass both gates. Space scoping is threaded through every storage
    // query below so a space-scoped caller stays inside its own space.
    requireAuth(c);
    const checkEdgeWrite = (
      sourceType: string | null,
      edgeType: string,
    ): void => {
      if (sourceType !== null) requireTypeAccess(c, sourceType, "write");
      requireEdgePermission(c, edgeType, "write");
    };

    const body = c.req.valid("json");
    const rawEdges = body.edges;
    const mode = body.mode ?? "upsert";
    const atomic = body.atomic ?? true;
    const enableFanout = body.enable_fanout ?? false;

    if (rawEdges.length > MAX_BULK_EDGES) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Maximum ${String(MAX_BULK_EDGES)} edges per call`,
        { cap: MAX_BULK_EDGES, provided: rawEdges.length },
      );
    }

    const spaceId = c.get("apiKey")?.space_id;

    if (rawEdges.length === 0) {
      return c.json(
        {
          counts: { created: 0, updated: 0, skipped: 0, errored: 0 },
          results: [],
        },
        200,
      );
    }

    // In atomic mode, surface id-shape errors before any write so the
    // caller sees a 400 bulk_atomic_rollback with the offending index,
    // rather than a half-committed batch on SQLite (which can't roll back
    // async transactions).
    if (atomic) {
      for (const [i, raw] of rawEdges.entries()) {
        if (!isValidId(raw.source_id)) {
          throw new MarfaError(
            ErrorCode.BULK_ATOMIC_ROLLBACK,
            `Bulk edges rolled back on edge ${String(i)}`,
            {
              index: i,
              code: ErrorCode.INVALID_ID,
              message: `Invalid source_id: ${raw.source_id}`,
            },
          );
        }
        if (!isValidId(raw.target_id)) {
          throw new MarfaError(
            ErrorCode.BULK_ATOMIC_ROLLBACK,
            `Bulk edges rolled back on edge ${String(i)}`,
            {
              index: i,
              code: ErrorCode.INVALID_ID,
              message: `Invalid target_id: ${raw.target_id}`,
            },
          );
        }
        if (raw.id !== undefined && !isValidId(raw.id)) {
          throw new MarfaError(
            ErrorCode.BULK_ATOMIC_ROLLBACK,
            `Bulk edges rolled back on edge ${String(i)}`,
            {
              index: i,
              code: ErrorCode.INVALID_ID,
              message: `Invalid id: ${raw.id}`,
            },
          );
        }
        // Authorize the write up-front so an unauthorized edge aborts the
        // batch before any row lands (SQLite can't roll back async txns).
        try {
          const srcItem = await storage.items.getIncludingTrashed(
            raw.source_id,
            spaceId,
          );
          checkEdgeWrite(srcItem?.type ?? null, raw.edge_type);
        } catch (err) {
          if (err instanceof MarfaError) {
            throw new MarfaError(
              ErrorCode.BULK_ATOMIC_ROLLBACK,
              `Bulk edges rolled back on edge ${String(i)}`,
              { index: i, code: err.code, message: err.message },
            );
          }
          throw err;
        }
      }
    }

    // Pre-resolve duplicates in one batched pass, space-scoped so a triple
    // that matches another space's edge is never resolved (and thus never
    // mutated) by a space-scoped caller. Edges with existing
    // `(source_id, target_id, edge_type)` rows take the skipped/updated
    // path; the rest go through full validation + create.
    const existingByTriple = await storage.edges.findByTriplesBatch(
      rawEdges.map((e) => ({
        source_id: e.source_id,
        target_id: e.target_id,
        edge_type: e.edge_type,
      })),
      spaceId,
    );

    const run = async (): Promise<{
      results: BulkEdgeResult[];
      createdEdges: Edge[];
      updatedEdges: Edge[];
    }> => {
      const results: BulkEdgeResult[] = [];
      const createdEdges: Edge[] = [];
      const updatedEdges: Edge[] = [];
      for (const [i, raw] of rawEdges.entries()) {
        const { result, created, updated } = await processBulkEdge(
          storage,
          raw,
          i,
          {
            mode,
            spaceId,
            existingByTriple,
            checkEdgeWrite,
          },
        );
        if (atomic && result.outcome === "errored") {
          throw new MarfaError(
            ErrorCode.BULK_ATOMIC_ROLLBACK,
            `Bulk edges rolled back on edge ${String(i)}`,
            {
              index: i,
              code: result.error?.code,
              message: result.error?.message,
            },
          );
        }
        results.push(result);
        if (created) createdEdges.push(created);
        if (updated) updatedEdges.push(updated);
      }
      return { results, createdEdges, updatedEdges };
    };

    const { results, createdEdges, updatedEdges } = atomic
      ? await storage.runInTransaction(run)
      : await run();

    const counts = { created: 0, updated: 0, skipped: 0, errored: 0 };
    for (const r of results) counts[r.outcome] += 1;

    // Both outcomes publish. An upsert that replaces an existing edge's
    // properties is an edit, and a subscriber has no way to tell it apart
    // from one made through `PATCH /edges/:id` — so publishing for one and
    // not the other would make propagation depend on which route the
    // writer happened to use. `skipped` and `errored` wrote nothing and
    // publish nothing.
    for (const edge of createdEdges) {
      await publishEdge({ type: "edge_created", edge, spaceId, enableFanout });
    }
    for (const edge of updatedEdges) {
      await publishEdge({ type: "edge_updated", edge, spaceId, enableFanout });
    }

    await storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "edges.bulk",
      resource_type: "edges.bulk",
      details: {
        mode,
        atomic,
        total: rawEdges.length,
        ...counts,
      },
    });

    return c.json({ counts, results }, 200);
  });

  return router;
}
