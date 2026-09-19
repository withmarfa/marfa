import { createGzip } from "node:zlib";
import { Readable, PassThrough } from "node:stream";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { resolveEnforcement } from "@withmarfa/shared";
import * as tar from "tar-stream";
import type { AppEnv } from "../middleware/auth.js";
import { assertTypeFilter } from "./_type-filter.js";
import { withPreparedHeaders } from "../prepared-headers.js";
import { requireAuth, getTypeFilter } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { normalizeTimeBound } from "../storage/interface.js";
import { readSpaceConfig } from "../storage/space-config.js";
import type { SourceFilterSettings } from "../storage/filter-sql.js";
import type { BlobBackend } from "../storage/blob-backend.js";
import { collectBlobHashes } from "../storage/blob-utils.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { ALL_STATES, resolveStateFilter } from "./_schemas.js";
import {
  refuseUnknownQueryParams,
  UNKNOWN_PARAM_NOTE,
} from "./_unknown-query-keys.js";

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
    "Streams the space's items with their metadata (tags and extensions) as `{item, metadata}` NDJSON lines, followed by the edges between exported items as `{edge}` lines (default) or, with `format=archive`, a `marfa-archive-v2.tar.gz` carrying `manifest.json`, `items.ndjson`, `edges.ndjson`, `types.ndjson` (the space's type and edge-type registrations, so a restore into an empty space can write the items that use them), and blob bytes that `POST /admin/restore-archive` can ingest. Space-scoped, exporting only what the caller can read; the response streams until the filter is exhausted. Only edges whose endpoints are both in the exported item set are included, so a filtered export never references items it does not carry. " +
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
      occurred_after: z
        .string()
        .optional()
        .describe(
          "Include only items whose own time — `occurred_at`, falling back to `created_at` — is strictly after this. Not the modification time.",
        ),
      occurred_before: z
        .string()
        .optional()
        .describe(
          "Include only items whose own time — `occurred_at`, falling back to `created_at` — is strictly before this.",
        ),
      format: z
        .string()
        .optional()
        .describe("Output format: `ndjson` (default) or `archive`"),
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

export function exportRoutes(storage: Storage, blobBackend: BlobBackend) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(exportRoute, async (c) => {
    requireAuth(c);

    // One check for both output formats: `format=archive` is handled by a
    // separate function further down but arrives through this handler and
    // shares this query schema, so refusing here covers both. An export
    // narrowed by a filter that was silently dropped writes the whole
    // space to a file the caller believes is a slice of it.
    refuseUnknownQueryParams(c.req.raw.url, exportRoute.request.query);

    const query = c.req.valid("query");

    // Audit the export attempt before streaming starts, stamped for both
    // the archive and NDJSON paths. An export is a bulk extraction of the
    // instance, so the record has to exist whether or not the stream that
    // follows completes.
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: c.get("apiKey")?.id,
      action: "export.space",
      resource_type: "space",
      resource_id: "me",
      details: {
        format: query.format ?? "ndjson",
        scope: "space",
      },
    });

    // An export is a list read, so the instance's read-narrowing lever
    // applies to it. Leaving it out would make the control bypassable by
    // swapping endpoint rather than by rewording the query.
    const spaceConfigForExport = await readSpaceConfig(storage.settings);
    const sourceFilter = resolveEnforcement(
      spaceConfigForExport,
      c.get("apiKey"),
    ).source_filter;

    if (query.format === "archive") {
      return handleArchiveExport(c, storage, blobBackend, sourceFilter);
    }

    // Pattern grammar, matching `GET /items` and `/search`: the parameter
    // means the type and everything under it on all three, so the explicit
    // `parent.*` spelling has to be accepted on all three too.
    const type = query.type;
    assertTypeFilter(type);

    // Same resolution as `GET /items`, sentinel included. Export shares the
    // storage filter with the listing, so a door that could not name every
    // state was a route-layer gap rather than a missing permission.
    const { state, all_states: allStates } = resolveStateFilter(query.state);

    // Read here rather than left to the store, because this door answers by
    // streaming: the 200 and its headers are flushed before the first page
    // is fetched, so a bound the store refuses arrives after the response
    // has begun and the caller is handed an empty body with a success
    // status. That is an export narrowed by a filter nobody could read,
    // written to a file the caller believes is a slice. The archive format
    // of this same door already refuses it, and the two disagreed.
    const occurredAfter = normalizeTimeBound(
      query.occurred_after,
      "occurred_after",
    );
    const occurredBefore = normalizeTimeBound(
      query.occurred_before,
      "occurred_before",
    );
    const source = query.source;

    const { allowed: allowedTypes, excluded: excludedTypes } = getTypeFilter(c);
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
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
                type,
                state,
                all_states: allStates,
                source,
                occurred_after: occurredAfter,
                occurred_before: occurredBefore,
                allowed_types: allowedTypes,
                excluded_types: excludedTypes,
                source_filter: sourceFilter,
                limit: 200,
                cursor,
              });

              for (const item of result.data) {
                const metadata = await storage.metadata.get(item.id);
                exportedIds.add(item.id);
                controller.enqueue(
                  encoder.encode(
                    JSON.stringify({
                      item,
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
          await work();
        } finally {
          controller.close();
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
  item_count: number;
  edge_count: number;
  blob_count: number;
  /** The type and edge-type registrations carried in `types.ndjson`. The
   *  type count is the instance's own registrations only — the export reads
   *  them through `listRegisteredWithProvenance`, which excludes the
   *  platform-seeded rows sharing the table. */
  type_count: number;
  edge_type_count: number;
  blobs: Record<string, { mime_type: string; size: number }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HonoContext = Context<any, any, any>;

async function handleArchiveExport(
  c: HonoContext,
  storage: Storage,
  blobBackend: BlobBackend,
  /** The instance's `source_filter` lever, resolved by the route handler. */
  sourceFilter: SourceFilterSettings | undefined,
): Promise<Response> {
  const type = c.req.query("type");
  assertTypeFilter(type);
  // The NDJSON path's twin, and it has to read the parameter the same way:
  // the two formats are one door with one query schema, so a sentinel
  // honored by one and stripped by the other would be worse than neither.
  const { state, all_states: allStates } = resolveStateFilter(
    c.req.query("state"),
  );
  const occurredAfter = c.req.query("occurred_after");
  const occurredBefore = c.req.query("occurred_before");
  const source = c.req.query("source");
  const { allowed: allowedTypes, excluded: excludedTypes } = getTypeFilter(c);

  const lines: string[] = [];
  const edgeLines: string[] = [];
  const typeLines: string[] = [];
  let typeCount = 0;
  let edgeTypeCount = 0;
  const blobHashes = new Set<string>();
  const blobMeta: Record<string, { mime_type: string; size: number }> = {};

  const collect = async () => {
    // Same both-endpoints rule as the NDJSON path: the archive carries
    // the relationships among the items it contains, nothing beyond.
    const exportedIds = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await storage.items.list({
        type,
        state,
        all_states: allStates,
        source,
        occurred_after: occurredAfter,
        occurred_before: occurredBefore,
        allowed_types: allowedTypes,
        excluded_types: excludedTypes,
        source_filter: sourceFilter,
        limit: 200,
        cursor,
      });
      for (const item of result.data) {
        const metadata = await storage.metadata.get(item.id);
        exportedIds.add(item.id);
        lines.push(
          JSON.stringify({
            item,
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
    // restore validates and normalizes `type` and compares the
    // result against the stored row to decide skip-or-conflict, so a
    // field added into the schema would read as a different registration
    // and turn every re-restore into a conflict.
    //
    // It is carried at all because `origin` stopped being descriptive:
    // it decides whether the consent screen offers a root read-only or
    // read-and-write. An archive that drops it makes the restore guess,
    // and the default it guessed was the permissive one.
    for (const row of await storage.types.listRegisteredWithProvenance()) {
      typeLines.push(
        JSON.stringify({
          type: row.schema,
          provenance: {
            origin: row.origin,
            ...(row.family !== undefined && { family: row.family }),
            ...(row.owner_integration !== undefined && {
              owner_integration: row.owner_integration,
            }),
          },
        }),
      );
      typeCount += 1;
    }
    for (const schema of await storage.edgeTypes.list()) {
      typeLines.push(JSON.stringify({ edge_type: schema }));
      edgeTypeCount += 1;
    }

    for (const hash of blobHashes) {
      const record = await storage.blobs.get(hash);
      if (record) {
        blobMeta[hash] = { mime_type: record.mime_type, size: record.size };
      }
    }
  };
  await collect();

  const manifest: ArchiveManifest = {
    version: 2,
    format: "marfa-archive-v2",
    created_at: new Date().toISOString(),
    item_count: lines.length,
    edge_count: edgeLines.length,
    blob_count: Object.keys(blobMeta).length,
    type_count: typeCount,
    edge_type_count: edgeTypeCount,
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

    // Emitted even when empty, so that a member missing from the tar is a
    // damaged archive rather than an empty one. The restore has no other
    // way to tell those apart.
    const edgesBuf = Buffer.from(
      edgeLines.length > 0 ? edgeLines.join("\n") + "\n" : "",
    );
    pack.entry({ name: "edges.ndjson", size: edgesBuf.length }, edgesBuf);

    // Always emitted, empty or not, for the same reason as edges.ndjson.
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
