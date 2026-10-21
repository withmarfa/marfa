import { DiskReserve } from "../storage/disk-space.js";
import { createRoute, z } from "@hono/zod-openapi";
import { resolveEnforcement } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { assertTypeFilter } from "./_type-filter.js";
import { withPreparedHeaders } from "../prepared-headers.js";
import { authorityId } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { normalizeTimeBound } from "../storage/interface.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import type { BlobLayer } from "../storage/blob-layer.js";
import { yieldBulkWork } from "../bulk-actions/yield.js";
import { loggablePath } from "../inbound/address.js";
import { streamFailure } from "../process-faults.js";
import { log } from "../middleware/logger.js";
import { faultsArmed, holdAt } from "../control/faults.js";
import { withStatementFault } from "../storage/sqlite/injected-failure.js";
import { handleArchiveExport } from "./export-archive.js";
import { readableExportEdges } from "./export-read.js";
import {
  ExportCredentialEnded,
  holdExportAuthority,
} from "./export-authority.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { ALL_STATES, resolveStateFilter } from "./_schemas.js";
import {
  ownerItemRead,
  ownerItemReadSecurity,
  readsOwnerItems,
} from "./_owner-item-read.js";

/**
 * What an export answers when the caller names no state.
 *
 * Every listing door defaults to the active state, because a listing
 * answers what the reader is working with. This door answers a different
 * question: the archive it writes is what `POST /restore`
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
    "Exports readable items, metadata and edges, excluding trash unless requested. The owner can use their browser session. An archive can be read by `POST /restore`.",
  security: ownerItemReadSecurity,
  middleware: readsOwnerItems,
  request: {
    query: z.object({
      type: z
        .string()
        .optional()
        .describe(
          "Only export items of this type or a subtype. A wildcard such as `core.*` matches every type under that prefix.",
        ),
      state: z
        .string()
        .optional()
        .describe(
          `Only export items in this lifecycle state. Without it, you get every state but \`trashed\`. Send \`${ALL_STATES}\` to include trashed items too.`,
        ),
      source: z
        .string()
        .optional()
        .describe("Only export items stamped with this source."),
      occurred_after: z
        .string()
        .optional()
        .describe(
          "Only export items whose own time (`occurred_at`, else `created_at`) is after this time.",
        ),
      occurred_before: z
        .string()
        .optional()
        .describe(
          "Only export items whose own time (`occurred_at`, else `created_at`) is before this time.",
        ),
      format: z
        .enum(["ndjson", "archive"])
        .optional()
        .describe(
          "`ndjson` for lines of JSON, or `archive` for a `.tar.gz` file that `POST /restore` reads. Defaults to `ndjson`. An archive's `manifest.json` lists under `missing_blobs` each blob it doesn't hold, including a file's blob your credential can't read.",
        ),
      files: z
        .enum(["true", "false"])
        .optional()
        .describe(
          "With `format=archive`, `false` leaves out the bytes of files, which the manifest then names in `missing_blobs`. Defaults to `true`. `format=ndjson` carries no file bytes either way.",
        ),
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
        "With `format=ndjson`, one JSON object per line: `item` and `metadata` for each item, then `edge` for each edge between them whose type you can read. With `format=archive`, a `.tar.gz` of the items, history, edges, type registrations and blobs you can read. If the export fails partway or your credential ends or narrows below it, the connection ends early and an archive won't unpack.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error", "unknown_type"]),
        },
      },
      description:
        "- `validation_error`: a query parameter is unknown or invalid, such as a `format` other than `ndjson` or `archive`, a `state` that isn't a lifecycle state or `any`, or a time that isn't a timestamp.\n- `unknown_type`: `type` is a concrete type that nothing registers.",
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
        "- `type_not_permitted`: your credential reaches no type, or `type` names a type you can't read with none readable under it.",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["export_rows_unrestorable"]),
        },
      },
      description:
        "- `export_rows_unrestorable`: with `format=archive`, Marfa read the selection twice, and both times a restore would refuse or skip the same row, which was unchanged between the reads, so no archive was sent. `details.row` names the row by `kind`, `id`, `type` and `field`, with the `code` a restore refuses it with or the reason it skips it. Correct the row or its type, then export again.",
    },
    503: {
      description:
        "- `blob_store_unavailable`: a blob store failed, or didn't answer in time, while Marfa checked a blob's copy. Try again later.\n- `write_contention`: the database was busy. Nothing changed. Try the request again.\n- `export_unrestorable`: with `format=archive`, writes changed a row that a restore would refuse, or its type, between two reads. No archive was sent. Retry the export.",
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "blob_store_unavailable",
            "write_contention",
            "export_unrestorable",
          ]),
        },
      },
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
  diskReserveBytes: number,
  /** The largest properties a write door takes, `bulkBodyCap(config)`. */
  maxRowBytes: number,
) {
  const router = createOpenAPIRouter<AppEnv>();
  const reserve = new DiskReserve(blobs.disk.spoolDir, diskReserveBytes);

  router.openapi(exportRoute, async (c) => {
    const reader = ownerItemRead(c);
    const authority = holdExportAuthority(c, storage);

    const query = c.req.valid("query");

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
    assertTypeFilter(c, type, reader.owner ? reader.reads : undefined);

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

    const { allowed: allowedTypes, excluded: excludedTypes } = reader.types;

    // Audited once the request is accepted and before streaming starts, for
    // both formats: an export is a bulk extraction of the instance, so the
    // record has to exist whether or not the stream that follows completes.
    await storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: authorityId(c),
      action: "export.run",
      resource_type: "export",
      details: {
        format: query.format ?? "ndjson",
      },
    });

    // Both formats are one door with one query schema, so the archive reads
    // the filter the NDJSON path has just validated rather than the raw
    // query.
    if (query.format === "archive") {
      return handleArchiveExport(
        c,
        storage,
        blobs,
        instanceId,
        {
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
        },
        reader,
        authority,
        reserve,
        maxRowBytes,
        query.files !== "false",
      );
    }

    const encoder = new TextEncoder();

    /** Lines read together, with the check that holds before they are sent. */
    interface Batch {
      lines: string[];
      holds: () => Promise<void>;
    }

    async function* records(): AsyncGenerator<Batch> {
      // Ids of every item this export emits. Edges are filtered against it
      // below: an export carries the relationships among the items it
      // contains, so a filtered export never references an item the output
      // does not hold.
      const exportedIds = new Set<string>();
      let cursor: string | undefined;
      let pageLimit = 1;
      do {
        const result = await storage.runInReadSnapshot(
          async () => {
            const page = await withStatementFault("export-read", () =>
              storage.items.list({
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
                limit: pageLimit,
                cursor,
              }),
            );
            if (faultsArmed()) await holdAt("read-hydration");
            const data = [];
            for (const item of await reader.cascade(storage, page.data)) {
              const metadata = reader.metadata(
                await storage.metadata.get(item.id),
              );
              data.push({
                id: item.id,
                item,
                metadata,
                line: JSON.stringify({ item, metadata }) + "\n",
              });
            }
            return { data, next_cursor: page.next_cursor };
          },
          { signal: c.req.raw.signal },
        );
        pageLimit = LINES_PER_TURN;

        for (const record of result.data) exportedIds.add(record.id);
        yield {
          lines: result.data.map((record) => record.line),
          holds: () => authority.rows(result.data),
        };

        cursor = result.next_cursor ?? undefined;
      } while (cursor);

      let edgeCursor: string | undefined;
      do {
        // Edges are read across the whole instance and most pages may
        // carry nothing for this export, so a page that yields no line
        // must still give the event loop its turn.
        await yieldBulkWork();
        const page = await storage.runInReadSnapshot(
          async () => {
            const result = await storage.edges.list({
              limit: 200,
              cursor: edgeCursor,
              source_filter: sourceFilter,
            });
            return {
              ...result,
              data: await readableExportEdges(storage, reader, result.data),
            };
          },
          { signal: c.req.raw.signal },
        );
        // Membership keeps the exported graph closed; the page snapshot
        // separately checks its source's current readability.
        const edges = page.data.filter(
          (edge) =>
            exportedIds.has(edge.source_id) && exportedIds.has(edge.target_id),
        );
        yield {
          lines: edges.map((edge) => JSON.stringify({ edge }) + "\n"),
          holds: () => authority.edges(edges),
        };
        edgeCursor = page.next_cursor ?? undefined;
      } while (edgeCursor);
    }

    const batches = records();
    // Each pull waits a turn of the event loop. The store answers without
    // waiting on I/O, so an export read in one go runs entirely in
    // microtasks, and the response's headers and first bytes, which reach
    // the socket in a later phase, would wait for the last line. Later
    // pulls take a page of lines rather than one, since a turn per line
    // costs a large export a good share of its throughput; the first takes
    // one, so the client sees the export begin as soon as it can. Pulling
    // also holds the read to what the client has taken, so a large export
    // is never held in memory whole. A page is sent only after the
    // credential has been asked again, and with no wait between that answer
    // and the page being queued.
    // A client that leaves cancels the stream while a pull is still reading,
    // and that pull's enqueue then throws. Leaving is not a fault.
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          await yieldBulkWork();
          for (;;) {
            const next = await batches.next();
            if (next.done) {
              controller.close();
              return;
            }
            // A page the export read but does not carry sends nothing, and
            // a pull that sends nothing is not asked again.
            if (next.value.lines.length === 0) continue;
            await next.value.holds();
            for (const line of next.value.lines)
              controller.enqueue(encoder.encode(line));
            return;
          }
        } catch (err) {
          if (cancelled) return;
          if (err instanceof ExportCredentialEnded) {
            const { reason } = err;
            log("info", "Export ended with its credential", {
              request_id: c.get("requestId"),
              reason,
            });
            controller.error(new ExportCredentialEnded(reason));
            return;
          }
          controller.error(
            streamFailure("Export stream failed", err, {
              request_id: c.get("requestId"),
              path: loggablePath(c.req.path),
            }),
          );
        }
      },
      async cancel() {
        cancelled = true;
        await batches.return(undefined);
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
