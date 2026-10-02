import { createGzip } from "node:zlib";
import { Readable, PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { resolveEnforcement } from "@withmarfa/shared";
import * as tar from "tar-stream";
import type { AppEnv } from "../middleware/auth.js";
import { assertTypeFilter } from "./_type-filter.js";
import { edgeKindReadable } from "./_edge-visibility.js";
import { withCascadeMarks } from "./_cascade-marks.js";
import { withPreparedHeaders } from "../prepared-headers.js";
import { requireAuth, getTypeFilter } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { normalizeTimeBound } from "../storage/interface.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import type { SourceFilterSettings } from "../storage/filter-sql.js";
import type { BlobLayer } from "../storage/blob-layer.js";
import type { BlobRead } from "../storage/blob-store.js";
import { collectBlobHashes } from "../storage/blob-utils.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { ALL_STATES, resolveStateFilter } from "./_schemas.js";
import {
  refuseUnknownQueryParams,
  UNKNOWN_PARAM_NOTE,
} from "./_unknown-query-keys.js";
import { mayReadBlob } from "./_blob-reach.js";

/**
 * What an export answers when the caller names no state.
 *
 * Every listing door defaults to the active state, because a listing
 * answers what the reader is working with. This door answers a different
 * question: the archive it writes is what `POST /admin/restore-archive`
 * reads back, so a default that dropped archived rows would make a backup
 * and a restore lose the rows a person deliberately kept. The bin is the
 * one thing a copy leaves behind, and `state=any` takes even that.
 *
 * An exclusion rather than a list of the states to keep, so a state added
 * to the platform later is carried by a backup without anyone remembering
 * to add it here.
 */
export const EXPORT_EXCLUDED_STATES = ["trashed"] as const;

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const exportRoute = createRoute({
  operationId: "exportData",
  method: "get",
  path: "/",
  tags: ["Export"],
  summary: "Export data",
  description:
    "Streams the instance's items with their metadata (tags and extensions) as `{item, metadata}` NDJSON lines, followed by the edges between exported items as `{edge}` lines (default) or, with `format=archive`, a `marfa-archive-v0.tar.gz` carrying `manifest.json`, `items.ndjson`, `edges.ndjson`, `types.ndjson` (the type and edge-type registrations, so a restore into an empty database can write the items that use them), and the bytes of each blob the selection references that `GET /blobs/{hash}` would serve the caller, which `POST /admin/restore-archive` can ingest. Exports only what the caller can read; the response streams until the filter is exhausted. Only edges whose endpoints are both in the exported item set are included, so a filtered export never references items it does not carry, and only edges of a type the credential may read, so an export never carries a kind of relationship the edge doors would refuse. " +
    UNKNOWN_PARAM_NOTE,
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      type: z
        .string()
        .optional()
        .describe(
          "Filter to a single type identifier, subtypes included. A concrete identifier this instance does not know is refused with 400 `unknown_type`.",
        ),
      state: z
        .string()
        .optional()
        .describe(
          `Filter by item state. Omitting the parameter exports every state except trashed: an export is a copy of the corpus rather than a listing, and the archive it writes is what a restore reads back, so it does not take the listing grammar's active-state default. \`${ALL_STATES}\` adds the bin, in one pass.`,
        ),
      source: z
        .string()
        .optional()
        .describe("Narrow to rows stamped with this `source`."),
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
      // Enforced, not merely documented, for the reason
      // `refuseUnknownQueryParams` is given below: a caller who asked for
      // an archive and was handed a stream, or asked for anything and was
      // handed the default, believes the file is something it is not.
      format: z
        .enum(["ndjson", "archive"])
        .optional()
        .describe("Output format: `ndjson` (default) or `archive`"),
    }),
  },
  responses: {
    200: {
      content: {
        "application/x-ndjson": {
          schema: z.string(),
        },
        "application/gzip": {
          // `format=archive`: a gzipped tarball, bytes as 3.1 spells them.
          schema: { type: "string" as const, format: "binary" as const },
        },
      },
      description:
        "`format=ndjson`: items with their metadata, one JSON object per line, streamed. `format=archive`: the `marfa-archive-v0.tar.gz` that `POST /admin/restore-archive` reads.",
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
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["type_not_permitted"]),
        },
      },
      description:
        "The credential's type permissions reach no type, so there is nothing on the data plane it may read. A credential that reaches some types reads this door narrowed to them rather than being refused.",
    },
  },
});

/** How many export lines are read between turns of the event loop. */
const LINES_PER_TURN = 16;

/** Hand the event loop one turn: `setImmediate` runs after pending I/O,
 *  where a resolved promise, being a microtask, would run ahead of it. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function exportRoutes(
  storage: Storage,
  blobs: BlobLayer,
  instanceId: string,
) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(exportRoute, async (c) => {
    const callerKey = requireAuth(c);

    // One check for both output formats: `format=archive` is handled by a
    // separate function further down but arrives through this handler and
    // shares this query schema, so refusing here covers both. An export
    // narrowed by a filter that was silently dropped writes everything to
    // a file the caller believes is a slice of it.
    refuseUnknownQueryParams(c.req.raw.url, exportRoute.request.query);

    const query = c.req.valid("query");

    // Audit the export attempt before streaming starts, stamped for both
    // the archive and NDJSON paths. An export is a bulk extraction of the
    // instance, so the record has to exist whether or not the stream that
    // follows completes.
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: c.get("apiKey")?.id,
      action: "export.run",
      resource_type: "export",
      details: {
        format: query.format ?? "ndjson",
      },
    });

    // An export is a list read, so the instance's read-narrowing lever
    // applies to it. Leaving it out would make the control bypassable by
    // swapping endpoint rather than by rewording the query.
    const instanceConfigForExport = await readInstanceConfig(storage.settings);
    const sourceFilter = resolveEnforcement(
      instanceConfigForExport,
      c.get("apiKey"),
    ).source_filter;

    if (query.format === "archive") {
      return handleArchiveExport(c, storage, blobs, sourceFilter, instanceId);
    }

    // Pattern grammar, matching `GET /items` and `/search`: the parameter
    // means the type and everything under it on all three, so the explicit
    // `parent.*` spelling has to be accepted on all three too.
    const type = query.type;
    assertTypeFilter(type);

    // Same resolution as `GET /items`, sentinel included: `any` means the
    // same thing on every door that reads items. What this door does not
    // share is the default, which `EXPORT_EXCLUDED_STATES` states.
    const { state, all_states: allStates } = resolveStateFilter(query.state);

    // Read here rather than left to the store, because this door answers by
    // streaming: the 200 and its headers are flushed before the first page
    // is fetched, so a bound the store refuses arrives after the response
    // has begun and the caller is handed an empty body with a success
    // status. That is an export narrowed by a filter nobody could read,
    // written to a file the caller believes is a slice. The archive format
    // of this same door refuses it too, and the two have to agree.
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

    async function* records(): AsyncGenerator<string> {
      // Ids of every item this export emits. Edges are filtered against it
      // below: an export carries the relationships among the items it
      // contains, so a filtered export never references an item the output
      // does not hold.
      const exportedIds = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = await storage.items.list({
          type,
          state,
          all_states: allStates,
          exclude_states: EXPORT_EXCLUDED_STATES,
          source,
          occurred_after: occurredAfter,
          occurred_before: occurredBefore,
          allowed_types: allowedTypes,
          excluded_types: excludedTypes,
          source_filter: sourceFilter,
          limit: 200,
          cursor,
        });

        for (const item of await withCascadeMarks(
          storage,
          callerKey,
          result.data,
        )) {
          const metadata = await storage.metadata.get(item.id);
          exportedIds.add(item.id);
          yield JSON.stringify({ item, metadata }) + "\n";
        }

        cursor = result.next_cursor ?? undefined;
      } while (cursor);

      let edgeCursor: string | undefined;
      do {
        // Edges are read across the whole instance and most pages may
        // carry nothing for this export, so a page that yields no line
        // must still give the event loop its turn.
        await yieldToEventLoop();
        const page = await storage.edges.list({
          limit: 200,
          cursor: edgeCursor,
        });
        for (const edge of page.data) {
          // Both halves of the edge read gate, answered differently
          // because this door has already answered one of them.
          // `exportedIds` is the set of items this credential may read,
          // so requiring both endpoints in it settles the source half
          // more strictly than the gate asks. The edge type is the other
          // half: the credential's edge map decides which kinds of
          // relationship among those items it may read, as it does on
          // `GET /edges`.
          if (
            exportedIds.has(edge.source_id) &&
            exportedIds.has(edge.target_id) &&
            edgeKindReadable(callerKey, edge)
          ) {
            yield JSON.stringify({ edge }) + "\n";
          }
        }
        edgeCursor = page.next_cursor ?? undefined;
      } while (edgeCursor);
    }

    const lines = records();
    // Each pull waits a turn of the event loop. The store answers without
    // waiting on I/O, so an export read in one go runs entirely in
    // microtasks, and the response's headers and first bytes, which reach
    // the socket in a later phase, would wait for the last line. Later
    // pulls take a few lines rather than one, since a turn per line costs a
    // large export a good share of its throughput; the first takes one, so
    // the client sees the export begin as soon as it can. Pulling also
    // holds the read to what the client has taken, so a large export is
    // never held in memory whole.
    let linesThisTurn = 1;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await yieldToEventLoop();
        const limit = linesThisTurn;
        linesThisTurn = LINES_PER_TURN;
        for (let taken = 0; taken < limit; taken++) {
          const next = await lines.next();
          if (next.done) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(next.value));
          if ((controller.desiredSize ?? 0) <= 0) return;
        }
      },
      async cancel() {
        await lines.return(undefined);
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
   * The instance that produced the archive.
   *
   * Provenance, and nothing acts on it: `POST /admin/restore-archive` does
   * not read it, because restoring an instance's own archive into itself and
   * restoring another's are both supported and neither is an error to
   * detect. What it answers is the question a directory of `.tar.gz` files
   * cannot — which deployment this one came off — and `created_at` alone
   * cannot answer it for an operator running two.
   */
  instance_id: string;
  item_count: number;
  edge_count: number;
  blob_count: number;
  /** The type and edge-type registrations carried in `types.ndjson`. The
   *  type count is the instance's own registrations only — the export reads
   *  them through `listRegisteredWithProvenance`, which excludes the
   *  platform-seeded rows sharing the table. */
  type_count: number;
  edge_type_count: number;
  blobs: Record<string, { mime_type: string; size_bytes: number }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HonoContext = Context<any, any, any>;

/** The bytes from the first attached store that holds them. */
async function readFromAnyStore(
  blobs: BlobLayer,
  hash: string,
): Promise<BlobRead | null> {
  for (const store of blobs.stores) {
    const read = await store.get(hash);
    if (read) return read;
  }
  return null;
}

async function handleArchiveExport(
  c: HonoContext,
  storage: Storage,
  blobs: BlobLayer,
  /** The instance's `source_filter` lever, resolved by the route handler. */
  sourceFilter: SourceFilterSettings | undefined,
  /** The instance writing the archive, for the manifest. */
  instanceId: string,
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
  const callerKey = requireAuth(c);

  const lines: string[] = [];
  const edgeLines: string[] = [];
  const typeLines: string[] = [];
  let typeCount = 0;
  let edgeTypeCount = 0;
  const blobHashes = new Set<string>();
  const blobMeta: Record<string, { mime_type: string; size_bytes: number }> =
    {};

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
        exclude_states: EXPORT_EXCLUDED_STATES,
        source,
        occurred_after: occurredAfter,
        occurred_before: occurredBefore,
        allowed_types: allowedTypes,
        excluded_types: excludedTypes,
        source_filter: sourceFilter,
        limit: 200,
        cursor,
      });
      for (const item of await withCascadeMarks(
        storage,
        callerKey,
        result.data,
      )) {
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
      cursor = result.next_cursor ?? undefined;
    } while (cursor);

    let edgeCursor: string | undefined;
    do {
      const page = await storage.edges.list({
        limit: 200,
        cursor: edgeCursor,
      });
      for (const edge of page.data) {
        // The NDJSON path's twin, and the same two halves: the endpoint
        // rule settles the source, and the edge map has to be asked for
        // the kind of relationship.
        if (
          exportedIds.has(edge.source_id) &&
          exportedIds.has(edge.target_id) &&
          edgeKindReadable(callerKey, edge)
        ) {
          edgeLines.push(JSON.stringify({ edge }));
          collectBlobHashes(edge.properties, blobHashes);
        }
      }
      edgeCursor = page.next_cursor ?? undefined;
    } while (edgeCursor);

    // The instance's own registrations, not the filtered item set's: a
    // restore has to be able to write every item the archive carries,
    // and an unfiltered archive is the case that matters. Carrying a
    // type the archive happens not to use costs one line.
    // Provenance rides beside the schema rather than inside it. The
    // restore validates and normalizes `type` and compares the
    // result against the stored row to decide skip-or-conflict, so a
    // field added into the schema would read as a different registration
    // and turn every re-restore into a conflict.
    //
    // It is carried at all because `origin` is not descriptive: it decides
    // whether the consent screen offers a root read-only or
    // read-and-write. An archive without it restores as `unknown`,
    // read-only, so a `user` registration would come back without the
    // wildcard it earned.
    for (const row of await storage.types.listRegisteredWithProvenance()) {
      typeLines.push(
        JSON.stringify({
          type: row.schema,
          provenance: { origin: row.origin },
        }),
      );
      typeCount += 1;
    }
    for (const schema of await storage.edgeTypes.list()) {
      typeLines.push(JSON.stringify({ edge_type: schema }));
      edgeTypeCount += 1;
    }

    // An archive carries only bytes the blob doors would serve this
    // credential: naming a digest in a row it may read lends nothing the
    // door would not, wherever in the row the digest sits.
    for (const hash of blobHashes) {
      if (!(await mayReadBlob(callerKey, storage, hash))) continue;
      const record = await storage.blobs.get(hash);
      if (record) {
        blobMeta[hash] = {
          mime_type: record.mime_type,
          size_bytes: record.size_bytes,
        };
      }
    }
  };
  await collect();

  const manifest: ArchiveManifest = {
    version: 0,
    format: "marfa-archive-v0",
    created_at: new Date().toISOString(),
    instance_id: instanceId,
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
      const read = await readFromAnyStore(blobs, hash);
      if (!read) continue;
      const entry = pack.entry({ name: `blobs/${hash}`, size: read.length });
      await pipeline(read.stream, entry);
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
