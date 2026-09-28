/**
 * Bulk edge creation — `POST /edges/bulk`.
 *
 * Parallel to `POST /items/bulk`: caller provides an explicit list of edges
 * to create or upsert; server returns per-edge outcomes plus aggregate
 * counts. Used by mode-transition flows (Local → Marfa, iCloud → Marfa) to
 * migrate edges in a second pass after items.bulk lands — items.bulk's
 * inline `edges` block only handles edges whose source and target both live
 * inside a single batch, which is not the case during a multi-batch
 * migration.
 *
 * One aggregate audit row per call (never N per edge). Every created or
 * updated edge appends to the event log, unconditionally: the log is what
 * a client rebuilding its state replays, so an edge missing from it is one
 * that client can never learn about. The update half was silent while the
 * pubsub enum had no `edge_updated` variant; it does now, and a bulk edit
 * propagates like a single one.
 *
 * `enable_fanout` governs the outbound work instead — webhook delivery —
 * and defaults off, so a
 * multi-batch migration does not call out once per edge it moves.
 *
 * Authorization mirrors single-edge `POST /edges`: the caller needs write
 * on the source item's type AND write on the edge type. Same 5000-edge cap
 * as items.bulk.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode, isValidId } from "@withmarfa/shared";
import { BulkResponseSchema } from "./_schemas.js";
import type { Edge } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  mayReadEdgeTarget,
  requireAuth,
  requireTypeAccess,
  requireEdgePermission,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { bulkAtomicRollback, isEntryVerdict } from "./_bulk-rollback.js";
import { refuseReusedEdgeId } from "./_reused-edge-id.js";
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
  /** The version this entry was based on, where the triple resolves an
   *  edge that already exists. Optional for the same reason it is optional
   *  on the item bulk door: an entry creating an edge it has never read has
   *  no version to name. */
  version: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "The version the caller read, where this entry resolves an edge that already exists. A stale value is refused as that entry's outcome, or rolls the page back under the default `atomic`.",
    ),
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
    "Creates or upserts up to 5000 edges in one call, matching existing rows on `(source_id, target_id, edge_type)`. An entry that matches an existing row merges its properties over that row's, as `PATCH /edges/{id}` does, so an upsert naming one property leaves the others standing. Atomic by default; the items being wired together must already exist. Requires write access to each edge's source-item type and to the edge type. A target whose type the caller may not read is answered as a missing one, as `POST /edges` answers it.",
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
        "application/json": { schema: BulkResponseSchema },
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
            "bulk_atomic_rollback",
          ]),
        },
      },
      description:
        "Write access denied for a source type or edge type. Under the default `atomic` the page rolls back and the code is `bulk_atomic_rollback` with the inner refusal in `details.code`, at this status rather than 400 for the reason `POST /items/bulk` gives.",
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
  /** The version this entry was based on, where the triple resolves an edge
   *  that already exists. Optional: an entry creating one has none to name. */
  version?: number;
}

interface BulkEdgeResult {
  index: number;
  outcome: "created" | "updated" | "skipped" | "errored";
  id?: string;
  reason?: string;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
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
    existingByTriple: Map<string, Edge>;
    /**
     * Per-edge write authorization, mirroring single-edge `POST /edges`:
     * write on the source item's type AND write on the edge type. An
     * unknown source resolves to `null` and the edge-type gate alone
     * applies (matching `PATCH /edges/:id`).
     * Throws on denial; the caller routes that to an `errored` outcome /
     * atomic rollback.
     */
    checkEdgeWrite: (sourceType: string | null, edgeType: string) => void;
    /** Whether the credential may read a target of this type. */
    mayReadTarget: (type: string) => boolean;
  },
): Promise<{ result: BulkEdgeResult; created?: Edge; updated?: Edge }> {
  const { mode, existingByTriple, checkEdgeWrite, mayReadTarget } = options;

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
  // type (getIncludingTrashed so a trashed source still runs the gate,
  // matching PATCH /edges/:id). An unknown source resolves to null and the
  // edge-type gate alone applies.
  try {
    const srcItem = await storage.items.getIncludingTrashed(raw.source_id);
    checkEdgeWrite(srcItem?.type ?? null, raw.edge_type);
  } catch (err) {
    if (isEntryVerdict(err)) {
      return {
        result: {
          index,
          outcome: "errored",
          error: {
            code: err.code,
            message: err.message,
            ...(err.details && { details: err.details }),
          },
        },
      };
    }
    throw err;
  }

  // An id the caller minted that already names a different edge, refused
  // here rather than left to the primary key. The same comparison the
  // single door makes, shared with it, because the code a caller gets for
  // one mistake must not depend on how many edges it batched: without
  // this the insert below met the constraint and came back as a bare
  // collision with nothing saying what disagreed.
  if (raw.id !== undefined) {
    const held = await storage.edges.get(raw.id);
    if (held) {
      try {
        refuseReusedEdgeId(held, raw);
      } catch (err) {
        if (isEntryVerdict(err)) {
          return {
            result: {
              index,
              outcome: "errored",
              error: {
                code: err.code,
                message: err.message,
                ...(err.details && { details: err.details }),
              },
            },
          };
        }
        throw err;
      }
    }
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
    // upsert — merge properties over the row in place. Matches
    // PATCH /edges/:id semantics, which merge shallowly rather than
    // replacing, so an entry naming one property leaves the others
    // standing (source/target/type stay immutable either way).
    //
    // Conditional where the entry named a version, unconditional where it
    // did not — the same bargain the item bulk door strikes, and for the
    // same caller: an entry creating an edge it has never read has no
    // version to name, and one updating an edge it has read does.
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
        raw.version,
      );
    } catch (err) {
      if (isEntryVerdict(err)) {
        return {
          result: {
            index,
            outcome: "errored",
            error: {
              code: err.code,
              message: err.message,
              ...(err.details && { details: err.details }),
            },
          },
        };
      }
      throw err;
    }
    if (!outcome.ok) {
      // Reachable only for an entry that named a version. That entry's own
      // outcome, so a page draining a queue does not lose every other edge
      // to one stale one; under the default `atomic` the caller sees the
      // rollback instead, which is what every other per-entry refusal on
      // this door does.
      return {
        result: {
          index,
          outcome: "errored",
          id: existing.id,
          error: {
            code: ErrorCode.VERSION_CONFLICT,
            message: `Version ${String(raw.version)} is stale; current version is ${String(outcome.current.version)}`,
          },
        },
      };
    }
    const updated = outcome.edge;
    return {
      result: { index, outcome: "updated", id: updated.id },
      updated,
    };
  }

  try {
    await assertEdgeCanBeCreated(
      storage.edges,
      storage.items,
      {
        source_id: raw.source_id,
        target_id: raw.target_id,
        edge_type: raw.edge_type,
        properties: raw.properties,
      },
      mayReadTarget,
    );
    const createInput = {
      source_id: raw.source_id,
      target_id: raw.target_id,
      edge_type: raw.edge_type,
      ...(raw.properties !== undefined && { properties: raw.properties }),
      ...(raw.id !== undefined && { id: raw.id }),
    };
    const created = await storage.edges.createRaw(createInput);
    return {
      result: { index, outcome: "created", id: created.id },
      created,
    };
  } catch (err) {
    if (isEntryVerdict(err)) {
      return {
        result: {
          index,
          outcome: "errored",
          error: {
            code: err.code,
            message: err.message,
            ...(err.details && { details: err.details }),
          },
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
    // write), mirroring single-edge `POST /edges`.
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
          throw bulkAtomicRollback(
            i,
            {
              code: ErrorCode.INVALID_ID,
              message: `Invalid source_id: ${raw.source_id}`,
            },
            "edge",
          );
        }
        if (!isValidId(raw.target_id)) {
          throw bulkAtomicRollback(
            i,
            {
              code: ErrorCode.INVALID_ID,
              message: `Invalid target_id: ${raw.target_id}`,
            },
            "edge",
          );
        }
        if (raw.id !== undefined && !isValidId(raw.id)) {
          throw bulkAtomicRollback(
            i,
            { code: ErrorCode.INVALID_ID, message: `Invalid id: ${raw.id}` },
            "edge",
          );
        }
        // Authorize the write up-front so an unauthorized edge aborts the
        // batch before any row lands (SQLite can't roll back async txns).
        try {
          const srcItem = await storage.items.getIncludingTrashed(
            raw.source_id,
          );
          checkEdgeWrite(srcItem?.type ?? null, raw.edge_type);
        } catch (err) {
          if (isEntryVerdict(err)) {
            throw bulkAtomicRollback(
              i,
              { code: err.code, message: err.message },
              "edge",
            );
          }
          throw err;
        }
      }
    }

    // Pre-resolve duplicates in one batched pass. Edges with existing
    // `(source_id, target_id, edge_type)` rows take the skipped/updated
    // path; the rest go through full validation + create.
    const existingByTriple = await storage.edges.findByTriplesBatch(
      rawEdges.map((e) => ({
        source_id: e.source_id,
        target_id: e.target_id,
        edge_type: e.edge_type,
      })),
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
            existingByTriple,
            checkEdgeWrite,
            mayReadTarget: mayReadEdgeTarget(c),
          },
        );
        if (atomic && result.outcome === "errored") {
          throw bulkAtomicRollback(
            i,
            { code: result.error?.code, message: result.error?.message },
            "edge",
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
      await publishEdge({ type: "edge_created", edge, enableFanout });
    }
    for (const edge of updatedEdges) {
      await publishEdge({ type: "edge_updated", edge, enableFanout });
    }

    await storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
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
