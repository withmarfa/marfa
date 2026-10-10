/**
 * POST /restore: direct owner or local authority only, tar.gz body.
 *
 * Dedicated archive-import endpoint. Content-type is
 * `application/gzip` (not JSON); response is `{imported, duplicates,
 * edges_imported, edges_skipped, blobs_imported}` and the registration
 * counts. Enforces the manifest version 0 contract and blob-hash
 * verification, and checks every row before writing any. Memory does not
 * grow with the archive: entries it does not read are skipped, the rest are
 * read one line at a time, and no row is held past its line. It writes in a
 * single transaction covering type and edge-type registrations, blob rows,
 * items, metadata, history, edges and their events, and tells subscribers
 * about the events from the log once that commits.
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
import { announceFromLog, publish, publishEdge } from "../pubsub.js";
import type { Edge, Item } from "@withmarfa/shared";
import type { ItemState, Tier } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  isReservedCredentialSource,
  directAuthorityOnly,
  requireRecentOwnerAuthentication,
  authorityId,
} from "../middleware/auth.js";
import { finalizeArchiveItem, writeItem } from "../storage/item-write.js";
import { finishCopyDeletion } from "../housekeeping/blob-delete.js";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
import { DiskReserve } from "../storage/disk-space.js";
import { NaturalKeyHeld } from "../storage/interface.js";
import type { AuditLogEntry, Storage } from "../storage/interface.js";
import type { BlobLayer } from "../storage/blob-layer.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import {
  planArchiveTypes,
  writeArchiveTypes,
} from "./restore-archive-types.js";
import type {
  ArchiveTypeEntry,
  ArchiveTypePlan,
} from "./restore-archive-types.js";
import { undeclaredPropertyRefusal } from "./_undeclared-property.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import { assertEdgesCanBeCreated } from "../storage/edge-constraints.js";
import { holdBlobUploadLocks } from "../storage/blob-upload-lock.js";
import { log } from "../middleware/logger.js";
import { sourceTypesFor } from "./_edge-visibility.js";
import { archiveDates, archiveVersions } from "./restore-archive-history.js";
import { archiveLines, readArchive } from "./restore-archive-read.js";
import type { PendingBlob, ReadArchive } from "./restore-archive-read.js";
import { yieldBulkWork } from "../bulk-actions/yield.js";
import { errorMessage } from "../error-text.js";

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
    // Only a restore can bring in an empty namespace: every other write takes
    // it from a route segment, which is never empty. No operation can then
    // address or delete it, so it is dropped rather than restored.
    if (namespace === "") continue;
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      out[namespace] = data as Record<string, unknown>;
    }
  }
  return out;
}

const restoreArchiveRoute = createRoute({
  operationId: "restoreArchive",
  method: "post",
  path: "/",
  tags: ["Export and restore"],
  summary: "Restore from an archive",
  description:
    "Restores an exported archive atomically and returns counts of written and skipped records. Other writes wait until it finishes. Requires local authority or the owner, authenticated within five minutes.",
  security: [{ ownerSession: [] }],
  middleware: directAuthorityOnly,
  request: {
    body: {
      required: true,
      description:
        "The archive file, as `GET /export?format=archive` returned it. Only the build that wrote an archive is sure to read it.",
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
            imported: z.number().describe("How many items Marfa wrote."),
            duplicates: z
              .number()
              .describe(
                "How many items Marfa skipped because their ID, natural key or link is already taken.",
              ),
            edges_imported: z.number().describe("How many edges Marfa wrote."),
            edges_skipped: z.number().describe("How many edges Marfa skipped."),
            /** A silent skip and a refused one are different signals, and a
             *  bare count cannot tell an operator which they got. */
            edges_skipped_reasons: z
              .record(z.string(), z.number())
              .describe(
                "How many edges Marfa skipped for each reason, such as `endpoint_missing` or `already_present`.",
              ),
            blobs_imported: z
              .number()
              .describe(
                "How many blobs the archive carried whose bytes match their hash, whether or not the instance already had them.",
              ),
            types_registered: z
              .number()
              .describe("How many types Marfa registered."),
            types_skipped: z
              .number()
              .describe(
                "How many types Marfa skipped because the instance already registers them identically.",
              ),
            edge_types_registered: z
              .number()
              .describe("How many edge types Marfa registered."),
            edge_types_skipped: z
              .number()
              .describe(
                "How many edge types Marfa skipped because the instance already registers them identically.",
              ),
          }),
        },
      },
      description:
        "Returns the counts. Items and edges keep their IDs, versions and dates, and items keep their tags, extensions and history. Marfa leaves an existing item as it is when an archived one has its ID, natural key or link. An archive holds no keys, webhooks, configuration or tombstones.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "invalid_properties",
            "invalid_schema",
            "validation_error",
          ]),
        },
      },
      description:
        "- `validation_error`: the body isn't a valid archive, or the archive is at another format version, carries an entry twice, has an invalid row, or has a `manifest.json`, `types.ndjson` or line of `items.ndjson` or `edges.ndjson` larger than 64 MiB.\n- `invalid_properties`: an item sets a property its type doesn't declare, and `strict_mode` names that type.\n- `invalid_schema`: an archived type or edge type is invalid, or carries a key the schema doesn't define (`details.errors` names each key's path).",
    },
    413: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["request_too_large"]),
        },
      },
      description:
        "- `request_too_large`: an item's properties, the properties of one of its earlier versions, or an edge's properties are larger than the bulk write endpoints accept. `details` names the row and the field.",
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
        "application/json": { schema: makeErrorResponseSchema(["forbidden"]) },
      },
      description:
        "Requires direct owner or local authority and recent owner authentication.",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["conflict", "link_taken"]),
        },
      },
      description:
        "- `conflict`: the archive redefines a type this instance registers differently or registered while the restore ran, carries a core edge type, or carries a snapshot ID that already exists.\n- `link_taken`: the archive registers a type naming a `link_field` in which two rows a forced delete left share a value.",
    },
  },
});

/**
 * How much of the archive the restore reads between two turns of the event
 * loop, in lines and in bytes, whichever comes first. A restore holds the
 * write lock from its first registration to its commit, and each stretch
 * between turns is one in which nothing else in the process answers, so a
 * large row gets a turn of its own.
 */
const RESTORE_BATCH_LINES = 100;
const RESTORE_BATCH_BYTES = 4 * 1024 * 1024;

/** An `items.ndjson` line, which the restore reads defensively. */
interface ArchivedItemLine {
  item: Record<string, unknown>;
  metadata?: unknown;
  lending_blobs?: unknown;
  lending_extensions?: unknown;
  versions?: unknown;
}

/** An `edges.ndjson` line. */
interface ArchivedEdgeLine {
  edge: Record<string, unknown>;
  lending_blobs?: unknown;
}

/** The digests a line says lent, which are the strings of the list it
 *  names. A line naming none, or a value that is no list, lends nothing. */
function archivedLending(listed: unknown): ReadonlySet<string> {
  return new Set(
    Array.isArray(listed)
      ? listed.filter((hash): hash is string => typeof hash === "string")
      : [],
  );
}

/** The proof a restore gives a write: a digest lends where the archive says
 *  it lent in the instance it was taken from. */
function archivedProof(listed: unknown): (hash: string) => Promise<boolean> {
  const lending = archivedLending(listed);
  return (hash) => Promise.resolve(lending.has(hash));
}

/** `archivedProof` for each namespace of an item's extensions. */
function archivedExtensionProofs(
  listed: unknown,
): (namespace: string) => (hash: string) => Promise<boolean> {
  const byNamespace = isRecord(listed) ? listed : {};
  return (namespace) => archivedProof(byNamespace[namespace]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One line of a line file, parsed, with its length for pacing. `value` is
 *  null for a line that does not parse or has the wrong shape, which is
 *  skipped: the exporter always emits valid JSON, so a bad line means the
 *  archive was edited by hand. */
interface ArchiveLine<T> {
  value: T | null;
  bytes: number;
}

async function* parsedLines<T>(
  path: string | undefined,
  pick: (parsed: unknown) => T | null,
): AsyncGenerator<ArchiveLine<T>> {
  for await (const line of archiveLines(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      yield { value: null, bytes: Buffer.byteLength(line) };
      continue;
    }
    yield { value: pick(parsed), bytes: Buffer.byteLength(line) };
  }
}

function itemLines(path: string | undefined) {
  return parsedLines(path, (parsed) =>
    isRecord(parsed) && isRecord(parsed.item)
      ? (parsed as unknown as ArchivedItemLine)
      : null,
  );
}

function edgeLines(path: string | undefined) {
  return parsedLines(path, (parsed) =>
    isRecord(parsed) && isRecord(parsed.edge)
      ? (parsed as unknown as ArchivedEdgeLine)
      : null,
  );
}

/**
 * The refusal for properties larger than any write door takes
 * (`bulkBodyCap`), answered as a write door answers a body that large. A
 * restore is not a way to plant a row the write doors would refuse.
 */
function oversizedProperties(
  kind: "item" | "edge",
  row: Record<string, unknown>,
  index: number,
  field: string,
  properties: unknown,
  maxRowBytes: number,
): MarfaError | null {
  if (properties === undefined) return null;
  const bytes = Buffer.byteLength(JSON.stringify(properties));
  if (bytes <= maxRowBytes) return null;
  return new MarfaError(
    ErrorCode.REQUEST_TOO_LARGE,
    `Invalid ${kind} ${String(row.id)} in ${kind}s.ndjson parsed row ${String(index + 1)}: ${field} is ${String(bytes)} bytes, more than the ${String(maxRowBytes)} a write door accepts`,
    {
      [kind === "item" ? "item_id" : "edge_id"]: row.id,
      row: index + 1,
      field,
      limit_bytes: maxRowBytes,
    },
  );
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
  maxRowBytes: number,
): MarfaError | null {
  const { item } = entry;
  archiveDates("item", item, index);
  const history = archiveVersions(item, entry.versions, index, seenSnapshotIds);
  const scalar = archiveScalarRefusal("item", item, index);
  if (scalar) return scalar;
  const oversized =
    oversizedProperties(
      "item",
      item,
      index,
      "properties",
      item.properties,
      maxRowBytes,
    ) ??
    history
      .map((snapshot, at) =>
        oversizedProperties(
          "item",
          item,
          index,
          `versions.${String(at)}.properties`,
          snapshot.properties,
          maxRowBytes,
        ),
      )
      .find((refusal) => refusal !== null) ??
    null;
  if (oversized) return oversized;

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
 * transaction opens, and answer the hashes whose bytes were missing there.
 *
 * Bytes go first and rows second, as `POST /blobs` does it: a rollback
 * cannot reach a filesystem or an object store, so the bytes stay outside
 * the transaction. Each hash no row names yet gets a copy-deletion record,
 * committed before its bytes are placed, and `recordLocation` clears it in
 * the restore's transaction. A restore that does not commit takes the bytes
 * back itself (`takeBackBytes`); one killed before its commit leaves the
 * records, and the next copy cleanup (`finishPendingCopyDeletions`) removes
 * the bytes. A hash a row already names keeps its bytes and gets no record.
 *
 * The caller holds the per-hash locks `POST /blobs` takes from before this
 * runs until it has done so, for the same reason: content addressing means
 * two requests can be writing identical bytes at once, so the check of the
 * disk, the write, the rows and any undo have to be one step, or one request
 * deletes what another was just told is stored.
 */
async function placeBlobBytes(
  storage: Storage,
  blobs: BlobLayer,
  pending: readonly PendingBlob[],
): Promise<string[]> {
  const missing: PendingBlob[] = [];
  for (const blob of pending) {
    await finishCopyDeletion(storage, blobs.disk, blob.hash);
    if ((await blobs.disk.has(blob.hash)) === null) missing.push(blob);
  }
  const unnamed: string[] = [];
  for (const blob of missing) {
    if ((await storage.blobs.get(blob.hash)) === null) unnamed.push(blob.hash);
  }
  if (unnamed.length > 0) {
    await storage.runInTransaction(async () => {
      for (const hash of unnamed) {
        await storage.blobs.queueCopyDeletion(hash, blobs.disk.id);
      }
    });
  }
  const placed = missing.map((blob) => blob.hash);
  try {
    for (const blob of missing) {
      await blobs.disk.put(blob.hash, {
        path: blob.path,
        size_bytes: blob.sizeBytes,
      });
    }
  } catch (err) {
    await takeBackBytes(storage, blobs, placed);
    throw err;
  }
  return placed;
}

/** Delete the bytes this request placed that no row names, and their
 *  records: a row that was already there when the bytes were missing is not
 *  this request's, and keeps them. */
async function takeBackBytes(
  storage: Storage,
  blobs: BlobLayer,
  placed: readonly string[],
): Promise<void> {
  for (const hash of placed) {
    try {
      if ((await storage.blobs.get(hash)) !== null) continue;
      await finishCopyDeletion(storage, blobs.disk, hash);
    } catch (err) {
      log("error", "blob.orphaned_after_refused_restore", {
        hash,
        error: errorMessage(err),
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
 * Nothing it writes is held in memory past the line it came from: events
 * go to the log as each row is written, and are read back from it to tell
 * this process's subscribers once the transaction commits
 * (`announceFromLog`). Other writers wait for it in the writer queue, and
 * are answered `503 write_contention` if they wait past its budget. The
 * event loop gets a turn after every `RESTORE_BATCH_LINES` lines or
 * `RESTORE_BATCH_BYTES` bytes read, so health checks and event streams
 * keep answering while it runs.
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

      for (let at = 0; at < pending.length; at += RESTORE_BATCH_LINES) {
        const batch = pending.slice(at, at + RESTORE_BATCH_LINES);
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
            action: "restore_archive.blobs",
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

      // Every event goes to the log inside the restore's transaction, so
      // the log holds every row it wrote or none: a restore is a write
      // like any other from a subscriber's side, and the log is the only
      // catch-up there is. Every item is announced before any edge,
      // because an edge names two endpoints and a client receiving one
      // for a row it has never heard of has no way to resolve it.
      //
      // Fan-out is declined, as it is on every other door that writes in
      // bulk: a restore can carry every row in an instance, and driving
      // outbound work per row per subscribed connection would push an
      // archive's worth of writes back out to whatever an installed
      // connection is joined to. The flag governs only the outbound side
      // effects, and rides the persisted row, so a catch-up that rebuilds
      // these events reaches the same answer.
      let logged: { first: bigint; last: bigint } | undefined;
      const logs = (eventId: bigint | undefined): void => {
        if (eventId === undefined) return;
        logged = { first: logged?.first ?? eventId, last: eventId };
      };

      // Edges wait for their source types to be read together, and go to
      // the log at the next turn, so they are held for one stretch at most.
      let unlogged: Edge[] = [];
      const logEdges = async (): Promise<void> => {
        const sourceTypes = await sourceTypesFor(
          storage,
          unlogged.map((edge) => edge.source_id),
        );
        for (const edge of unlogged) {
          logs(
            await publishEdge(
              {
                type: "edge_created",
                edge,
                sourceType: sourceTypes.get(edge.source_id),
                enableFanout: false,
              },
              { announce: "from_log" },
            ),
          );
        }
        unlogged = [];
      };

      let lines = 0;
      let bytes = 0;
      const pace = async (lineBytes: number): Promise<void> => {
        lines += 1;
        bytes += lineBytes;
        if (lines < RESTORE_BATCH_LINES && bytes < RESTORE_BATCH_BYTES) return;
        await logEdges();
        lines = 0;
        bytes = 0;
        await yieldBulkWork();
      };

      // Ids an edge endpoint may resolve against without a storage
      // lookup: every id this restore just wrote, plus ids that
      // collided. A collision means the database already holds that
      // exact id, so edges naming it still land correctly.
      const resolvableIds = new Set<string>();

      let index = 0;
      const seenSnapshotIds = new Set<string>();
      const restoreItem = async (entry: ArchivedItemLine): Promise<void> => {
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
              blob_proof: archivedProof(lending),
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
          if (err instanceof NaturalKeyHeld) {
            duplicates++;
            return;
          }
          if (
            err instanceof MarfaError &&
            (err.code === ErrorCode.CONFLICT ||
              err.code === ErrorCode.LINK_TAKEN)
          ) {
            duplicates++;
            if (err.code === ErrorCode.CONFLICT && archiveId !== undefined) {
              resolvableIds.add(archiveId);
            }
            return;
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
          archivedExtensionProofs(entry.lending_extensions),
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
        logs(
          await publish(
            {
              type: "created",
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
              enableFanout: false,
            },
            { announce: "from_log" },
          ),
        );
      };
      for await (const line of itemLines(files["items.ndjson"])) {
        if (line.value !== null) await restoreItem(line.value);
        await pace(line.bytes);
      }

      // Edges restore after every item the archive carries exists, and
      // only where both endpoints resolve in the database, so a
      // partial or hand-edited archive cannot plant a reference to an
      // item that is not there.
      const endpointResolves = async (id: string): Promise<boolean> =>
        resolvableIds.has(id) || (await storage.items.get(id)) !== null;

      let edgeIndex = 0;
      const restoreEdge = async ({
        edge,
        lending_blobs: lending,
      }: ArchivedEdgeLine): Promise<void> => {
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
          return;
        }
        if (
          !(await endpointResolves(sourceId)) ||
          !(await endpointResolves(targetId))
        ) {
          skipEdge("endpoint_missing");
          return;
        }
        const edgeId = typeof edge.id === "string" ? edge.id : undefined;
        if (edgeId !== undefined && (await storage.edges.get(edgeId))) {
          // Already present under the same id: a re-restore, not an
          // error.
          skipEdge("already_present");
          return;
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
            storage,
            [
              {
                source_id: sourceId,
                target_id: targetId,
                edge_type: edgeType,
                properties: (edge.properties ?? {}) as Record<string, unknown>,
              },
            ],
            // Direct authority restores every row the archive holds.
            () => true,
            { replay: true },
          );
        } catch (err) {
          if (err instanceof MarfaError) {
            skipEdge(err.code);
            return;
          }
          throw err;
        }
        unlogged.push(
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
            blob_proof: archivedProof(lending),
          }),
        );
        edgesImported++;
      };
      for await (const line of edgeLines(files["edges.ndjson"])) {
        if (line.value !== null) await restoreEdge(line.value);
        await pace(line.bytes);
      }
      await logEdges();
      announceFromLog(logged);

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
      action: "restore_archive",
      resource_type: "restore_archive",
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

export function restoreArchiveRoutes(
  storage: Storage,
  blobs: BlobLayer,
  limits: { maxRowBytes: number; diskReserveBytes?: number },
) {
  const router = createOpenAPIRouter<AppEnv>();
  const reserve = new DiskReserve(
    blobs.disk.locator,
    limits.diskReserveBytes ?? 0,
  );

  router.openapi(restoreArchiveRoute, async (c) => {
    requireRecentOwnerAuthentication(c);
    const uploader = authorityId(c);
    const actor = {
      key_id: authorityId(c),
      client_ip: c.get("clientIp") ?? null,
    };

    // The body streams to a spool on the disk store's filesystem, as an
    // upload's does, so an archive is as large as an archive is. Every spool
    // is recorded the moment it is minted and removed however the request
    // ends: a refusal can land while an entry is still being written, and a
    // blob spool the store moved into place is simply no longer there.
    const spools: string[] = [];
    const declared = Number(c.req.header("Content-Length"));
    const place = await reserve.admit(
      Number.isSafeInteger(declared) ? declared : 0,
    );
    const mintSpool = (): string => {
      const spool = blobs.disk.spoolPath();
      spools.push(spool);
      return spool;
    };
    try {
      const bodySpool = mintSpool();
      const body = c.req.raw.body;
      if (body) {
        try {
          await pipeline(
            Readable.fromWeb(body),
            place.guard(),
            createWriteStream(bodySpool),
          );
        } finally {
          place.close();
        }
      }
      if (
        (await stat(bodySpool).then(
          (s) => s.size,
          () => 0,
        )) === 0
      ) {
        throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Empty archive");
      }
      const archive = await readArchive(bodySpool, mintSpool, reserve);
      await rm(bodySpool, { force: true });
      const paths = archive.lineFiles;

      // Everything that can refuse without writing is asked first, over the
      // whole archive, so a refused archive leaves nothing behind.
      let totalItems = 0;
      const seenSnapshotIds = new Set<string>();
      for await (const { value: entry } of itemLines(paths["items.ndjson"])) {
        if (entry === null) continue;
        const refusal = itemRefusal(
          entry,
          totalItems,
          seenSnapshotIds,
          limits.maxRowBytes,
        );
        if (refusal) throw refusal;
        totalItems++;
      }
      seenSnapshotIds.clear();
      let totalEdges = 0;
      for await (const { value: line } of edgeLines(paths["edges.ndjson"])) {
        if (line === null) continue;
        const { edge } = line;
        archiveDates("edge", edge, totalEdges);
        const refusal =
          archiveScalarRefusal("edge", edge, totalEdges) ??
          oversizedProperties(
            "edge",
            edge,
            totalEdges,
            "properties",
            edge.properties,
            limits.maxRowBytes,
          );
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
          requireRecentOwnerAuthentication(c);
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
      place.close();
      for (const spool of spools) await rm(spool, { force: true });
    }
  });

  return router;
}
