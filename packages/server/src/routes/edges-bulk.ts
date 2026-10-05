import { runAuditedTransaction } from "../storage/audited-transaction.js";
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
 * Each committed unit records its audit before commit. Every created or
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
import {
  MarfaError,
  ErrorCode,
  isValidId,
  generateId,
} from "@withmarfa/shared";
import { BulkResponseSchema, type BulkSkipReason } from "./_schemas.js";
import type { Edge } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  getTypeFilter,
  mayReadEdgeEnd,
  requireAuth,
  requireTypeAccess,
  requireEdgePermission,
  readsSomeType,
} from "../middleware/auth.js";
import type { BlobProof, Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import {
  bulkAtomicRollback,
  countOutcomes,
  failedEntry,
  isWriteOutcomeUnknown,
  mayHaveCommitted,
  isEntryVerdict,
} from "./_bulk-rollback.js";
import { refuseReusedEdgeId } from "./_reused-edge-id.js";
import { edgeReadable, sourceTypesFor } from "./_edge-visibility.js";
import {
  assertEdgeCanBeCreated,
  edgeTargetNotFound,
} from "../storage/edge-constraints.js";
import { publishEdge } from "../pubsub.js";
import { requestBlobProof } from "./_blob-reach.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BULK_EDGES = 5000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const BulkEdgeInputItemSchema = z
  .object({
    id: z
      .string()
      .optional()
      .describe(
        "A UUIDv7 you choose for the edge, if the entry creates one. Leave it out and Marfa creates one.",
      ),
    source_id: z.string().describe("The ID of the item the edge starts from."),
    target_id: z.string().describe("The ID of the item the edge points to."),
    edge_type: z
      .string()
      .describe("The identifier of the edge type, such as `parent-of`."),
    properties: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "The edge's properties. On an existing edge they merge over its own. Leave it out for none.",
      ),
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
        "The version of the existing edge your entry is based on. A stale value makes the entry `errored`, or rolls everything back when `atomic` is true.",
      ),
  })
  .describe("One edge to create or update.");

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const edgesBulkRoute = createRoute({
  method: "post",
  path: "/bulk",
  operationId: "bulkUpsertEdges",
  tags: ["Edges"],
  summary: "Upsert edges in bulk",
  description:
    "Creates or updates up to 5,000 edges in one call, matching existing edges on `(source_id, target_id, edge_type)`. The batch is atomic by default: one failed entry rolls it all back. Returns each entry's outcome.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            edges: z
              .array(BulkEdgeInputItemSchema)
              .describe(
                "The entries to write, at most 5,000. The items they join must already exist.",
              ),
            mode: z
              .enum(["upsert", "create_only"])
              .optional()
              .describe(
                "`upsert` (the default) merges an entry's properties into the edge it matches. `create_only` skips it, reporting `skipped` with reason `duplicate_edge`.",
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
        "Returns `counts` and a `results` entry for each edge, in order: `created`, `updated`, `skipped` or `errored`. Under `create_only`, an entry that matches an edge is `skipped` with reason `duplicate_edge`.",
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
        "- `validation_error`: the body is malformed, or has more than 5,000 entries.\n- `missing_required_field`: an entry is missing `source_id`, `target_id` or `edge_type`.\n- `bulk_atomic_rollback`: with `atomic` true, an entry was refused and nothing was written. `details.code` and `details.index` give its code and position. The status is the one that refusal carries alone.",
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
        "- `type_not_permitted`: you don't have write on an entry's source item type, or your credential reaches no type.\n- `edge_permission_denied`: you don't have write on an entry's edge type.\n- `bulk_atomic_rollback`: one of these under `atomic`.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["bulk_atomic_rollback"]),
        },
      },
      description:
        "`bulk_atomic_rollback`: with `atomic` true, an entry names an item that doesn't exist, or whose type you can't read. `details.code` is `item_not_found`.",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["bulk_atomic_rollback"]),
        },
      },
      description:
        "`bulk_atomic_rollback`: with `atomic` true, an entry's edge has moved or its ID is taken. `details.code` is `version_conflict` or `id_reused`.",
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
  reason?: BulkSkipReason;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Process a single bulk-edge input. Caller owns the transaction envelope
 * (one-big-tx for atomic, per-call for best-effort), and every read here,
 * the existing triple included, runs inside it: an entry is judged against
 * the graph its write lands on, edges written by earlier entries of the same
 * page and by other requests among them.
 */
async function processBulkEdge(
  storage: Storage,
  raw: BulkEdgeInputItem,
  index: number,
  options: {
    mode: "upsert" | "create_only";
    /**
     * Per-edge write authorization, mirroring single-edge `POST /edges`:
     * write on the source item's type AND write on the edge type. An
     * unknown source, or one the credential may not read, gets the
     * edge-type gate alone and meets the create's not-found.
     * Throws on denial; the caller routes that to an `errored` outcome /
     * atomic rollback.
     */
    checkEdgeWrite: (sourceType: string | null, edgeType: string) => void;
    /** Whether the credential may read an end of this type. */
    mayRead: (type: string) => boolean;
    /** Whether the credential may be told about this stored edge. */
    mayTell: (edge: Edge) => Promise<boolean>;
    /** What the credential has proved of the digests an entry sends. */
    proof: NonNullable<BlobProof>;
  },
): Promise<{ result: BulkEdgeResult; created?: Edge; updated?: Edge }> {
  const { mode, checkEdgeWrite, mayRead, mayTell, proof } = options;

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

  // Before any mutation, and past the trash so trashing the source does not
  // lift the gate.
  const srcItem = await storage.items.getIncludingTrashed(raw.source_id);
  const sourceHidden = srcItem !== null && !mayRead(srcItem.type);
  try {
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
    // One the caller may not read meets the insert's collision instead.
    if (held && (await mayTell(held))) {
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

  // A hidden source has no edges a missing one could have, so its entry is
  // judged as a create, which answers it as missing.
  const existing = sourceHidden
    ? null
    : await storage.edges.findByTriple(
        raw.source_id,
        raw.target_id,
        raw.edge_type,
      );

  if (existing) {
    // A matched edge would otherwise say, with its id, that the target is
    // live; one the caller may not read answers as the create path does.
    const target = await storage.items.getIncludingTrashed(raw.target_id);
    if (!target || !mayRead(target.type)) {
      const refusal = edgeTargetNotFound(raw.target_id);
      return {
        result: {
          index,
          outcome: "errored",
          error: { code: refusal.code, message: refusal.message },
        },
      };
    }
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
    // entry's failure is that entry's result, not the batch's.
    let outcome;
    try {
      outcome = await storage.edges.updateProperties(
        existing.id,
        raw.properties ?? {},
        raw.version,
        undefined,
        proof,
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
      storage,
      {
        source_id: raw.source_id,
        target_id: raw.target_id,
        edge_type: raw.edge_type,
        properties: raw.properties,
      },
      mayRead,
    );
    const createInput = {
      source_id: raw.source_id,
      target_id: raw.target_id,
      edge_type: raw.edge_type,
      ...(raw.properties !== undefined && { properties: raw.properties }),
      ...(raw.id !== undefined && { id: raw.id }),
      blob_proof: proof,
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
    getTypeFilter(c);
    const mayRead = mayReadEdgeEnd(c);
    const proof = requestBlobProof(c, storage);
    // A source the key may not read is gated as an unknown one is, and
    // meets the same not-found when the entry is judged.
    const checkEdgeWrite = (
      sourceType: string | null,
      edgeType: string,
    ): void => {
      if (sourceType !== null && mayRead(sourceType)) {
        requireTypeAccess(c, sourceType, "write");
      }
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

    const operationId = generateId();
    const run = async (): Promise<BulkEdgeResult[]> => {
      // In atomic mode, judge every entry's ids and write gates before any
      // entry is looked up, as the item door does (`items.md` 31). The
      // transaction is what undoes a refused page; this pass decides which
      // refusal the page answers with. Left to the per-entry pass, a stale
      // entry ahead of a forbidden one would answer first, as a `409`, and
      // the caller would re-read the edge over a refusal whose cause is a
      // permission it lacks.
      if (atomic) {
        for (const [i, raw] of rawEdges.entries()) {
          const shape = !isValidId(raw.source_id)
            ? `Invalid source_id: ${raw.source_id}`
            : !isValidId(raw.target_id)
              ? `Invalid target_id: ${raw.target_id}`
              : raw.id !== undefined && !isValidId(raw.id)
                ? `Invalid id: ${raw.id}`
                : null;
          if (shape !== null) {
            throw bulkAtomicRollback(
              i,
              { code: ErrorCode.INVALID_ID, message: shape },
              "edge",
            );
          }
          try {
            const srcItem = await storage.items.getIncludingTrashed(
              raw.source_id,
            );
            checkEdgeWrite(srcItem?.type ?? null, raw.edge_type);
          } catch (err) {
            if (isEntryVerdict(err)) {
              throw bulkAtomicRollback(
                i,
                { code: err.code, message: err.message, details: err.details },
                "edge",
              );
            }
            throw err;
          }
        }
      }

      const results: BulkEdgeResult[] = [];
      for (const [i, raw] of rawEdges.entries()) {
        // Each entry's edge and its event commit together: inside the page's
        // transaction when it is atomic, in one of its own otherwise. Both
        // outcomes are announced, an upsert replacing an edge's properties
        // being an edit a subscriber cannot tell from one made through
        // `PATCH /edges/{id}`.
        const entry = async () => {
          const processed = await processBulkEdge(storage, raw, i, {
            mode,
            checkEdgeWrite,
            mayRead,
            mayTell: (edge) => edgeReadable(storage, requireAuth(c), edge),
            proof,
          });
          const written = processed.created ?? processed.updated;
          if (written) {
            const sourceTypes = await sourceTypesFor(storage, [
              written.source_id,
            ]);
            await publishEdge({
              type: processed.created ? "edge_created" : "edge_updated",
              edge: written,
              sourceType: sourceTypes.get(written.source_id),
              enableFanout,
            });
          }
          return processed;
        };
        const auditedEntry = () =>
          runAuditedTransaction(storage, entry, ({ result }) =>
            result.outcome === "created" || result.outcome === "updated"
              ? {
                  client_ip: c.get("clientIp") ?? null,
                  key_id: requireAuth(c).id,
                  action: "edges.bulk",
                  resource_type: "edges.bulk",
                  resource_id: result.id,
                  details: {
                    operation_id: operationId,
                    mode,
                    atomic: false,
                    total: rawEdges.length,
                    index: i,
                    outcome: result.outcome,
                  },
                }
              : null,
          );
        let result: BulkEdgeResult;
        const committed = results.some(mayHaveCommitted);
        if (atomic) {
          ({ result } = await entry());
        } else {
          try {
            ({ result } = await auditedEntry());
          } catch (err) {
            if (!committed && !isWriteOutcomeUnknown(err)) throw err;
            result = { index: i, outcome: "errored", error: failedEntry(err) };
          }
        }
        if (atomic && result.outcome === "errored") {
          throw bulkAtomicRollback(
            i,
            {
              code: result.error?.code,
              message: result.error?.message,
              details: result.error?.details,
            },
            "edge",
          );
        }
        results.push(result);
      }
      return results;
    };

    const results = atomic
      ? await runAuditedTransaction(storage, run, (results) => ({
          client_ip: c.get("clientIp") ?? null,
          key_id: requireAuth(c).id,
          action: "edges.bulk",
          resource_type: "edges.bulk",
          details: {
            operation_id: operationId,
            mode,
            atomic,
            total: rawEdges.length,
            ...countOutcomes(results),
          },
        }))
      : await run();

    const counts = countOutcomes(results);

    return c.json({ counts, results }, 200);
  });

  return router;
}
