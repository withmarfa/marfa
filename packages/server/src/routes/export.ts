import { createGzip } from "node:zlib";
import { Readable, PassThrough } from "node:stream";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  MarfaError,
  ErrorCode,
  GLOBAL_TYPE_WILDCARD,
  isValidTypePattern,
  ITEM_STATES,
  resolveEnforcement,
} from "@withmarfa/shared";
import type { ItemState } from "@withmarfa/shared";
import * as tar from "tar-stream";
import type { ApiKey } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { resolveBlobForSpace } from "../storage/blob-reader.js";
import { requireAuth, getTypeFilter } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { SourceFilterSettings } from "../storage/filter-sql.js";
import type { BlobBackend } from "../storage/blob-backend.js";
import { collectBlobHashes } from "../storage/blob-utils.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { resolveOrphanScope, withOrphanState } from "./_orphaned.js";
import type { PgClient } from "../storage/pg/connection.js";
import {
  acquireStreamRls,
  StreamPoolExhaustedError,
} from "../storage/pg/streaming-rls.js";
import type { StreamRlsContext } from "../storage/pg/streaming-rls.js";

/**
 * Acquire the stream's RLS connection, mapping pool exhaustion to the
 * retryable 503 the route contract promises. Called before any response
 * bytes exist, so the refusal is a real status the client can act on.
 */
async function acquireRlsOrRefuse(
  options: {
    rlsEnforce: boolean;
    pgClient: PgClient | null;
    streamReserveTimeoutMs?: number;
  },
  spaceId: string | undefined,
): Promise<StreamRlsContext | null> {
  if (!options.rlsEnforce || options.pgClient === null || !spaceId) {
    return null;
  }
  try {
    return await acquireStreamRls(options.pgClient, spaceId, {
      ...(options.streamReserveTimeoutMs !== undefined && {
        reserveTimeoutMs: options.streamReserveTimeoutMs,
      }),
    });
  } catch (err) {
    if (err instanceof StreamPoolExhaustedError) {
      throw new MarfaError(
        ErrorCode.STREAM_CAPACITY_EXHAUSTED,
        "No streaming capacity is available right now; retry shortly",
      );
    }
    throw err;
  }
}

/**
 * Options for `exportRoutes`. `rlsEnforce` + `pgClient` enable
 * session-level RLS on a dedicated pool connection for the duration
 * of the stream. Without both set, the route runs on the owner
 * connection — used for SQLite, for space-less callers (platform
 * admin / single-space self-host), and when RLS enforcement is
 * disabled instance-wide.
 */
export interface ExportRoutesOptions {
  rlsEnforce: boolean;
  pgClient: PgClient | null;
  /** Override for the stream-slot reservation window; tests drive the
   *  exhaustion path with a short one. Default lives in streaming-rls. */
  streamReserveTimeoutMs?: number;
}

/**
 * Resolve the target space for an export request.
 *
 * Three cases:
 *   1. **space_admin / member with space_id** — caller's space
 *      wins; cross-space attempts (`?target_space_id` set to
 *      anything other than the caller's own) are rejected with 403.
 *   2. **platform admin (no space_id)** — MUST pass an explicit
 *      `?target_space_id=<id>` query param. Without it we reject
 *      with 400, so a platform key never receives an export covering
 *      every space on the instance.
 *   3. **single-space self-host (anonymous / bootstrap admin
 *      mode)** — a space-less caller running against a DB whose items
 *      have no space_id (NULL) is the legitimate single-space path:
 *      pass `spaceId: undefined` through to the storage layer so list
 *      operations match `space_id IS NULL`, exporting the whole DB.
 *      Distinguishing this
 *      from case 2 is the explicit `target_space_id` query param —
 *      operators on hosted multi-space deployments must set it;
 *      single-space operators don't.
 */
function resolveExportSpace(
  apiKey: ApiKey | undefined,
  targetParam: string | undefined,
): string | undefined {
  const callerSpace = apiKey?.space_id;
  // Space-bound caller — own space wins.
  if (callerSpace) {
    if (targetParam !== undefined && targetParam !== callerSpace) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        "Cannot export another space's data — target_space_id must match caller's space_id (or be omitted).",
      );
    }
    return callerSpace;
  }
  // Space-less caller — platform admin OR single-space self-host.
  // The presence of `target_space_id` distinguishes them: platform
  // admins on hosted multi-space set it explicitly; single-space
  // self-hosts leave it unset.
  if (targetParam !== undefined) {
    return targetParam; // platform admin scoping to a specific space
  }
  return undefined; // single-space self-host fallback
}

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const exportRoute = createRoute({
  operationId: "exportSpaceData",
  method: "get",
  path: "/",
  tags: ["Export"],
  summary: "Export space data",
  description:
    "Streams the space's items with their metadata (tags and extensions) as `{item, metadata}` NDJSON lines, followed by the edges between exported items as `{edge}` lines (default) or, with `format=archive`, a `marfa-archive-v1.tar.gz` carrying `manifest.json`, `items.ndjson`, `edges.ndjson`, `types.ndjson` (the space's custom type and edge-type registrations, so a restore into an empty space can write the items that use them), and blob bytes that `POST /admin/restore-archive` can ingest. Space-scoped, exporting only what the caller can read; the response streams until the filter is exhausted. Only edges whose endpoints are both in the exported item set are included, so a filtered export never references items it does not carry.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      type: z
        .string()
        .optional()
        .describe("Filter to a single type identifier"),
      state: z.string().optional().describe("Filter by item state"),
      source: z.string().optional().describe("Filter by source credential"),
      since: z
        .string()
        .optional()
        .describe("Include only items updated at or after this timestamp"),
      until: z
        .string()
        .optional()
        .describe("Include only items updated at or before this timestamp"),
      format: z
        .string()
        .optional()
        .describe("Output format: `ndjson` (default) or `archive`"),
      // Platform admins scope a hosted-mode export to a specific space
      // by passing `?target_space_id=<id>`. Space-bound callers
      // (space_admin / member) get their own space automatically;
      // supplying a mismatching value here returns 403.
      target_space_id: z
        .string()
        .optional()
        .describe("Platform admins scope the export to a specific space"),
    }),
  },
  responses: {
    200: {
      content: {
        "text/x-ndjson": {
          schema: z.string(),
        },
      },
      description:
        "Streaming NDJSON export of items with metadata (or archive when format=archive)",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "Validation error",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function exportRoutes(
  storage: Storage,
  blobBackend: BlobBackend,
  options: ExportRoutesOptions = { rlsEnforce: false, pgClient: null },
) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(exportRoute, async (c) => {
    requireAuth(c);

    const query = c.req.valid("query");

    const spaceId = resolveExportSpace(c.get("apiKey"), query.target_space_id);

    // Audit the export attempt before streaming starts — stamped for
    // both archive and NDJSON paths. `details.scope: "platform_unscoped"`
    // signals operators when a platform admin exports without a
    // target_space_id (the self-host fallback that returns all rows —
    // fine on single-space deployments, a real concern on hosted
    // multi-space). Alerting on this shape catches accidental cross-
    // space exports.
    const platformUnscoped =
      c.get("apiKey")?.space_id === undefined &&
      query.target_space_id === undefined;
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: spaceId ?? null,
      key_id: c.get("apiKey")?.id,
      action: "export.space",
      resource_type: "space",
      resource_id: spaceId ?? undefined,
      details: {
        format: query.format ?? "ndjson",
        scope: platformUnscoped ? "platform_unscoped" : "space",
        ...(query.target_space_id !== undefined
          ? { target_space_id: query.target_space_id }
          : {}),
      },
    });

    // An export is a list read, so the space's read-narrowing lever applies
    // to it. Leaving it out would make the control bypassable by swapping
    // endpoint rather than by rewording the query.
    const spaceConfigForExport =
      spaceId && storage.spaces
        ? await storage.spaces.getConfig(spaceId)
        : null;
    const sourceFilter = resolveEnforcement(
      spaceConfigForExport,
      c.get("apiKey"),
    ).source_filter;

    if (query.format === "archive") {
      return handleArchiveExport(
        c,
        storage,
        blobBackend,
        options,
        spaceId,
        sourceFilter,
      );
    }

    // Pattern grammar, matching `GET /items` and `/search`: the parameter
    // means the type and everything under it on all three, so the explicit
    // `parent.*` spelling has to be accepted on all three too.
    const type = query.type;
    if (type && (type === GLOBAL_TYPE_WILDCARD || !isValidTypePattern(type))) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid type identifier",
      );
    }

    const state = query.state as ItemState | undefined;
    if (state && !(ITEM_STATES as readonly string[]).includes(state)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid state: ${state}`,
      );
    }

    const since = query.since;
    const until = query.until;
    const source = query.source;

    const allowedTypes = getTypeFilter(c);
    const encoder = new TextEncoder();

    // Acquired before the response exists, so an exhausted pool answers a
    // real 503 instead of a broken stream behind a 200 already sent.
    const acquiredCtx = await acquireRlsOrRefuse(options, spaceId);

    const stream = new ReadableStream({
      async start(controller) {
        const rlsCtx = acquiredCtx;
        try {
          const work = async () => {
            // Ids of every item this export emits. Edges are filtered
            // against it below: an export carries the relationships among
            // the items it contains, so a filtered export never references
            // an item the output does not hold.
            const exportedIds = new Set<string>();
            let cursor: string | undefined;
            do {
              const result = await storage.items.list({
                spaceId,
                type,
                state,
                source,
                since,
                until,
                allowed_types: allowedTypes,
                source_filter: sourceFilter,
                limit: 200,
                cursor,
              });

              // Per page rather than once per stream: the page is the
              // batch, so an export carrying no integration-written row
              // pays nothing. A long export re-walks per page, which is
              // bounded by how many connections the space has and is noise
              // beside the per-item metadata read in the same loop. See
              // `_orphaned.ts`.
              const orphanScope = await resolveOrphanScope(
                storage,
                spaceId,
                result.data,
              );
              for (const item of result.data) {
                const metadata = await storage.metadata.get(item.id);
                exportedIds.add(item.id);
                controller.enqueue(
                  encoder.encode(
                    JSON.stringify({
                      item: withOrphanState(item, orphanScope),
                      metadata,
                    }) + "\n",
                  ),
                );
              }

              cursor = result.has_more
                ? (result.cursor as string | undefined)
                : undefined;
            } while (cursor);

            let edgeCursor: string | undefined;
            do {
              const page = await storage.edges.list({
                spaceId,
                limit: 200,
                cursor: edgeCursor,
              });
              for (const edge of page.data) {
                if (
                  exportedIds.has(edge.source_id) &&
                  exportedIds.has(edge.target_id)
                ) {
                  controller.enqueue(
                    encoder.encode(JSON.stringify({ edge }) + "\n"),
                  );
                }
              }
              edgeCursor = page.has_more
                ? (page.cursor ?? undefined)
                : undefined;
            } while (edgeCursor);
          };
          if (rlsCtx) {
            await rlsCtx.withInstalledContext(work);
          } else {
            await work();
          }
        } finally {
          controller.close();
          if (rlsCtx) {
            await rlsCtx.release();
          }
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Archive export helper
// ---------------------------------------------------------------------------

interface ArchiveManifest {
  version: number;
  format: string;
  created_at: string;
  /**
   * space_id stamped at export time. `null` for single-space
   * self-host exports (no space scope on either side); a string for
   * hosted-mode exports. Used by `/admin/restore-archive` to verify
   * cross-space restore attempts (rejected unless the platform admin
   * passes an explicit `target_space_id`).
   */
  space_id: string | null;
  item_count: number;
  edge_count: number;
  blob_count: number;
  /** Custom type and edge-type registrations carried in `types.ndjson`.
   *  Optional so an archive written before the member existed still
   *  parses; absent reads the same as zero. */
  custom_type_count?: number;
  custom_edge_type_count?: number;
  blobs: Record<string, { mime_type: string; size: number }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HonoContext = Context<any, any, any>;

async function handleArchiveExport(
  c: HonoContext,
  storage: Storage,
  blobBackend: BlobBackend,
  options: ExportRoutesOptions,
  /** Already resolved by the route handler — passed in rather than
   *  re-resolved so the space decision happens exactly once per request. */
  spaceId: string | undefined,
  /** The space's `source_filter` lever, resolved alongside `spaceId`. */
  sourceFilter: SourceFilterSettings | undefined,
): Promise<Response> {
  const type = c.req.query("type");
  if (type && (type === GLOBAL_TYPE_WILDCARD || !isValidTypePattern(type))) {
    throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid type identifier");
  }
  const state = c.req.query("state") as ItemState | undefined;
  if (state && !(ITEM_STATES as readonly string[]).includes(state)) {
    throw new MarfaError(ErrorCode.VALIDATION_ERROR, `Invalid state: ${state}`);
  }
  const since = c.req.query("since");
  const until = c.req.query("until");
  const source = c.req.query("source");
  const allowedTypes = getTypeFilter(c);

  const rlsCtx = await acquireRlsOrRefuse(options, spaceId);

  const lines: string[] = [];
  const edgeLines: string[] = [];
  const typeLines: string[] = [];
  let customTypeCount = 0;
  let customEdgeTypeCount = 0;
  const blobHashes = new Set<string>();
  const blobMeta: Record<string, { mime_type: string; size: number }> = {};

  try {
    const collect = async () => {
      // Same both-endpoints rule as the NDJSON path: the archive carries
      // the relationships among the items it contains, nothing beyond.
      const exportedIds = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = await storage.items.list({
          spaceId,
          type,
          state,
          source,
          since,
          until,
          allowed_types: allowedTypes,
          source_filter: sourceFilter,
          limit: 200,
          cursor,
        });
        // Same per-page resolution as the NDJSON path. A restore reads the
        // fields it writes by name, so the derived one rides along in the
        // archive without becoming something a restore could store.
        const orphanScope = await resolveOrphanScope(
          storage,
          spaceId,
          result.data,
        );
        for (const item of result.data) {
          const metadata = await storage.metadata.get(item.id);
          exportedIds.add(item.id);
          lines.push(
            JSON.stringify({
              item: withOrphanState(item, orphanScope),
              metadata,
            }),
          );
          collectBlobHashes(item.properties, blobHashes);
          collectBlobHashes(metadata.extensions, blobHashes);
        }
        cursor = result.has_more
          ? (result.cursor as string | undefined)
          : undefined;
      } while (cursor);

      let edgeCursor: string | undefined;
      do {
        const page = await storage.edges.list({
          spaceId,
          limit: 200,
          cursor: edgeCursor,
        });
        for (const edge of page.data) {
          if (
            exportedIds.has(edge.source_id) &&
            exportedIds.has(edge.target_id)
          ) {
            edgeLines.push(JSON.stringify({ edge }));
          }
        }
        edgeCursor = page.has_more ? (page.cursor ?? undefined) : undefined;
      } while (edgeCursor);

      // The space's own registrations, not the filtered item set's: a
      // restore has to be able to write every item the archive carries,
      // and an unfiltered archive is the case that matters. Carrying a
      // type the archive happens not to use costs one line.
      for (const schema of await storage.types.listCustom(spaceId)) {
        typeLines.push(JSON.stringify({ custom_type: schema }));
        customTypeCount += 1;
      }
      for (const schema of await storage.edgeTypes.list(spaceId)) {
        typeLines.push(JSON.stringify({ custom_edge_type: schema }));
        customEdgeTypeCount += 1;
      }

      // A space-less export is a platform admin's, and its items came from
      // every space — so the blob lookup has to reach every space too. It
      // used to ask the instance-wide `""` bucket instead, where none of
      // those hashes live, and the archive recorded `blob_count: 0` while
      // reporting success. The same rule the read routes use.
      for (const hash of blobHashes) {
        const record = await resolveBlobForSpace(storage, spaceId, hash);
        if (record) {
          blobMeta[hash] = { mime_type: record.mime_type, size: record.size };
        }
      }
    };
    if (rlsCtx) {
      await rlsCtx.withInstalledContext(collect);
    } else {
      await collect();
    }
  } finally {
    if (rlsCtx) {
      await rlsCtx.release();
    }
  }

  // Blob bytes come from the BlobBackend (not Postgres), so no RLS context needed here.
  const manifest: ArchiveManifest = {
    version: 1,
    format: "marfa-archive-v1",
    created_at: new Date().toISOString(),
    space_id: spaceId ?? null,
    item_count: lines.length,
    edge_count: edgeLines.length,
    blob_count: Object.keys(blobMeta).length,
    custom_type_count: customTypeCount,
    custom_edge_type_count: customEdgeTypeCount,
    blobs: blobMeta,
  };

  const pack = tar.pack();
  const gzip = createGzip();
  const passthrough = new PassThrough();
  pack.pipe(gzip).pipe(passthrough);

  const writeEntries = async (): Promise<void> => {
    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2));
    pack.entry(
      { name: "manifest.json", size: manifestBuf.length },
      manifestBuf,
    );

    const ndjsonBuf = Buffer.from(lines.join("\n") + "\n");
    pack.entry({ name: "items.ndjson", size: ndjsonBuf.length }, ndjsonBuf);

    // Emitted even when empty so a restore can tell "no edges" from
    // "an archive predating edge support".
    const edgesBuf = Buffer.from(
      edgeLines.length > 0 ? edgeLines.join("\n") + "\n" : "",
    );
    pack.entry({ name: "edges.ndjson", size: edgesBuf.length }, edgesBuf);

    // Always emitted, empty or not, for the same reason as edges.ndjson:
    // a restore has to be able to tell "this space registered nothing"
    // from "this archive predates type registrations".
    const typesBuf = Buffer.from(
      typeLines.length > 0 ? typeLines.join("\n") + "\n" : "",
    );
    pack.entry({ name: "types.ndjson", size: typesBuf.length }, typesBuf);

    for (const hash of Object.keys(blobMeta)) {
      const data = await blobBackend.get(hash);
      if (data) {
        pack.entry({ name: `blobs/${hash}`, size: data.length }, data);
      }
    }

    pack.finalize();
  };

  writeEntries().catch(() => {
    passthrough.destroy();
  });

  const webStream = Readable.toWeb(passthrough) as ReadableStream;

  const date = new Date().toISOString().split("T")[0] ?? "today";
  return new Response(webStream, {
    status: 200,
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="marfa-export-${date}.tar.gz"`,
    },
  });
}
