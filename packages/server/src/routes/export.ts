import { createGzip } from "node:zlib";
import { Readable, PassThrough } from "node:stream";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { MarfaError, ErrorCode, resolveEnforcement } from "@withmarfa/shared";
import * as tar from "tar-stream";
import type { ApiKey } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { assertTypeFilter } from "./_type-filter.js";
import { withPreparedHeaders } from "../prepared-headers.js";
import { resolveBlobForSpace } from "../storage/blob-reader.js";
import { requireAuth, getTypeFilter } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { SourceFilterSettings } from "../storage/filter-sql.js";
import type { BlobBackend } from "../storage/blob-backend.js";
import { collectBlobHashes } from "../storage/blob-utils.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { createOrphanResolver, withOrphanState } from "./_orphaned.js";
import type { PgClient } from "../storage/pg/connection.js";
import {
  acquireStreamRls,
  StreamPoolExhaustedError,
} from "../storage/pg/streaming-rls.js";
import type { StreamRlsContext } from "../storage/pg/streaming-rls.js";
import { refuseRenamedTimeQueryParams } from "./_renamed-time-filters.js";
import { ALL_STATES, resolveStateFilter } from "./_schemas.js";
import {
  refuseUnknownQueryParams,
  UNKNOWN_PARAM_NOTE,
} from "./_unknown-query-keys.js";

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
 * connection: SQLite, and an instance with RLS enforcement disabled.
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
 * An export reads the caller's own space, and `?target_space_id` is an
 * assertion about which space that is rather than a way of naming another:
 * a mismatch is refused with 403 so a client exporting the wrong space is
 * told, instead of receiving somebody else's rows under its own name.
 *
 * **The two space-less arms are gone rather than dormant.** They existed for
 * the operator key, the only credential that can be space-less, and that key
 * holds no content permissions at all: the read narrowing every export runs
 * through resolved to nothing, so both the named-space arm and the
 * whole-instance fallback streamed an empty body while writing an audit
 * record saying a space had been exported. Moving a space is a key minted
 * into it with everything, and such a key takes the ordinary path here.
 */
function resolveExportSpace(
  apiKey: ApiKey | undefined,
  targetParam: string | undefined,
): string {
  const callerSpace = apiKey?.space_id;
  if (!callerSpace) {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      "Export is scoped to one space and this credential is bound to none. Mint a key into the space and export with that.",
    );
  }
  if (targetParam !== undefined && targetParam !== callerSpace) {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      "Cannot export another space's data — target_space_id must match caller's space_id (or be omitted).",
    );
  }
  return callerSpace;
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
    "Streams the space's items with their metadata (tags and extensions) as `{item, metadata}` NDJSON lines, followed by the edges between exported items as `{edge}` lines (default) or, with `format=archive`, a `marfa-archive-v1.tar.gz` carrying `manifest.json`, `items.ndjson`, `edges.ndjson`, `types.ndjson` (the space's custom type and edge-type registrations, so a restore into an empty space can write the items that use them), and blob bytes that `POST /admin/restore-archive` can ingest. Space-scoped, exporting only what the caller can read; the response streams until the filter is exhausted. Only edges whose endpoints are both in the exported item set are included, so a filtered export never references items it does not carry. " +
    UNKNOWN_PARAM_NOTE,
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      type: z
        .string()
        .optional()
        .describe(
          "Filter to a single type identifier, subtypes included. A concrete identifier the space does not know is refused with 400 `unknown_type`.",
        ),
      state: z
        .string()
        .optional()
        .describe(
          `Filter by item state. \`${ALL_STATES}\` exports every state including trashed, in one pass — which is what an export meaning "everything this space holds" needs, since the archive is what a restore reads back. Omitting the parameter keeps the default every item read applies, which excludes trashed rows.`,
        ),
      source: z.string().optional().describe("Filter by source credential"),
      timestamp_after: z
        .string()
        .optional()
        .describe(
          "Include only items whose own time — `timestamp`, falling back to `created_at` — is at or after this (inclusive). Not the modification time, despite what this parameter's previous name suggested.",
        ),
      timestamp_before: z
        .string()
        .optional()
        .describe(
          "Include only items whose own time — `timestamp`, falling back to `created_at` — is at or before this (inclusive).",
        ),
      format: z
        .string()
        .optional()
        .describe("Output format: `ndjson` (default) or `archive`"),
      // An assertion, not a selector: the export is always the caller's own
      // space, and naming a different one is refused rather than honored.
      target_space_id: z
        .string()
        .optional()
        .describe(
          "Must match the caller's own space when supplied; naming another space is refused",
        ),
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
          schema: makeErrorResponseSchema(["validation_error", "unknown_type"]),
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

    // Covers the archive path too: it is reached from inside this handler,
    // so refusing here refuses for both. An export narrowed by a filter
    // that was silently dropped writes the whole space to a file the
    // caller believes is a slice of it.
    //
    // This door has no modification-time filter, so the refusal must not
    // offer one: its query schema strips an unknown key, and a caller
    // following that advice would land back in the silence the refusal is
    // here to prevent.
    refuseRenamedTimeQueryParams(c.req.raw.url, { catchUpFilter: "none" });
    // One check for both output formats: `format=archive` is handled by a
    // separate function further down but arrives through this handler and
    // shares this query schema, so refusing here covers both.
    refuseUnknownQueryParams(c.req.raw.url, exportRoute.request.query);

    const query = c.req.valid("query");

    const spaceId = resolveExportSpace(c.get("apiKey"), query.target_space_id);

    // Audit the export attempt before streaming starts, stamped for both
    // the archive and NDJSON paths. An export is a bulk extraction of a
    // space, so the record has to exist whether or not the stream that
    // follows completes.
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: spaceId,
      key_id: c.get("apiKey")?.id,
      action: "export.space",
      resource_type: "space",
      resource_id: spaceId,
      details: {
        format: query.format ?? "ndjson",
        scope: "space",
        ...(query.target_space_id !== undefined
          ? { target_space_id: query.target_space_id }
          : {}),
      },
    });

    // An export is a list read, so the space's read-narrowing lever applies
    // to it. Leaving it out would make the control bypassable by swapping
    // endpoint rather than by rewording the query.
    const spaceConfigForExport = storage.spaces
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
    // The space resolved once above, as the archive path passes it.
    assertTypeFilter(type, spaceId);

    // Same resolution as `GET /items`, sentinel included. Export shares the
    // storage filter with the listing, so a door that could not name every
    // state was a route-layer gap rather than a missing permission.
    const { state, all_states: allStates } = resolveStateFilter(query.state);

    const timestampAfter = query.timestamp_after;
    const timestampBefore = query.timestamp_before;
    const source = query.source;

    const { allowed: allowedTypes, excluded: excludedTypes } = getTypeFilter(c);
    const encoder = new TextEncoder();

    // Acquired before the response exists, so an exhausted pool answers a
    // real 503 instead of a broken stream behind a 200 already sent.
    const acquiredCtx = await acquireRlsOrRefuse(options, spaceId);

    const orphans = createOrphanResolver(storage);

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
                all_states: allStates,
                source,
                timestamp_after: timestampAfter,
                timestamp_before: timestampBefore,
                allowed_types: allowedTypes,
                excluded_types: excludedTypes,
                source_filter: sourceFilter,
                limit: 200,
                cursor,
              });

              // The resolver is the stream's, so a space is walked once for
              // the whole export rather than once per page — a million rows
              // at 200 a page is five thousand walks otherwise, all on the
              // one reserved RLS connection this stream pins. Per page is
              // still where it is *called*, because the space is a
              // property of the rows rather than of the request. See
              // `_orphaned.ts`.
              const orphanScope = await orphans.resolve(result.data);
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

    return withPreparedHeaders(
      c,
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      }),
    );
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
   * space_id stamped at export time, and always a string on anything
   * this build writes: an export is scoped to the caller's space. `null`
   * survives on the read side for archives written before that was true,
   * and `/admin/restore-archive` uses the field to verify cross-space
   * restore attempts.
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
  spaceId: string,
  /** The space's `source_filter` lever, resolved alongside `spaceId`. */
  sourceFilter: SourceFilterSettings | undefined,
): Promise<Response> {
  const type = c.req.query("type");
  assertTypeFilter(type, spaceId);
  // The NDJSON path's twin, and it has to read the parameter the same way:
  // the two formats are one door with one query schema, so a sentinel
  // honored by one and stripped by the other would be worse than neither.
  const { state, all_states: allStates } = resolveStateFilter(
    c.req.query("state"),
  );
  const timestampAfter = c.req.query("timestamp_after");
  const timestampBefore = c.req.query("timestamp_before");
  const source = c.req.query("source");
  const { allowed: allowedTypes, excluded: excludedTypes } = getTypeFilter(c);

  const rlsCtx = await acquireRlsOrRefuse(options, spaceId);

  const orphans = createOrphanResolver(storage);
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
          all_states: allStates,
          source,
          timestamp_after: timestampAfter,
          timestamp_before: timestampBefore,
          allowed_types: allowedTypes,
          excluded_types: excludedTypes,
          source_filter: sourceFilter,
          limit: 200,
          cursor,
        });
        // Same stream-scoped resolver as the NDJSON path. A restore reads
        // the fields it writes by name, so the derived one rides along in
        // the archive without becoming something a restore could store.
        const orphanScope = await orphans.resolve(result.data);
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
      // Provenance rides beside the schema rather than inside it. The
      // restore validates and normalizes `custom_type` and compares the
      // result against the stored row to decide skip-or-conflict, so a
      // field added into the schema would read as a different registration
      // and turn every re-restore into a conflict.
      //
      // It is carried at all because `origin` stopped being descriptive:
      // it decides whether the consent screen offers a root read-only or
      // read-and-write. An archive that drops it makes the restore guess,
      // and the default it guessed was the permissive one.
      for (const row of await storage.types.listCustomWithProvenance(spaceId)) {
        typeLines.push(
          JSON.stringify({
            custom_type: row.schema,
            provenance: {
              origin: row.origin,
              ...(row.family !== undefined && { family: row.family }),
              ...(row.owner_integration !== undefined && {
                owner_integration: row.owner_integration,
              }),
            },
          }),
        );
        customTypeCount += 1;
      }
      for (const schema of await storage.edgeTypes.list(spaceId)) {
        typeLines.push(JSON.stringify({ custom_edge_type: schema }));
        customEdgeTypeCount += 1;
      }

      // The same blob resolution the read routes use, which falls back to
      // the instance-wide bucket only after the space's own. Asking the
      // `""` bucket directly, where none of these hashes live, recorded
      // `blob_count: 0` while reporting success.
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
    space_id: spaceId,
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
  return withPreparedHeaders(
    c,
    new Response(webStream, {
      status: 200,
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="marfa-export-${date}.tar.gz"`,
      },
    }),
  );
}
