/**
 * Bulk edge creation — `POST /edges/bulk`.
 *
 * Parallel to `POST /items/bulk`: caller provides an explicit list of edges
 * to create or upsert; server returns per-edge outcomes plus aggregate
 * counts. Used by mode-transition flows (Local → Myme, iCloud → Myme) to
 * migrate edges in a second pass after items.bulk lands — items.bulk's
 * inline `edges` block only handles edges whose source and target both live
 * inside a single batch, which is not the case during multi-batch tenant
 * migration.
 *
 * One aggregate audit row per call (never N per edge). `emit_events`
 * defaults off and fires `edge.created` for newly-created edges only —
 * upsert-updates to existing edge properties emit nothing because there is
 * no `edge.updated` event in the current pubsub enum.
 *
 * Admin-only, mirroring items.bulk. Same 5000-edge cap.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { MymeError, ErrorCode, isValidId } from "@mymehq/shared";
import type { Edge } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, ErrorResponseSchema } from "../openapi.js";
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
  tags: ["Edges"],
  summary: "Bulk upsert edges",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            edges: z.array(BulkEdgeInputItemSchema),
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
        "application/json": { schema: BulkEdgeResponseSchema },
      },
      description: "Bulk edge result",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Validation error or atomic rollback",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Admin required",
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
    tenantId: string | undefined;
    existingByTriple: Map<string, Edge>;
  },
): Promise<{ result: BulkEdgeResult; created?: Edge }> {
  const { mode, tenantId, existingByTriple } = options;

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
    const updated = await storage.edges.updateProperties(
      existing.id,
      raw.properties ?? {},
    );
    return {
      result: { index, outcome: "updated", id: updated.id },
    };
  }

  try {
    await assertEdgeCanBeCreated(storage.edges, storage.items, {
      source_id: raw.source_id,
      target_id: raw.target_id,
      edge_type: raw.edge_type,
      tenant_id: tenantId,
    });
    const createInput = {
      source_id: raw.source_id,
      target_id: raw.target_id,
      edge_type: raw.edge_type,
      ...(raw.properties !== undefined && { properties: raw.properties }),
      ...(raw.id !== undefined && { id: raw.id }),
    };
    const created = await storage.edges.createRaw(createInput, tenantId);
    return {
      result: { index, outcome: "created", id: created.id },
      created,
    };
  } catch (err) {
    if (err instanceof MymeError) {
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
    requireAdmin(c);

    const body = c.req.valid("json");
    const rawEdges = body.edges;
    const mode = body.mode ?? "upsert";
    const atomic = body.atomic ?? true;
    const emitEvents = body.emit_events ?? false;

    if (rawEdges.length > MAX_BULK_EDGES) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        `Maximum ${String(MAX_BULK_EDGES)} edges per call`,
        { cap: MAX_BULK_EDGES, provided: rawEdges.length },
      );
    }

    const tenantId = c.get("apiKey")?.tenant_id;

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
          throw new MymeError(
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
          throw new MymeError(
            ErrorCode.BULK_ATOMIC_ROLLBACK,
            `Bulk edges rolled back on edge ${String(i)}`,
            {
              index: i,
              code: ErrorCode.INVALID_ID,
              message: `Invalid target_id: ${raw.target_id}`,
            },
          );
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
    }> => {
      const results: BulkEdgeResult[] = [];
      const createdEdges: Edge[] = [];
      for (const [i, raw] of rawEdges.entries()) {
        const { result, created } = await processBulkEdge(storage, raw, i, {
          mode,
          tenantId,
          existingByTriple,
        });
        if (atomic && result.outcome === "errored") {
          throw new MymeError(
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
      }
      return { results, createdEdges };
    };

    const { results, createdEdges } = atomic
      ? await storage.runInTransaction(run)
      : await run();

    const counts = { created: 0, updated: 0, skipped: 0, errored: 0 };
    for (const r of results) counts[r.outcome] += 1;

    // Fire edge.created events only for newly-created edges. Upsert
    // property-replace outcomes do not emit — the pubsub enum has no
    // edge_updated variant and adding one is out of scope for this PR.
    if (emitEvents) {
      for (const edge of createdEdges) {
        await publishEdge({
          type: "edge_created",
          edge,
          tenantId,
          ...c.var.cycle,
        });
      }
    }

    await storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
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
