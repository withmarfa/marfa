/**
 * POST /admin/restore-archive — operator key only, tar.gz body.
 *
 * Dedicated archive-import endpoint. Content-type is
 * `application/gzip` (not JSON); response is `{imported, duplicates,
 * edges_imported, edges_skipped, blobs_imported}`. Enforces the
 * manifest version 0 contract, blob-hash verification, and a single import
 * transaction covering items, metadata, and edges.
 *
 * Item ids are preserved from the archive so restored edges resolve;
 * an id or natural-key collision counts as a duplicate and leaves the
 * existing row untouched. Tags and extensions restore alongside their
 * items. Edges restore in a second pass, only where both endpoints
 * resolve in the target database — a hand-edited archive cannot plant a
 * reference to an item it does not carry. A row comes back at the version
 * it was archived at; version history, created_at and updated_at are
 * re-stamped, not carried.
 *
 * Paired with GET /export?format=archive.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { createRoute, z } from "@hono/zod-openapi";
import * as tar from "tar-stream";
import {
  MarfaError,
  ErrorCode,
  isValidBlobHash,
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
  requireOperatorKey,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { BlobLayer } from "../storage/blob-layer.js";
import { HashingTransform } from "../storage/blob-store.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { constantTimeEqual } from "../utils/crypto.js";
import { registerArchiveTypes } from "./admin-archive-types.js";
import { undeclaredPropertyRefusal } from "./_undeclared-property.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import { assertEdgesCanBeCreated } from "../storage/edge-constraints.js";
import { withBlobUploadLock } from "../storage/blob-upload-lock.js";
import { log } from "../middleware/logger.js";
import type { ArchiveTypeEntry } from "./admin-archive-types.js";

const MAX_ARCHIVE_ITEMS = 5000;
// Edges routinely outnumber items; a 4x multiple keeps the cap
// proportionate without letting a hand-built archive flood the table.
const MAX_ARCHIVE_EDGES = 20000;

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

/**
 * What the restore reads out of `manifest.json`, which is narrower than what
 * the export writes.
 *
 * `ArchiveManifest` in `routes/export.ts` is the writer's own declaration
 * and the authority on the format. This one stops at the fields the restore
 * consults — `version`, which it refuses, and `blobs`, whose mime type it
 * falls back to. Widening it to match the writer would have it claim fields
 * of every archive ever written, which is a claim nothing here can keep.
 */
interface ArchiveManifest {
  version: number;
  format: string;
  created_at: string;
  item_count: number;
  edge_count: number;
  blob_count: number;
  blobs: Record<string, { mime_type: string; size_bytes: number }>;
}

const restoreArchiveRoute = createRoute({
  operationId: "adminRestoreArchive",
  method: "post",
  path: "/restore-archive",
  tags: ["Export"],
  summary: "Restore types, items, edges, metadata, and blobs from an archive",
  description:
    "Ingests a `marfa-archive-v0.tar.gz` produced by `GET /export?format=archive`. The archive's type and edge-type registrations are validated and registered first, so a restore into an empty instance can write the items that use them; a registration the instance already holds identically is skipped, and one it holds differently fails the whole restore with `409` naming every clashing id. Item ids are preserved so restored edges resolve; an id or natural-key collision, or a link another item of the row's type holds, counts as a duplicate and leaves the existing row untouched. Tags and extensions restore with their items; edges restore in a second pass, skipped (and counted) when either endpoint does not resolve. A row comes back at the version it was archived at, for items and edges alike, so a client holding a version across a restore cannot have its precondition pass against content it never read. Version *history* — the per-version snapshots behind `GET /items/{id}?include=versions` — and row timestamps are re-stamped, not carried.",
  security: [{ bearerAuth: [] }],
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
        "`validation_error` for an invalid archive or an unsupported version. `invalid_properties` when a row carries a property its type does not declare and the strict-mode lever names that type; the whole archive is refused before anything is written.",
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
        "`conflict`: the archive redefines a type this instance already registers differently, or carries a core edge type, and nothing was written. `link_taken`: the archive registers a type naming a `link_field` that two rows a forced delete left under the identifier share a value in, and the restore stops there, before any row or blob is written.",
    },
  },
});

interface PendingBlob {
  hash: string;
  mimeType: string;
  /** A spool on the disk store's own filesystem holding the entry's bytes,
   *  which hashed to `hash` as they were read. */
  path: string;
  sizeBytes: number;
}

/** A filesystem error, which is a fault here and not a fault in the
 *  archive: Node's own stream and zlib codes carry underscores. */
function isFilesystemError(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    /^E[A-Z0-9]+$/.test((err as NodeJS.ErrnoException).code ?? "")
  );
}

interface BlobRestore {
  /** Take back exactly what this restore wrote, and nothing that was
   *  already there. */
  undo(): Promise<void>;
}

/**
 * Write an archive's blobs, remembering which bytes and which rows this
 * request created.
 *
 * The per-hash lock is the same one `POST /blobs` takes, and for the same
 * reason: content addressing means two requests can be writing identical bytes
 * at once, so `exists` and the write have to be one step or the request that
 * is refused deletes the other's committed blob.
 */
async function restoreArchiveBlobs(
  storage: Storage,
  blobs: BlobLayer,
  pending: readonly PendingBlob[],
): Promise<BlobRestore> {
  const wroteBytes: string[] = [];
  const wroteRows: string[] = [];

  const undoBytes = async (): Promise<void> => {
    for (const hash of wroteBytes) {
      await withBlobUploadLock(hash, async () => {
        try {
          if ((await storage.blobs.get(hash)) !== null) return;
          await blobs.disk.delete(hash);
        } catch (err) {
          log("error", "blob.orphaned_after_refused_restore", {
            hash,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }
  };

  // Bytes first, rows second, same as `POST /blobs`: a rollback cannot
  // reach a filesystem or an object store, so the bytes stay outside the
  // transaction and this request takes back what it wrote on refusal. Each
  // spool is moved into place or removed, so past this loop none is left.
  let placed = 0;
  try {
    for (const blob of pending) {
      await withBlobUploadLock(blob.hash, async () => {
        if ((await blobs.disk.has(blob.hash)) === null) {
          await blobs.disk.put(blob.hash, {
            path: blob.path,
            size_bytes: blob.sizeBytes,
          });
          wroteBytes.push(blob.hash);
        } else {
          await rm(blob.path, { force: true });
        }
      });
      placed++;
    }
  } catch (err) {
    for (const blob of pending.slice(placed)) {
      await rm(blob.path, { force: true });
    }
    await undoBytes();
    throw err;
  }

  // The rows commit as one transaction, so a failure rolls every row back
  // at once.
  try {
    await storage.runInTransaction(async () => {
      const planned: PendingBlob[] = [];
      for (const blob of pending) {
        if ((await storage.blobs.get(blob.hash)) === null) {
          planned.push(blob);
        }
      }
      if (planned.length === 0) return;
      for (const blob of planned) {
        await storage.blobs.register(blob.hash, blob.mimeType, blob.sizeBytes);
        await storage.blobs.recordLocation(blob.hash, blobs.disk.id);
        wroteRows.push(blob.hash);
      }
    });
  } catch (err) {
    // The transaction rolled the rows back; the bytes are this function's
    // to take back before the refusal travels on.
    wroteRows.length = 0;
    await undoBytes();
    throw err;
  }

  return {
    undo: async () => {
      for (const hash of wroteRows) {
        try {
          await storage.blobs.remove(hash);
        } catch (err) {
          log("error", "blob.row_orphaned_after_refused_restore", {
            hash,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Another request may have registered these same bytes in the
      // meantime, and content addressing means its row describes the file
      // this request happens to have written; `undoBytes` re-checks under
      // the per-hash lock before deleting.
      await undoBytes();
    },
  };
}

export function adminArchiveRoutes(storage: Storage, blobs: BlobLayer) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(restoreArchiveRoute, async (c) => {
    requireOperatorKey(c);

    // The body streams to a spool on the disk store's filesystem, as an
    // upload's does, so an archive is as large as an archive is: nothing
    // here holds it in memory, and the blob entries inside it are spooled
    // the same way, each hashed as it is read. Every spool is recorded the
    // moment it is minted, because a refusal can land while an entry's
    // pipeline is still settling, before that entry is pending.
    const spools: string[] = [];
    const mintSpool = (): string => {
      const spool = blobs.disk.spoolPath();
      spools.push(spool);
      return spool;
    };
    const bodySpool = mintSpool();
    try {
      const body = c.req.raw.body;
      if (body) {
        await pipeline(Readable.fromWeb(body), createWriteStream(bodySpool));
      }
    } catch (err) {
      await rm(bodySpool, { force: true });
      throw err;
    }
    if (
      (await stat(bodySpool).then(
        (s) => s.size,
        () => 0,
      )) === 0
    ) {
      await rm(bodySpool, { force: true });
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Empty archive");
    }

    let manifest: ArchiveManifest | null = null;
    const itemLines: string[] = [];
    const edgeLines: string[] = [];
    const typeLines: string[] = [];
    const pendingBlobs: PendingBlob[] = [];
    let blobCount = 0;
    const extract = tar.extract();
    const gunzip = createGunzip();
    const inputStream = createReadStream(bodySpool);

    const entries = new Promise<void>((resolve, reject) => {
      // Every stream in the pipeline needs its own listener: `pipe` does not
      // forward an error, and a stream without one re-emits it as an
      // unhandled `error` event that ends the process. A body the
      // decompressor or the tar reader cannot parse is a refusal, not a crash.
      const fail = (err: unknown) => {
        reject(
          err instanceof MarfaError || isFilesystemError(err)
            ? err
            : new MarfaError(
                ErrorCode.VALIDATION_ERROR,
                "Invalid archive: expected a gzip-compressed tar",
              ),
        );
      };

      inputStream.on("error", fail);
      gunzip.on("error", fail);
      extract.on("error", fail);

      extract.on("entry", (header, stream, next) => {
        stream.on("error", fail);
        // A blob entry goes to a spool of its own, hashed on the way; an
        // entry that does not hash to its name is left out, as an entry
        // under a name that is no hash is. The manifest and the line files
        // are small and are read whole.
        if (header.name.startsWith("blobs/")) {
          const hash = header.name.slice("blobs/".length);
          if (!isValidBlobHash(hash)) {
            stream.on("end", next);
            stream.resume();
            return;
          }
          const spool = mintSpool();
          const hashing = new HashingTransform();
          pipeline(stream, hashing, createWriteStream(spool)).then(
            async () => {
              if (constantTimeEqual(hashing.digest(), hash)) {
                blobCount++;
                const mimeType =
                  manifest?.blobs[hash]?.mime_type ??
                  "application/octet-stream";
                pendingBlobs.push({
                  hash,
                  mimeType,
                  path: spool,
                  sizeBytes: hashing.bytes,
                });
              } else {
                await rm(spool, { force: true });
              }
              next();
            },
            async (err: unknown) => {
              await rm(spool, { force: true });
              fail(err);
            },
          );
          return;
        }
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          const buf = Buffer.concat(chunks);

          if (header.name === "manifest.json") {
            try {
              manifest = JSON.parse(buf.toString("utf-8")) as ArchiveManifest;
              if (manifest.version !== 0) {
                reject(
                  new MarfaError(
                    ErrorCode.VALIDATION_ERROR,
                    // An archive at another version may name its
                    // registrations under keys this build does not read,
                    // with no fallback key, so the refusal has to be here:
                    // parsing one would drop every registration it carries
                    // and answer 200.
                    `Unsupported archive version: ${String(manifest.version)}. This build reads version 0 only, and nothing converts another: export again from a build that writes version 0.`,
                  ),
                );
                return;
              }
            } catch (err) {
              if (err instanceof MarfaError) {
                reject(err);
                return;
              }
              reject(
                new MarfaError(
                  ErrorCode.VALIDATION_ERROR,
                  "Invalid manifest.json",
                ),
              );
              return;
            }
          } else if (header.name === "items.ndjson") {
            const text = buf.toString("utf-8").trimEnd();
            if (text) {
              itemLines.push(...text.split("\n"));
            }
          } else if (header.name === "edges.ndjson") {
            const text = buf.toString("utf-8").trimEnd();
            if (text) {
              edgeLines.push(...text.split("\n"));
            }
          } else if (header.name === "types.ndjson") {
            const text = buf.toString("utf-8").trimEnd();
            if (text) {
              typeLines.push(...text.split("\n"));
            }
          }

          next();
        });
        stream.resume();
      });
      extract.on("finish", () => {
        resolve();
      });
    });

    // The spools this request wrote are its to remove on a refusal, up to
    // the point `restoreArchiveBlobs` takes them: past it, each is either
    // in the store under its name or already gone.
    const refuse = async (err: unknown): Promise<never> => {
      for (const spool of spools) await rm(spool, { force: true });
      throw err;
    };

    inputStream.pipe(gunzip).pipe(extract);
    try {
      await entries;
    } catch (err) {
      // A refusal mid-read leaves the decompressor holding the body and the
      // reader waiting on an entry that will never be taken; both are let go
      // here rather than left for the collector.
      inputStream.destroy();
      gunzip.destroy();
      extract.destroy();
      return refuse(err);
    }
    await rm(bodySpool, { force: true });

    const items: { item: Record<string, unknown>; metadata?: unknown }[] = [];
    for (const line of itemLines) {
      try {
        const parsed = JSON.parse(line) as {
          item: Record<string, unknown>;
          metadata?: unknown;
        };
        items.push(parsed);
      } catch {
        // Skip malformed lines; the round-trip export always emits valid
        // JSON so a bad line means the archive was hand-edited.
      }
    }

    const edges: Record<string, unknown>[] = [];
    for (const line of edgeLines) {
      try {
        const parsed = JSON.parse(line) as {
          edge?: Record<string, unknown>;
        };
        if (parsed.edge) {
          edges.push(parsed.edge);
        }
      } catch {
        // Same rule as item lines.
      }
    }

    if (items.length > MAX_ARCHIVE_ITEMS) {
      return refuse(
        new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `Maximum ${String(MAX_ARCHIVE_ITEMS)} items per archive`,
        ),
      );
    }
    if (edges.length > MAX_ARCHIVE_EDGES) {
      return refuse(
        new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `Maximum ${String(MAX_ARCHIVE_EDGES)} edges per archive`,
        ),
      );
    }

    // A row whose `source` claims a reserved credential shape is refused,
    // on the same terms and for the same reason as the state check below:
    // the restore is the one door that copies `source` verbatim, and
    // `POST /keys` refuses those prefixes precisely so no credential can
    // stamp one. A row carrying `connector:` would otherwise read, ever
    // after, as written by a connector that never existed — planted
    // through the one door that does not ask.
    for (const { item } of items) {
      const source = item.source;
      if (typeof source === "string" && isReservedCredentialSource(source)) {
        return refuse(
          new MarfaError(
            ErrorCode.VALIDATION_ERROR,
            `Item ${String(item.id)} records a source no credential can hold: ${source}`,
            { item_id: item.id, source },
          ),
        );
      }
    }

    // A row in a state its type's lifecycle cannot produce is refused, the
    // question `POST /items` asks of a caller: `trashed` is a state, and
    // not one a `system.*` row can be in, and a restore that wrote it would
    // land a row nothing can purge, restore or move. Only an absent state
    // (the default) and the default itself pass without the question,
    // since the store would write whatever else the line carried. The
    // whole archive is refused, before anything is written, so the answer
    // is never half a restore.
    for (const { item } of items) {
      const state = item.state;
      if (
        state === undefined ||
        state === null ||
        state === SYSTEM_DEFAULT_STATE
      ) {
        continue;
      }
      const error = validateTransition(
        String(item.type),
        SYSTEM_DEFAULT_STATE,
        state as ItemState,
      );
      if (error) {
        return refuse(
          new MarfaError(
            ErrorCode.VALIDATION_ERROR,
            `Item ${String(item.id)} of type ${String(item.type)} is recorded in a state its lifecycle cannot produce: ${error}`,
          ),
        );
      }
    }

    const typeEntries: ArchiveTypeEntry[] = [];
    for (const line of typeLines) {
      try {
        typeEntries.push(JSON.parse(line) as ArchiveTypeEntry);
      } catch {
        // Same rule as item and edge lines: the exporter always emits
        // valid JSON, so a bad line means the archive was hand-edited.
      }
    }

    // Before the transaction, so a rollback cannot strand the registry
    // holding types the database no longer has. See registerArchiveTypes.
    let typeResult;
    try {
      typeResult = await registerArchiveTypes(storage, typeEntries);
    } catch (err) {
      return refuse(err);
    }

    // A row carrying a property no type declares is refused wherever the
    // strict-mode lever names that type, which is the question
    // `POST /items` asks of a caller. This door writes through the store,
    // where validation runs loose, so the question has to be asked here
    // or not at all — and a property that lands reads back ever after
    // undeclared and unmarked under the type's current version. Refused
    // whole, and after the archive's own type registrations so a type
    // this instance is learning from the archive is measured against the
    // declaration it arrives with, but before any blob or row is
    // written.
    const archiveEnforcement = resolveEnforcement(
      await readInstanceConfig(storage.settings),
      c.get("apiKey"),
    );
    for (const { item } of items) {
      const refusal = undeclaredPropertyRefusal(
        archiveEnforcement,
        String(item.type),
        (item.properties ?? {}) as Record<string, unknown>,
        { item_id: item.id },
      );
      if (refusal) return refuse(refusal);
    }

    // Blobs land only once every refusal above has passed, so an archive
    // this route goes on to reject has not touched the store. They are still
    // outside the transaction, because a rollback cannot reach a filesystem
    // or an object store, and this request takes back exactly what it wrote.
    const restoredBlobs = await restoreArchiveBlobs(
      storage,
      blobs,
      pendingBlobs,
    );

    // Filled inside the transaction, announced after it commits.
    const restoredItems: { item: Item; metadata: Metadata }[] = [];
    const restoredEdges: Edge[] = [];
    let result;
    try {
      result = await storage.runInTransaction(async () => {
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
        // collided — a collision means the database already holds
        // that exact id, so edges naming it still land correctly.
        const resolvableIds = new Set<string>();

        for (const { item, metadata: meta } of items) {
          const archiveId = typeof item.id === "string" ? item.id : undefined;
          try {
            const created = await storage.items.create({
              ...(archiveId !== undefined && { id: archiveId }),
              // The row comes back under its archived id, so it comes
              // back at its archived version too. Re-minting at 1 lets a
              // client's stale precondition pass, later, against content
              // it never read from.
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
            });
            imported++;
            resolvableIds.add(created.id);

            // One write for the whole set, not one per namespace. Each
            // `setExtension` rewrites the same JSON column and bumps the
            // item's modification time beside it, so writing them
            // separately cost namespaces times items on the one path
            // whose purpose is moving a lot of rows at once. What is
            // stored is identical either way.
            const extensions = archiveExtensions(meta);
            const { extensions: stored, updated_at } =
              await storage.metadata.setExtensions(created.id, extensions);
            // Collected, not announced — for the same reason as the edges
            // below. A rollback would take the row away and the
            // `event_log` append with it, leaving a live subscriber
            // holding a frame no replay can repair.
            restoredItems.push({
              // The extensions write bumps the item's modification time,
              // and `created` was read before it ran. Announcing that
              // frame would publish an `updated_at` the row does not
              // carry: a client watermarking on it re-fetches on its next
              // catch-up, and one comparing it against a later read sees
              // a change nothing told it about.
              item: updated_at ? { ...created, updated_at } : created,
              metadata: {
                item_id: created.id,
                // `archiveTags` answers `undefined` for "the archive named
                // none", which is what `create` wants and what a `Metadata`
                // cannot hold — an item with no tags carries an empty list.
                tags: archiveTags(meta) ?? [],
                extensions: stored,
              },
            });
          } catch (err) {
            // A link held by another row names the same vendor record, as a
            // natural key held does.
            if (
              err instanceof MarfaError &&
              (err.code === ErrorCode.DUPLICATE_SOURCE ||
                err.code === ErrorCode.CONFLICT ||
                err.code === ErrorCode.LINK_TAKEN)
            ) {
              duplicates++;
              // A duplicate leaves the existing row untouched — its tags
              // and extensions are the live state, not the archive's.
              if (err.code === ErrorCode.CONFLICT && archiveId !== undefined) {
                resolvableIds.add(archiveId);
              }
            } else {
              throw err;
            }
          }
        }

        // Second pass, after every item the archive carries exists: an
        // edge restores only when both endpoints resolve in the database,
        // so a partial or hand-edited archive cannot plant a
        // reference to an item that is not there.
        const endpointResolves = async (id: string): Promise<boolean> =>
          resolvableIds.has(id) || (await storage.items.get(id)) !== null;

        for (const edge of edges) {
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
            // Already present under the same id — a re-restore, not an error.
            skipEdge("already_present");
            continue;
          }
          // An archive is a file someone can hand you: replayed through the
          // raw insert, a hand-edited one could plant edges of an
          // unregistered type, or edges violating every constraint the
          // enforcer exists to apply, past checks the API refuses at. It is
          // validated exactly the way `POST /edges` validates, one edge at a
          // time: the batch entry point throws on its first violation, which
          // would cost the whole restore over one bad line, and this route's
          // contract is to skip and count.
          //
          // Registered edge types resolve because the archive's own
          // registrations are replayed before this loop runs. `replay` lets a
          // revoked folder keep the placements it held before its revoke.
          try {
            await assertEdgesCanBeCreated(
              storage.edges,
              storage.items,
              [
                {
                  source_id: sourceId,
                  target_id: targetId,
                  edge_type: edgeType,
                  properties: (edge.properties ?? {}) as Record<
                    string,
                    unknown
                  >,
                },
              ],
              // A restore replays every row the archive holds, so no target
              // is one to withhold; the operator's own map reaches no type.
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
          const restored = await storage.edges.createRaw({
            ...(edgeId !== undefined && { id: edgeId }),
            // Same rule as the item path above. Both doors move together
            // or the hole stays reachable through the other one.
            ...(typeof edge.version === "number" && {
              version: edge.version,
            }),
            source_id: sourceId,
            target_id: targetId,
            edge_type: edgeType,
            properties: (edge.properties ?? {}) as Record<string, unknown>,
          });
          // Collected, not announced. This runs inside the restore's
          // transaction, and a later edge failing rolls the whole import
          // back — including the `event_log` append, so a replay cannot
          // repair a frame a live subscriber already received.
          restoredEdges.push(restored);
          edgesImported++;
        }

        return {
          imported,
          duplicates,
          edgesImported,
          edgesSkipped,
          edgesSkippedReasons,
        };
      });
    } catch (err) {
      // The write is what this request did; the rollback is what the database
      // did. Nothing sweeps a blob whose restore was refused, so the undo is
      // the only thing that keeps a failed restore from leaving the blob
      // store permanently larger.
      await restoredBlobs.undo();
      throw err;
    }

    // After the transaction committed. A restore is a write like any
    // other from a subscriber's side: a client connected while an archive
    // is restored has to learn about the rows it wrote, and nothing later
    // repairs a gap here — the event log is the only catch-up there is.
    //
    // Items before edges, because an edge names two endpoints and a client
    // receiving one for a row it has never heard of has no way to resolve
    // it.
    //
    // Fan-out is declined, as it is on every other door that writes in
    // bulk. A restore carries up to `MAX_ARCHIVE_ITEMS` rows, and driving
    // outbound work per row per subscribed connection would push an
    // archive's worth of writes back out to whatever an installed
    // bidirectional connection is joined to — work nobody asked for, and
    // work a restore is the least likely write to want. The flag governs
    // only the outbound side effects: the log row and the stream frame
    // land either way, which is the whole point of announcing these at
    // all. It rides the persisted row too, so a catch-up that rebuilds
    // these events reaches the same answer.
    for (const { item, metadata } of restoredItems) {
      await publish({
        type: "created",
        item,
        metadata,
        enableFanout: false,
      });
    }
    for (const edge of restoredEdges) {
      await publishEdge({
        type: "edge_created",
        edge,
        enableFanout: false,
      });
    }

    await storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: c.get("apiKey")?.id,
      action: "admin.restore_archive",
      resource_type: "admin.restore_archive",
      details: {
        imported: result.imported,
        duplicates: result.duplicates,
        edges_imported: result.edgesImported,
        edges_skipped: result.edgesSkipped,
        edges_skipped_reasons: result.edgesSkippedReasons,
        blobs_imported: blobCount,
        types_registered: typeResult.typesRegistered,
        types_skipped: typeResult.typesSkipped,
        edge_types_registered: typeResult.edgeTypesRegistered,
        edge_types_skipped: typeResult.edgeTypesSkipped,
        total_items: items.length,
        total_edges: edges.length,
      },
    });

    return c.json(
      {
        imported: result.imported,
        duplicates: result.duplicates,
        edges_imported: result.edgesImported,
        edges_skipped: result.edgesSkipped,
        edges_skipped_reasons: result.edgesSkippedReasons,
        blobs_imported: blobCount,
        types_registered: typeResult.typesRegistered,
        types_skipped: typeResult.typesSkipped,
        edge_types_registered: typeResult.edgeTypesRegistered,
        edge_types_skipped: typeResult.edgeTypesSkipped,
      },
      200,
    );
  });

  return router;
}
