/**
 * POST /admin/restore-archive: operator key only, tar.gz body.
 *
 * Dedicated archive-import endpoint. Content-type is
 * `application/gzip` (not JSON); response is `{imported, duplicates,
 * edges_imported, edges_skipped, blobs_imported}` and the registration
 * counts. Enforces the manifest version 0 contract and blob-hash
 * verification, reads the archive in memory that does not grow with it,
 * checks every row before writing any, and writes in a single transaction
 * covering type and edge-type registrations, blob rows, items, metadata,
 * history, edges and their events.
 *
 * Item ids are preserved from the archive so restored edges resolve;
 * an id or natural-key collision counts as a duplicate and leaves the
 * existing row untouched. Tags and extensions restore alongside their
 * items. Edges restore in a second pass, only where both endpoints
 * resolve in the target database. A row comes back at the version
 * it was archived at, with its original dates and readable item history.
 *
 * Paired with GET /export?format=archive.
 */

import { createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createRoute, z } from "@hono/zod-openapi";
import {
  MarfaError,
  ErrorCode,
  isTier,
  TIERS,
  resolveEnforcement,
  validateTransition,
  SYSTEM_DEFAULT_STATE,
} from "@withmarfa/shared";
import { publish, publishEdge } from "../pubsub.js";
import type { Edge, Item, Metadata } from "@withmarfa/shared";
import type { ItemState, Tier } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  isReservedCredentialSource,
  operatorOnly,
  requireAuth,
} from "../middleware/auth.js";
import { finalizeArchiveItem, writeItem } from "../storage/item-write.js";
import { finishCopyDeletion } from "../housekeeping/blob-delete.js";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
import type { AuditLogEntry, Storage } from "../storage/interface.js";
import type { BlobLayer } from "../storage/blob-layer.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { planArchiveTypes, writeArchiveTypes } from "./admin-archive-types.js";
import type {
  ArchiveTypeEntry,
  ArchiveTypePlan,
} from "./admin-archive-types.js";
import { undeclaredPropertyRefusal } from "./_undeclared-property.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import { assertEdgesCanBeCreated } from "../storage/edge-constraints.js";
import { holdBlobUploadLocks } from "../storage/blob-upload-lock.js";
import { log } from "../middleware/logger.js";
import { blobPrincipal } from "./_blob-reach.js";
import { sourceTypesFor } from "./_edge-visibility.js";
import { archiveDates, archiveVersions } from "./admin-archive-history.js";
import { archiveLines, readArchive } from "./admin-archive-read.js";
import type { PendingBlob, ReadArchive } from "./admin-archive-read.js";
import { yieldBulkWork } from "../bulk-actions/yield.js";

function archiveScalarRefusal(
  kind: "item" | "edge",
  row: Record<string, unknown>,
  index: number,
): MarfaError | null {
  let field: "version" | "tier";
  let expected: string;
  if (
    Object.hasOwn(row, "version") &&
    !(
      typeof row.version === "number" &&
      Number.isSafeInteger(row.version) &&
      row.version > 0
    )
  ) {
    field = "version";
    expected = "a positive safe integer";
  } else if (
    kind === "item" &&
    Object.hasOwn(row, "tier") &&
    !isTier(row.tier)
  ) {
    field = "tier";
    expected = `one of ${TIERS.join(", ")}`;
  } else {
    return null;
  }
  return new MarfaError(
    ErrorCode.VALIDATION_ERROR,
    `Invalid ${kind} ${String(row.id)} in ${kind}s.ndjson parsed row ${String(index + 1)}: ${field} must be ${expected}`,
    {
      [kind === "item" ? "item_id" : "edge_id"]: row.id,
      row: index + 1,
      field,
    },
  );
}

/** Tags off an archived `{item, metadata}` line, defensively parsed. */
function archiveTags(meta: unknown): string[] | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const tags = (meta as Record<string, unknown>).tags;
  if (!Array.isArray(tags)) return undefined;
  const strings = tags.filter((t): t is string => typeof t === "string");
  return strings.length > 0 ? strings : undefined;
}

/** Extensions off an archived `{item, metadata}` line, defensively parsed. */
function archiveExtensions(
  meta: unknown,
): Record<string, Record<string, unknown>> {
  if (typeof meta !== "object" || meta === null) return {};
  const extensions = (meta as Record<string, unknown>).extensions;
  if (typeof extensions !== "object" || extensions === null) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [namespace, data] of Object.entries(extensions)) {
    // An empty namespace is meaningless on every read path and forgeable only
    // here: nothing else in the platform creates one, because every write door
    // takes it from a route pattern that will not match an empty segment. It
    // is dropped rather than restored because a credential holding no implicit
    // namespace is represented by the empty string, so an item carrying one
    // would be readable by exactly the credentials that hold nothing — see
    // `auth/extension-label.ts`.
    if (namespace === "") continue;
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      out[namespace] = data as Record<string, unknown>;
    }
  }
  return out;
}

const restoreArchiveRoute = createRoute({
  operationId: "adminRestoreArchive",
  method: "post",
  path: "/restore-archive",
  tags: ["Export"],
  summary: "Restore types, items, edges, metadata, and blobs from an archive",
  description:
    "Ingests a `marfa-archive-v0.tar.gz` produced by `GET /export?format=archive`. Every row is checked before anything is written, and everything the restore writes commits together: type and edge-type registrations first, so a restore into an empty instance can write the items that use them, then blob rows, items, edges and their events, so a restore that is refused, fails or is interrupted leaves none of them. A registration the instance already holds identically is skipped, and one it holds differently fails the whole restore with `409` naming every clashing id. Item ids are preserved so restored edges resolve; an id or natural-key collision, or a link another item of the row's type holds, counts as a duplicate and leaves the existing row untouched. Tags and extensions restore with their items; edges restore in a second pass, skipped (and counted) when either endpoint does not resolve. A row comes back at the version it was archived at, for items and edges alike, so a client holding a version across a restore cannot have its precondition pass against content it never read. Original item and edge dates and every archived item snapshot are preserved. Historical properties are not checked against current type schemas. Invalid dates or history refuse before row writes; a snapshot ID collision refuses the row transaction with `409 conflict`. Duplicate items retain their live metadata, dates and history. There is no separate item or edge count limit. Entries under names the restore does not read are skipped without being held in memory. While a restore writes, other writes wait for it and answer `503 write_contention` past their budget. Keys, webhooks, configuration and tombstones are not restored. Trashed items are restored only when explicitly included in the export. Until the first public release, archives are supported only by the build that wrote them; format 0 promises no compatibility between builds.",
  security: [{ bearerAuth: [] }],
  middleware: operatorOnly,
  request: {
    body: {
      required: true,
      content: {
        "application/gzip": {
          // The archive is a gzipped tarball: bytes, as 3.1 spells them.
          schema: { type: "string" as const, format: "binary" as const },
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            imported: z.number(),
            duplicates: z.number(),
            edges_imported: z.number(),
            edges_skipped: z.number(),
            /** Why edges were skipped, keyed by reason. A silent skip and a
             *  refused one are different signals, and a bare count cannot
             *  tell an operator which they got. */
            edges_skipped_reasons: z.record(z.string(), z.number()),
            blobs_imported: z.number(),
            types_registered: z.number(),
            types_skipped: z.number(),
            edge_types_registered: z.number(),
            edge_types_skipped: z.number(),
          }),
        },
      },
      description: "Restore result",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "invalid_properties",
            "validation_error",
          ]),
        },
      },
      description:
        "- `validation_error`: the archive is invalid or at an unsupported version, carries an entry it reads more than once, or carries a `manifest.json`, `types.ndjson` or line of `items.ndjson` or `edges.ndjson` larger than 64 MiB.\n- `invalid_properties`: a row carries a property its type does not declare, and the strict-mode lever names that type.\n\nThe restore writes nothing.",
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
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Admin required",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["conflict", "link_taken"]),
        },
      },
      description:
        "- `conflict`: the archive redefines a type this instance registers differently or registered while the restore ran, carries a core edge type, or carries a snapshot ID that already exists.\n- `link_taken`: the archive registers a type naming a `link_field` in which two rows a forced delete left share a value.\n\nThe restore writes nothing.",
    },
  },
});

/**
 * Rows written between two turns of the event loop. A restore holds the
 * write lock from its first registration to its commit, and each batch is a
 * stretch in which nothing else in the process answers.
 */
const RESTORE_BATCH = 100;

/** An `items.ndjson` line, which the restore reads defensively. */
interface ArchivedItemLine {
  item: Record<string, unknown>;
  metadata?: unknown;
  lending_blobs?: unknown;
  versions?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Lines that do not parse are skipped: the exporter always emits valid
 *  JSON, so a bad line means the archive was edited by hand. */
async function* itemLines(
  path: string | undefined,
): AsyncGenerator<ArchivedItemLine> {
  for await (const line of archiveLines(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(parsed) && isRecord(parsed.item)) {
      yield parsed as unknown as ArchivedItemLine;
    }
  }
}

/** The `edge` of each `edges.ndjson` line, on the same terms as items. */
async function* edgeLines(
  path: string | undefined,
): AsyncGenerator<Record<string, unknown>> {
  for await (const line of archiveLines(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(parsed) && parsed.edge) {
      yield parsed.edge as Record<string, unknown>;
    }
  }
}

/**
 * The refusals that need nothing from the database, asked of one item line.
 *
 * Asked of every line before anything is written, so a refusal is never
 * half a restore and never leaves blob bytes to take back.
 */
function itemRefusal(
  entry: ArchivedItemLine,
  index: number,
  seenSnapshotIds: Set<string>,
): MarfaError | null {
  const { item } = entry;
  archiveDates("item", item, index);
  archiveVersions(item, entry.versions, index, seenSnapshotIds);
  const scalar = archiveScalarRefusal("item", item, index);
  if (scalar) return scalar;

  // A row whose `source` claims a reserved credential shape is refused, on
  // the same terms and for the same reason as the state check below: the
  // restore is the one door that copies `source` verbatim, and `POST /keys`
  // refuses that prefix precisely so no credential can stamp one. A row
  // carrying `oauth:` would otherwise read, ever after, as written by a
  // grant that never existed, planted through the one door that does not
  // ask.
  const source = item.source;
  if (typeof source === "string" && isReservedCredentialSource(source)) {
    return new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `Item ${String(item.id)} records a source no credential can hold: ${source}`,
      { item_id: item.id, source },
    );
  }

  // A row in a state its type's lifecycle cannot produce is refused, the
  // question `POST /items` asks of a caller: `trashed` is a state, and not
  // one a `system.*` row can be in, and a restore that wrote it would land a
  // row nothing can purge, restore or move. Only an absent state (the
  // default) and the default itself pass without the question, since the
  // store would write whatever else the line carried. The lifecycle a type
  // has follows from its namespace, so the archive's own registrations do
  // not change the answer.
  const state = item.state;
  if (state === undefined || state === null || state === SYSTEM_DEFAULT_STATE)
    return null;
  const error = validateTransition(
    String(item.type),
    SYSTEM_DEFAULT_STATE,
    state as ItemState,
  );
  return error
    ? new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Item ${String(item.id)} of type ${String(item.type)} is recorded in a state its lifecycle cannot produce: ${error}`,
      )
    : null;
}

/**
 * Place an archive's blob bytes in the disk store, before the restore's
 * transaction opens, and answer the hashes whose bytes this request wrote.
 *
 * Bytes go first and rows second, as `POST /blobs` does it: a rollback
 * cannot reach a filesystem or an object store, so the bytes stay outside
 * the transaction and the request takes back what it wrote if no row ends up
 * naming it (`takeBackBytes`). The caller holds the per-hash locks
 * `POST /blobs` takes from before this runs until it has done so, for the
 * same reason: content addressing means two requests can be writing
 * identical bytes at once, so the check of the disk, the write, the rows and
 * any undo have to be one step, or one request deletes what another was just
 * told is stored.
 */
async function placeBlobBytes(
  storage: Storage,
  blobs: BlobLayer,
  pending: readonly PendingBlob[],
): Promise<string[]> {
  const wrote: string[] = [];
  try {
    for (const blob of pending) {
      await finishCopyDeletion(storage, blobs.disk, blob.hash);
      if ((await blobs.disk.has(blob.hash)) === null) {
        await blobs.disk.put(blob.hash, {
          path: blob.path,
          size_bytes: blob.sizeBytes,
        });
        wrote.push(blob.hash);
      }
    }
  } catch (err) {
    await takeBackBytes(storage, blobs, wrote);
    throw err;
  }
  return wrote;
}

/** Delete the bytes this request placed that no row names: a row that was
 *  already there when the bytes were missing is not this request's, and
 *  keeps them. */
async function takeBackBytes(
  storage: Storage,
  blobs: BlobLayer,
  wrote: readonly string[],
): Promise<void> {
  for (const hash of wrote) {
    try {
      if ((await storage.blobs.get(hash)) !== null) continue;
      await blobs.disk.delete(hash);
    } catch (err) {
      log("error", "blob.orphaned_after_refused_restore", {
        hash,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Everything the restore writes, in one transaction: the registrations,
 * the blob rows, the items with their metadata and history, the edges,
 * their events and every audit record, so an interrupted or refused
 * restore leaves none of them.
 *
 * Other writers wait for it in the writer queue, and are answered
 * `503 write_contention` if they wait past its budget. The event loop
 * gets a turn between batches, so reads, health checks and event
 * streams keep answering while it runs.
 */
async function restoreRows(
  storage: Storage,
  blobs: BlobLayer,
  restore: {
    plan: ArchiveTypePlan;
    pending: readonly PendingBlob[];
    files: ReadArchive["lineFiles"];
    totalItems: number;
    totalEdges: number;
    uploader: string;
    actor: Pick<AuditLogEntry, "key_id" | "client_ip">;
    apiKey: AppEnv["Variables"]["apiKey"];
  },
) {
  const { plan, pending, files, uploader, actor } = restore;
  return runAuditedTransaction(
    storage,
    async () => {
      const types = await writeArchiveTypes(storage, plan, actor);

      for (let at = 0; at < pending.length; at += RESTORE_BATCH) {
        const batch = pending.slice(at, at + RESTORE_BATCH);
        await runAuditedTransaction(
          storage,
          async () => {
            for (const blob of batch) {
              await storage.blobs.register(
                blob.hash,
                blob.mimeType,
                blob.sizeBytes,
              );
              await storage.blobs.recordLocation(blob.hash, blobs.disk.id);
              await storage.blobs.recordUploader(blob.hash, uploader);
            }
          },
          {
            ...actor,
            action: "admin.restore_archive.blobs",
            resource_type: "blob",
            details: { hashes: batch.map((blob) => blob.hash) },
          },
        );
        await yieldBulkWork();
      }

      // A row carrying a property no type declares is refused wherever
      // the strict-mode lever names that type, which is the question
      // `POST /items` asks of a caller. This door writes through the
      // store, where validation runs loose, so the question has to be
      // asked here or not at all. It is asked after the archive's own
      // registrations, so a type this instance is learning from the
      // archive is measured against the declaration it arrives with.
      const enforcement = resolveEnforcement(
        await readInstanceConfig(storage.settings),
        restore.apiKey,
      );

      let imported = 0;
      let duplicates = 0;
      let edgesImported = 0;
      let edgesSkipped = 0;
      const edgesSkippedReasons: Record<string, number> = {};
      const skipEdge = (reason: string): void => {
        edgesSkipped++;
        edgesSkippedReasons[reason] = (edgesSkippedReasons[reason] ?? 0) + 1;
      };

      // Ids an edge endpoint may resolve against without a storage
      // lookup: every id this restore just wrote, plus ids that
      // collided. A collision means the database already holds that
      // exact id, so edges naming it still land correctly.
      const resolvableIds = new Set<string>();

      // Each batch is announced inside the restore's transaction, so
      // the log holds every row it wrote or none: a restore is a write
      // like any other from a subscriber's side, and the log is the
      // only catch-up there is. Every item is announced before any
      // edge, because an edge names two endpoints and a client
      // receiving one for a row it has never heard of has no way to
      // resolve it.
      //
      // Fan-out is declined, as it is on every other door that writes
      // in bulk: a restore can carry every row in an instance, and
      // driving outbound work per row per subscribed connection would
      // push an archive's worth of writes back out to whatever an
      // installed connection is joined to. The flag governs only the
      // outbound side effects, and rides the persisted row, so a
      // catch-up that rebuilds these events reaches the same answer.
      let restoredItems: { item: Item; metadata: Metadata }[] = [];
      const announceItems = async (): Promise<void> => {
        for (const { item, metadata } of restoredItems) {
          await publish({
            type: "created",
            item,
            metadata,
            enableFanout: false,
          });
        }
        restoredItems = [];
        await yieldBulkWork();
      };

      let index = 0;
      const seenSnapshotIds = new Set<string>();
      for await (const entry of itemLines(files["items.ndjson"])) {
        const { item, metadata: meta, lending_blobs: lending } = entry;
        const dates = archiveDates("item", item, index);
        const history = archiveVersions(
          item,
          entry.versions,
          index,
          seenSnapshotIds,
        );
        index++;
        const refusal = undeclaredPropertyRefusal(
          enforcement,
          String(item.type),
          (item.properties ?? {}) as Record<string, unknown>,
          { item_id: item.id },
        );
        if (refusal) throw refusal;

        const archiveId = typeof item.id === "string" ? item.id : undefined;
        let created: Item;
        try {
          ({ item: created } = await writeItem(
            storage,
            { kind: "platform" },
            {
              op: "create",
              // A digest lends here exactly where it lent in the
              // instance the archive was taken from, and a line naming
              // none lends nothing.
              blob_proof: (hash) =>
                Promise.resolve(
                  Array.isArray(lending) && lending.includes(hash),
                ),
              ...(archiveId !== undefined && { id: archiveId }),
              // The row comes back under its archived id, so it comes
              // back at its archived version too. Re-minting at 1 lets
              // a client's stale precondition pass, later, against
              // content it never read from.
              ...(typeof item.version === "number" && {
                version: item.version,
              }),
              type: item.type as string,
              properties: (item.properties ?? {}) as Record<string, unknown>,
              state: item.state as ItemState | undefined,
              tier: item.tier as Tier | undefined,
              occurred_at: item.occurred_at as string | undefined,
              source: item.source as string | undefined,
              source_id: item.source_id as string | undefined,
              capture_latitude: item.capture_latitude as number | undefined,
              capture_longitude: item.capture_longitude as number | undefined,
              tags: archiveTags(meta),
            },
            // Announced with the extensions it carries, which a second
            // write sets.
            { announce: false },
          ));
        } catch (err) {
          if (
            err instanceof MarfaError &&
            (err.code === ErrorCode.DUPLICATE_SOURCE ||
              err.code === ErrorCode.CONFLICT ||
              err.code === ErrorCode.LINK_TAKEN)
          ) {
            duplicates++;
            if (err.code === ErrorCode.CONFLICT && archiveId !== undefined) {
              resolvableIds.add(archiveId);
            }
            continue;
          }
          throw err;
        }
        imported++;
        resolvableIds.add(created.id);

        // One write for the whole set, not one per namespace. Each
        // `setExtension` rewrites the same JSON column and bumps the
        // item's modification time beside it, so writing them
        // separately cost namespaces times items on the one path
        // whose purpose is moving a lot of rows at once.
        const { extensions: stored } = await storage.metadata.setExtensions(
          created.id,
          archiveExtensions(meta),
        );
        // A history conflict escapes the create-only duplicate catch
        // above: an existing snapshot ID belongs to a different
        // recorded past.
        const finalized = await finalizeArchiveItem(
          storage,
          created.id,
          dates,
          history,
        );
        restoredItems.push({
          item: finalized,
          metadata: {
            item_id: created.id,
            // `archiveTags` answers `undefined` for "the archive named
            // none", which is what `create` wants and what a
            // `Metadata` cannot hold: an item with no tags carries an
            // empty list.
            tags: archiveTags(meta) ?? [],
            extensions: stored,
          },
        });
        if (restoredItems.length >= RESTORE_BATCH) await announceItems();
      }
      await announceItems();

      let restoredEdges: Edge[] = [];
      const announceEdges = async (): Promise<void> => {
        const sourceTypes = await sourceTypesFor(
          storage,
          restoredEdges.map((edge) => edge.source_id),
        );
        for (const edge of restoredEdges) {
          await publishEdge({
            type: "edge_created",
            edge,
            sourceType: sourceTypes.get(edge.source_id),
            enableFanout: false,
          });
        }
        restoredEdges = [];
        await yieldBulkWork();
      };

      // Edges restore after every item the archive carries exists, and
      // only where both endpoints resolve in the database, so a
      // partial or hand-edited archive cannot plant a reference to an
      // item that is not there.
      const endpointResolves = async (id: string): Promise<boolean> =>
        resolvableIds.has(id) || (await storage.items.get(id)) !== null;

      let edgeIndex = 0;
      for await (const edge of edgeLines(files["edges.ndjson"])) {
        const dates = archiveDates("edge", edge, edgeIndex);
        edgeIndex++;
        const sourceId = edge.source_id;
        const targetId = edge.target_id;
        const edgeType = edge.edge_type;
        if (
          typeof sourceId !== "string" ||
          typeof targetId !== "string" ||
          typeof edgeType !== "string"
        ) {
          skipEdge("malformed");
          continue;
        }
        if (
          !(await endpointResolves(sourceId)) ||
          !(await endpointResolves(targetId))
        ) {
          skipEdge("endpoint_missing");
          continue;
        }
        const edgeId = typeof edge.id === "string" ? edge.id : undefined;
        if (edgeId !== undefined && (await storage.edges.get(edgeId))) {
          // Already present under the same id: a re-restore, not an
          // error.
          skipEdge("already_present");
          continue;
        }
        // An archive is a file someone can hand you: replayed through
        // the raw insert, a hand-edited one could plant edges of an
        // unregistered type, or edges violating every constraint the
        // enforcer exists to apply, past checks the API refuses at. It
        // is validated exactly the way `POST /edges` validates, one
        // edge at a time: the batch entry point throws on its first
        // violation, which would cost the whole restore over one bad
        // line, and this route's contract is to skip and count.
        //
        // The archive's own edge types resolve because they were
        // registered earlier in this transaction. `replay` lets a
        // revoked folder keep the placements it held before its
        // revoke.
        try {
          await assertEdgesCanBeCreated(
            storage.edges,
            storage.items,
            [
              {
                source_id: sourceId,
                target_id: targetId,
                edge_type: edgeType,
                properties: (edge.properties ?? {}) as Record<string, unknown>,
              },
            ],
            // A restore replays every row the archive holds, so no
            // target is one to withhold; the operator's own map
            // reaches no type.
            () => true,
            { replay: true },
          );
        } catch (err) {
          if (err instanceof MarfaError) {
            skipEdge(err.code);
            continue;
          }
          throw err;
        }
        restoredEdges.push(
          await storage.edges.createRaw({
            ...dates,
            ...(edgeId !== undefined && { id: edgeId }),
            // Same rule as the item path above. Both doors move
            // together or the hole stays reachable through the other
            // one.
            ...(typeof edge.version === "number" && {
              version: edge.version,
            }),
            source_id: sourceId,
            target_id: targetId,
            edge_type: edgeType,
            properties: (edge.properties ?? {}) as Record<string, unknown>,
          }),
        );
        edgesImported++;
        if (restoredEdges.length >= RESTORE_BATCH) await announceEdges();
      }
      await announceEdges();

      return {
        imported,
        duplicates,
        edgesImported,
        edgesSkipped,
        edgesSkippedReasons,
        types,
      };
    },
    (result) => ({
      ...actor,
      action: "admin.restore_archive",
      resource_type: "admin.restore_archive",
      details: {
        imported: result.imported,
        duplicates: result.duplicates,
        edges_imported: result.edgesImported,
        edges_skipped: result.edgesSkipped,
        edges_skipped_reasons: result.edgesSkippedReasons,
        blobs_imported: pending.length,
        types_registered: result.types.typesRegistered,
        types_skipped: result.types.typesSkipped,
        edge_types_registered: result.types.edgeTypesRegistered,
        edge_types_skipped: result.types.edgeTypesSkipped,
        total_items: restore.totalItems,
        total_edges: restore.totalEdges,
      },
    }),
  );
}

export function adminArchiveRoutes(storage: Storage, blobs: BlobLayer) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(restoreArchiveRoute, async (c) => {
    const uploader = blobPrincipal(requireAuth(c), "api_key");
    const actor = {
      key_id: c.get("apiKey")?.id,
      client_ip: c.get("clientIp") ?? null,
    };

    // The body streams to a spool on the disk store's filesystem, as an
    // upload's does, so an archive is as large as an archive is. Every spool
    // is recorded the moment it is minted and removed however the request
    // ends: a refusal can land while an entry is still being written, and a
    // blob spool the store moved into place is simply no longer there.
    const spools: string[] = [];
    const mintSpool = (): string => {
      const spool = blobs.disk.spoolPath();
      spools.push(spool);
      return spool;
    };
    try {
      const bodySpool = mintSpool();
      const body = c.req.raw.body;
      if (body) {
        await pipeline(Readable.fromWeb(body), createWriteStream(bodySpool));
      }
      if (
        (await stat(bodySpool).then(
          (s) => s.size,
          () => 0,
        )) === 0
      ) {
        throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Empty archive");
      }
      const archive = await readArchive(bodySpool, mintSpool);
      await rm(bodySpool, { force: true });
      const paths = archive.lineFiles;

      // Everything that can refuse without writing is asked first, over the
      // whole archive, so a refused archive leaves nothing behind.
      let totalItems = 0;
      const seenSnapshotIds = new Set<string>();
      for await (const entry of itemLines(paths["items.ndjson"])) {
        const refusal = itemRefusal(entry, totalItems, seenSnapshotIds);
        if (refusal) throw refusal;
        totalItems++;
      }
      seenSnapshotIds.clear();
      let totalEdges = 0;
      for await (const edge of edgeLines(paths["edges.ndjson"])) {
        archiveDates("edge", edge, totalEdges);
        const refusal = archiveScalarRefusal("edge", edge, totalEdges);
        if (refusal) throw refusal;
        totalEdges++;
      }
      const typeEntries: ArchiveTypeEntry[] = [];
      for await (const line of archiveLines(paths["types.ndjson"])) {
        try {
          typeEntries.push(JSON.parse(line) as ArchiveTypeEntry);
        } catch {
          // Same rule as item and edge lines.
        }
      }
      const typePlan = await planArchiveTypes(storage, typeEntries);

      const releaseBlobs = await holdBlobUploadLocks(
        archive.blobs.map((blob) => blob.hash),
      );
      try {
        const wrote = await placeBlobBytes(storage, blobs, archive.blobs);
        try {
          const result = await restoreRows(storage, blobs, {
            plan: typePlan,
            pending: archive.blobs,
            files: paths,
            totalItems,
            totalEdges,
            uploader,
            actor,
            apiKey: c.get("apiKey"),
          });
          return c.json(
            {
              imported: result.imported,
              duplicates: result.duplicates,
              edges_imported: result.edgesImported,
              edges_skipped: result.edgesSkipped,
              edges_skipped_reasons: result.edgesSkippedReasons,
              blobs_imported: archive.blobs.length,
              types_registered: result.types.typesRegistered,
              types_skipped: result.types.typesSkipped,
              edge_types_registered: result.types.edgeTypesRegistered,
              edge_types_skipped: result.types.edgeTypesSkipped,
            },
            200,
          );
        } catch (err) {
          await takeBackBytes(storage, blobs, wrote);
          throw err;
        }
      } finally {
        releaseBlobs();
      }
    } finally {
      for (const spool of spools) await rm(spool, { force: true });
    }
  });

  return router;
}
