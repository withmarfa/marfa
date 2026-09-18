/**
 * POST /admin/restore-archive — operator key only, tar.gz body.
 *
 * Dedicated archive-import endpoint. Content-type is
 * `application/gzip` (not JSON); response is `{imported, duplicates,
 * edges_imported, edges_skipped, blobs_imported}`. Enforces the
 * manifest v1 contract, blob-hash verification, and a single import
 * transaction covering items, metadata, and edges.
 *
 * Item ids are preserved from the archive so restored edges resolve;
 * an id or natural-key collision counts as a duplicate and leaves the
 * existing row untouched. Tags and extensions restore alongside their
 * items. Edges restore in a second pass, only where both endpoints
 * resolve in the restore space — a hand-edited archive cannot plant a
 * reference to an item it does not carry. A row comes back at the version
 * it was archived at; version history, created_at and updated_at are
 * re-stamped, not carried.
 *
 * Paired with GET /export?format=archive.
 */

import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { createRoute, z } from "@hono/zod-openapi";
import * as tar from "tar-stream";
import { MarfaError, ErrorCode, isValidBlobHash } from "@withmarfa/shared";
import { publish, publishEdge } from "../pubsub.js";
import type { Edge, Item, Metadata } from "@withmarfa/shared";
import type { ItemState, Tier } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireOperatorKey } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { BlobBackend } from "../storage/blob-backend.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { constantTimeEqual } from "../utils/crypto.js";
import { registerArchiveTypes } from "./admin-archive-types.js";
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

interface ArchiveManifest {
  version: number;
  format: string;
  created_at: string;
  /**
   * space_id stamped at export time. Used here to verify the importing
   * admin's authority over the source space. An archive without this
   * field restores as null, so an archive carrying no space keeps working.
   */
  space_id?: string | null;
  item_count: number;
  /** Absent on archives predating edge support; those restore with zero edges. */
  edge_count?: number;
  blob_count: number;
  blobs: Record<string, { mime_type: string; size: number }>;
}

const restoreArchiveRoute = createRoute({
  operationId: "adminRestoreArchive",
  method: "post",
  path: "/restore-archive",
  tags: ["Admin"],
  summary: "Restore types, items, edges, metadata, and blobs from an archive",
  description:
    "Ingests a `marfa-archive-v1.tar.gz` produced by `GET /export?format=archive`. The archive's custom type and edge-type registrations are validated and registered first, so a restore into an empty space can write the items that use them; a registration the target space already holds identically is skipped, and one it holds differently fails the whole restore with `409` naming every clashing id. Item ids are preserved so restored edges resolve; an id or natural-key collision counts as a duplicate and leaves the existing row untouched. Tags and extensions restore with their items; edges restore in a second pass, skipped (and counted) when either endpoint does not resolve in the restore space. A row comes back at the version it was archived at, for items and edges alike, so a client holding a version across a restore cannot have its precondition pass against content it never read. Version *history* — the per-version snapshots behind `GET /items/{id}?include=versions` — and row timestamps are re-stamped, not carried.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      // This route takes the operator key, which carries no space, so the
      // space to restore into is named here or the space-less bucket is used.
      // A space-bound caller cannot reach the route at all.
      target_space_id: z
        .string()
        .optional()
        .describe(
          "The space to restore into. This route takes the operator key, which carries no space of its own, so naming one here is how a space is chosen.",
        ),
    }),
    body: {
      content: {
        "application/gzip": {
          schema: z.any(),
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
            custom_types_registered: z.number(),
            custom_types_skipped: z.number(),
            custom_edge_types_registered: z.number(),
            custom_edge_types_skipped: z.number(),
          }),
        },
      },
      description: "Restore result",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "Invalid archive or unsupported version",
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
          schema: makeErrorResponseSchema(["conflict"]),
        },
      },
      description:
        "The archive redefines a type the target space already registers differently, or carries a core edge type. Nothing was written.",
    },
  },
});

interface PendingBlob {
  hash: string;
  mimeType: string;
  data: Buffer;
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
 * reason: content addressing means two spaces can be writing identical bytes
 * at once, so `exists` and the write have to be one step or the request that
 * is refused deletes the other's committed blob.
 */
async function restoreArchiveBlobs(
  storage: Storage,
  blobBackend: BlobBackend,
  pending: readonly PendingBlob[],
  spaceId: string,
): Promise<BlobRestore> {
  const wroteBytes: string[] = [];
  const wroteRows: string[] = [];

  // Bytes first, rows second, same as `POST /blobs`: a rollback cannot
  // reach a filesystem or an object store, so the bytes stay outside the
  // transaction and this request takes back what it wrote on refusal.
  for (const blob of pending) {
    await withBlobUploadLock(blob.hash, async () => {
      if (!(await blobBackend.exists(blob.hash))) {
        await blobBackend.put(blob.hash, blob.data, blob.mimeType);
        wroteBytes.push(blob.hash);
      }
    });
  }

  const undoBytes = async (): Promise<void> => {
    for (const hash of wroteBytes) {
      await withBlobUploadLock(hash, async () => {
        try {
          if ((await storage.blobs.getAcrossSpaces(hash)) !== null) return;
          await blobBackend.delete(hash);
        } catch (err) {
          log("error", "blob.orphaned_after_refused_restore", {
            hash,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }
  };

  // The rows commit as one transaction, so a failure rolls every row back
  // at once.
  try {
    await storage.runInTransaction(async () => {
      const planned: PendingBlob[] = [];
      for (const blob of pending) {
        if ((await storage.blobs.get(blob.hash, spaceId)) === null) {
          planned.push(blob);
        }
      }
      if (planned.length === 0) return;
      for (const blob of planned) {
        await storage.blobs.register(
          blob.hash,
          blob.mimeType,
          blob.data.length,
          blob.hash,
          spaceId,
        );
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
          await storage.blobs.remove(hash, spaceId);
        } catch (err) {
          log("error", "blob.row_orphaned_after_refused_restore", {
            hash,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Another space may have registered these same bytes in the
      // meantime, and content addressing means its row describes the file
      // this request happens to have written; `undoBytes` re-checks under
      // the per-hash lock before deleting.
      await undoBytes();
    },
  };
}

export function adminArchiveRoutes(storage: Storage, blobBackend: BlobBackend) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(restoreArchiveRoute, async (c) => {
    requireOperatorKey(c);
    const { target_space_id: targetSpaceParam } = c.req.valid("query");

    const rawBody = await c.req.arrayBuffer();
    if (rawBody.byteLength === 0) {
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Empty archive");
    }

    let manifest: ArchiveManifest | null = null;
    const itemLines: string[] = [];
    const edgeLines: string[] = [];
    const typeLines: string[] = [];
    const pendingBlobs: { hash: string; mimeType: string; data: Buffer }[] = [];
    let blobCount = 0;
    // Resolve the space the archive restores into. The caller is the operator
    // key and nothing else — `requireOperatorKey` above admits only a
    // credential with the operator flag and no space, which the row constraint
    // holds together — so there is no caller space to fall back on and
    // `target_space_id` is how a space is named.
    //
    // **A branch reading the caller's own space used to stand here**, refusing
    // a target that disagreed with it. It described a space-bound admin, which
    // is not a shape any credential can now have on this route: the space-less
    // half of the operator gate makes it unreachable rather than merely rare.
    //
    // Absent → the empty-string sentinel, which is what a deployment whose
    // archive rows carry no space wrote them under.
    const restoreSpaceId: string = targetSpaceParam ?? "";

    const extract = tar.extract();
    const gunzip = createGunzip();

    const entries = new Promise<void>((resolve, reject) => {
      extract.on("entry", (header, stream, next) => {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          const buf = Buffer.concat(chunks);

          if (header.name === "manifest.json") {
            try {
              manifest = JSON.parse(buf.toString("utf-8")) as ArchiveManifest;
              if (manifest.version !== 1) {
                reject(
                  new MarfaError(
                    ErrorCode.VALIDATION_ERROR,
                    `Unsupported archive version: ${String(manifest.version)}`,
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
          } else if (header.name.startsWith("blobs/")) {
            const hash = header.name.slice("blobs/".length);
            if (isValidBlobHash(hash)) {
              const hex = createHash("sha256").update(buf).digest("hex");
              const computed = `sha256:${hex}`;
              if (constantTimeEqual(computed, hash)) {
                blobCount++;
                const mimeType =
                  manifest?.blobs[hash]?.mime_type ??
                  "application/octet-stream";
                pendingBlobs.push({ hash, mimeType, data: buf });
              }
            }
          }

          next();
        });
        stream.resume();
      });
      extract.on("finish", () => {
        resolve();
      });
      extract.on("error", reject);
    });

    const inputStream = Readable.from(Buffer.from(rawBody));
    inputStream.pipe(gunzip).pipe(extract);
    await entries;

    // Verify manifest.space_id against the resolved restore space.
    // Three legitimate shapes:
    //   - manifest.space_id is null/undefined → an unspaceed archive
    //     or an export carrying no space. Allowed regardless of
    //     restore space (import semantics fall back to NULL space_id
    //     on items, matching the source shape).
    //   - manifest.space_id matches restoreSpaceId → expected
    //     same-space round-trip.
    //   - mismatch → reject. The operator key gets past this via the
    //     explicit `target_space_id` query param: its resolved
    //     restoreSpaceId then equals the manifest, landing in the
    //     matching branch above.
    // Closure-modified `manifest` — TS doesn't narrow through the
    // entry-handler closure, so cast back to the declared type for
    // the access. Null when no manifest.json was present (defensive;
    // an invalid archive structure is rejected on parse).
    const m = manifest as ArchiveManifest | null;
    const manifestSpaceId = m?.space_id ?? null;
    if (manifestSpaceId !== null && manifestSpaceId !== restoreSpaceId) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        `Archive manifest.space_id "${manifestSpaceId}" does not match restore space "${restoreSpaceId}". The operator key must pass target_space_id matching the source.`,
      );
    }

    // Items and blobs restore into the same resolved space. The
    // empty-string sentinel is a blobs-table convention only; the items
    // and edges layers use NULL for the space-less shape.
    const spaceId = restoreSpaceId || undefined;

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
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Maximum ${String(MAX_ARCHIVE_ITEMS)} items per archive`,
      );
    }
    if (edges.length > MAX_ARCHIVE_EDGES) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Maximum ${String(MAX_ARCHIVE_EDGES)} edges per archive`,
      );
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
    const typeResult = await registerArchiveTypes(
      storage,
      typeEntries,
      spaceId,
    );

    // Blobs land only once every refusal above has passed. They used to be
    // written as the tar was read, which put bytes AND `blobs` rows into the
    // target space ahead of the space-mismatch refusal, the count caps and
    // the type-conflict refusal — so an archive this route went on to reject
    // had already mutated the space's blob store and the quota those rows
    // count toward. They are still outside the transaction, because a
    // rollback cannot reach a filesystem or an object store; what changes is
    // that this request now takes back exactly what it wrote.
    const blobs = await restoreArchiveBlobs(
      storage,
      blobBackend,
      pendingBlobs,
      restoreSpaceId,
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
        // collided — a collision means the restore space already holds
        // that exact id, so edges naming it still land correctly.
        const resolvableIds = new Set<string>();

        for (const { item, metadata: meta } of items) {
          const archiveId = typeof item.id === "string" ? item.id : undefined;
          try {
            const created = await storage.items.create(
              {
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
                timestamp: item.timestamp as string | undefined,
                source: item.source as string | undefined,
                source_id: item.source_id as string | undefined,
                device: item.device as string | undefined,
                capture_latitude: item.capture_latitude as number | undefined,
                capture_longitude: item.capture_longitude as number | undefined,
                tags: archiveTags(meta),
              },
              spaceId,
            );
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
            if (
              err instanceof MarfaError &&
              (err.code === ErrorCode.DUPLICATE_SOURCE ||
                err.code === ErrorCode.CONFLICT)
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
        // edge restores only when both endpoints resolve in the restore
        // space, so a partial or hand-edited archive cannot plant a
        // reference to an item that is not there.
        const endpointResolves = async (id: string): Promise<boolean> =>
          resolvableIds.has(id) ||
          (await storage.items.get(id, spaceId)) !== null;

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
          // An archive is a file someone can hand you, and replaying it
          // through the raw insert meant a hand-edited one could plant edges
          // of an unregistered type, or edges violating every constraint the
          // enforcer exists to apply, past checks the API refuses at. It is
          // validated exactly the way `POST /edges` validates, one edge at a
          // time: the batch entry point throws on its first violation, which
          // would cost the whole restore over one bad line, and this route's
          // contract is to skip and count.
          //
          // Custom edge types resolve because the archive's own registrations
          // are replayed before this loop runs.
          try {
            await assertEdgesCanBeCreated(
              storage.edges,
              storage.items,
              [
                {
                  source_id: sourceId,
                  target_id: targetId,
                  edge_type: edgeType,
                },
              ],
              { space_id: spaceId },
            );
          } catch (err) {
            if (err instanceof MarfaError) {
              skipEdge(err.code);
              continue;
            }
            throw err;
          }
          const restored = await storage.edges.createRaw(
            {
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
            },
            spaceId,
          );
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
      // the only thing that keeps a failed restore from leaving the space
      // permanently larger.
      await blobs.undo();
      throw err;
    }

    // After the transaction committed. A restore is a write like any
    // other from a subscriber's side: a client connected while an archive
    // is restored has to learn about the rows it wrote, and nothing later
    // repairs a gap here — the event log is the only catch-up there is.
    //
    // Items before edges, because an edge names two endpoints and a client
    // receiving one for a row it has never heard of has no way to resolve
    // it. Announcing only the edges was worse than announcing neither for
    // exactly that reason.
    //
    // Fan-out is declined, as it is on every other door that writes in
    // bulk. A restore carries up to `MAX_ARCHIVE_ITEMS` rows, and driving
    // outbound work per row per subscribed connection would push an
    // archive's worth of writes back out to whatever an installed
    // bidirectional connection is joined to — work nobody asked for, and
    // work a restore is the least likely write to want. The flag governs
    // only the outbound side effects: the log row and the stream frame
    // land either way, which is the whole point of announcing these at
    // all. It rides the persisted row too, so a drainer elected in
    // another process reaches the same answer.
    for (const { item, metadata } of restoredItems) {
      await publish({
        type: "created",
        item,
        metadata,
        spaceId,
        enableFanout: false,
      });
    }
    for (const edge of restoredEdges) {
      await publishEdge({
        type: "edge_created",
        edge,
        spaceId,
        enableFanout: false,
      });
    }

    await storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: spaceId ?? null,
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
        custom_types_registered: typeResult.typesRegistered,
        custom_types_skipped: typeResult.typesSkipped,
        custom_edge_types_registered: typeResult.edgeTypesRegistered,
        custom_edge_types_skipped: typeResult.edgeTypesSkipped,
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
        custom_types_registered: typeResult.typesRegistered,
        custom_types_skipped: typeResult.typesSkipped,
        custom_edge_types_registered: typeResult.edgeTypesRegistered,
        custom_edge_types_skipped: typeResult.edgeTypesSkipped,
      },
      200,
    );
  });

  return router;
}
