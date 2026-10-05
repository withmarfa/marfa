import { createRoute, z } from "@hono/zod-openapi";
import { resolveEnforcement } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { assertTypeFilter } from "./_type-filter.js";
import { edgeKindReadable } from "./_edge-visibility.js";
import { withCascadeMarks } from "./_cascade-marks.js";
import { withPreparedHeaders } from "../prepared-headers.js";
import {
  requireAuth,
  getTypeFilter,
  readsSomeType,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { normalizeTimeBound } from "../storage/interface.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import type { BlobLayer } from "../storage/blob-layer.js";
import { yieldBulkWork } from "../bulk-actions/yield.js";
import { handleArchiveExport } from "./export-archive.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { ALL_STATES, resolveStateFilter } from "./_schemas.js";
import { readableMetadata } from "./_extension-reach.js";

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
  tags: ["Export and restore"],
  summary: "Export items and edges",
  description:
    "Streams the instance's items with their metadata (tags and extensions) as `{item, metadata}` NDJSON lines, followed by the edges between exported items as `{edge}` lines (default) or, with `format=archive`, a `marfa-archive-v0.tar.gz` carrying `manifest.json`, `items.ndjson`, `edges.ndjson`, `types.ndjson` (the type and edge-type registrations, so a restore into an empty database can write the items that use them), and the bytes of each blob the selection or its readable history references that `GET /blobs/{hash}` would serve the caller, which `POST /admin/restore-archive` can ingest. Each archive item line carries `versions`, every stored earlier snapshot the caller may read under its historical type, strictly below the selected current row's version, `lending_blobs`, the digests in that row's properties that lend its reach, and `lending_extensions`, the digests that lend its reach in each extension namespace the line carries. Each archive edge line carries `lending_blobs`, the digests in that edge's properties that lend its reach. A restore lends through those alone. Exports only what the caller can read; the response streams until the filter is exhausted. Only edges whose endpoints are both in the exported item set are included, so a filtered export never references items it does not carry, and only edges of a type the credential may read.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    query: z.object({
      type: z
        .string()
        .optional()
        .describe(
          "Filter to one type, subtypes included. Refused `400 unknown_type` if nothing registers it, and `403 type_not_permitted` if the credential cannot read it or any type under it. A wildcard answers the readable types it matches.",
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
          "Include only items whose own time (`occurred_at`, falling back to `created_at`) is strictly after this. Not the modification time.",
        ),
      occurred_before: z
        .string()
        .optional()
        .describe(
          "Include only items whose own time (`occurred_at`, falling back to `created_at`) is strictly before this.",
        ),
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
        "`format=ndjson`: items with their metadata, one JSON object per line, streamed. `format=archive`: the `marfa-archive-v0.tar.gz` that `POST /admin/restore-archive` reads. If Marfa fails after it starts sending an archive, it ends the connection early, so what you received is not a complete archive and does not unpack.",
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
        "The credential reaches no type, or `type` names a registered type it cannot read and none under it. Otherwise the door is narrowed to the types it reads.",
    },
  },
});

/** How many export lines are read between turns of the event loop. */
const LINES_PER_TURN = 16;

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

    const query = c.req.valid("query");

    // Audit the export attempt before streaming starts, stamped for both
    // the archive and NDJSON paths. An export is a bulk extraction of the
    // instance, so the record has to exist whether or not the stream that
    // follows completes.
    await storage.audit.log({
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

    // Pattern grammar, matching `GET /items` and `/search`: the parameter
    // means the type and everything under it on all three, so the explicit
    // `parent.*` spelling has to be accepted on all three too.
    const type = query.type;
    assertTypeFilter(c, type);

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

    // Both formats are one door with one query schema, so the archive reads
    // the filter the NDJSON path has just validated rather than the raw
    // query.
    if (query.format === "archive") {
      return handleArchiveExport(c, storage, blobs, instanceId, {
        type,
        state,
        all_states: allStates,
        source,
        exclude_states: EXPORT_EXCLUDED_STATES,
        occurred_after: occurredAfter,
        occurred_before: occurredBefore,
        allowed_types: allowedTypes,
        excluded_types: excludedTypes,
        source_filter: sourceFilter,
      });
    }

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
          const metadata = readableMetadata(
            await storage.metadata.get(item.id),
            callerKey,
          );
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
        await yieldBulkWork();
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
        await yieldBulkWork();
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
