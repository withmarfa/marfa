/**
 * POST /admin/restore-archive — admin-only, tar.gz body.
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
 * reference to an item it does not carry. Version history, created_at
 * and updated_at are re-stamped, not carried.
 *
 * Paired with GET /export?format=archive.
 */

import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { createRoute, z } from "@hono/zod-openapi";
import * as tar from "tar-stream";
import { MarfaError, ErrorCode, isValidBlobHash } from "@withmarfa/shared";
import type { ItemState, Tier } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { BlobBackend } from "../storage/blob-backend.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { constantTimeEqual } from "../utils/crypto.js";

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
   * field restores as null, so single-space self-host archives keep working.
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
  summary: "Restore items, edges, metadata, and blobs from an archive",
  description:
    "Ingests a `marfa-archive-v1.tar.gz` produced by `GET /export?format=archive`. Item ids are preserved so restored edges resolve; an id or natural-key collision counts as a duplicate and leaves the existing row untouched. Tags and extensions restore with their items; edges restore in a second pass, skipped (and counted) when either endpoint does not resolve in the restore space. Version history and row timestamps are re-stamped, not carried.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      // Platform admins targeting a specific space pass an explicit
      // `?target_space_id=<id>`. Space-bound admins (space_admin /
      // admin with space_id) may not override — the manifest
      // space_id must match their own space.
      target_space_id: z
        .string()
        .optional()
        .describe(
          "Platform admins set the space to restore into; space-bound admins must match their own space.",
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
            blobs_imported: z.number(),
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
  },
});

export function adminArchiveRoutes(storage: Storage, blobBackend: BlobBackend) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(restoreArchiveRoute, async (c) => {
    const callerKey = requireAdmin(c);
    const { target_space_id: targetSpaceParam } = c.req.valid("query");

    const rawBody = await c.req.arrayBuffer();
    if (rawBody.byteLength === 0) {
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Empty archive");
    }

    let manifest: ArchiveManifest | null = null;
    const itemLines: string[] = [];
    const edgeLines: string[] = [];
    const blobUploads: Promise<void>[] = [];
    let blobCount = 0;
    // Resolve the space under which the archive will be restored.
    // Space-bound admins use their own space; platform admins (no
    // space_id on the key) MUST pass `target_space_id` explicitly.
    // The empty-string sentinel still applies for single-space
    // self-hosts (platform admin without a target param on a
    // deployment whose archive has space_id = null).
    const callerSpace = callerKey.space_id;
    let restoreSpaceId: string;
    if (callerSpace) {
      if (targetSpaceParam !== undefined && targetSpaceParam !== callerSpace) {
        throw new MarfaError(
          ErrorCode.FORBIDDEN,
          "Cannot restore into another space — target_space_id must match caller's space_id (or be omitted).",
        );
      }
      restoreSpaceId = callerSpace;
    } else {
      // Platform admin. target_space_id present → scope to it.
      // Absent → empty-string sentinel (single-space self-host).
      restoreSpaceId = targetSpaceParam ?? "";
    }

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
                blobUploads.push(
                  blobBackend
                    .put(hash, buf, mimeType)
                    .then(() =>
                      storage.blobs.register(
                        hash,
                        mimeType,
                        buf.length,
                        hash,
                        restoreSpaceId,
                      ),
                    ),
                );
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
    //     or single-space self-host export. Allowed regardless of
    //     restore space (import semantics fall back to NULL space_id
    //     on items, matching the source shape).
    //   - manifest.space_id matches restoreSpaceId → expected
    //     same-space round-trip.
    //   - mismatch → reject. Platform admins bypass via the explicit
    //     `target_space_id` query param: their resolved
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
        `Archive manifest.space_id "${manifestSpaceId}" does not match restore space "${restoreSpaceId}". Platform admins must pass target_space_id matching the source.`,
      );
    }

    await Promise.all(blobUploads);

    // Items and blobs restore into the same resolved space. The
    // empty-string sentinel is a blobs-table convention only; the items
    // and edges layers use NULL for the single-space shape.
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

    const result = await storage.runInTransaction(async () => {
      let imported = 0;
      let duplicates = 0;
      let edgesImported = 0;
      let edgesSkipped = 0;

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

          for (const [namespace, data] of Object.entries(
            archiveExtensions(meta),
          )) {
            await storage.metadata.setExtension(created.id, namespace, data);
          }
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
          typeof edgeType !== "string" ||
          !(await endpointResolves(sourceId)) ||
          !(await endpointResolves(targetId))
        ) {
          edgesSkipped++;
          continue;
        }
        const edgeId = typeof edge.id === "string" ? edge.id : undefined;
        if (edgeId !== undefined && (await storage.edges.get(edgeId))) {
          // Already present under the same id — a re-restore, not an error.
          edgesSkipped++;
          continue;
        }
        await storage.edges.createRaw(
          {
            ...(edgeId !== undefined && { id: edgeId }),
            source_id: sourceId,
            target_id: targetId,
            edge_type: edgeType,
            properties: (edge.properties ?? {}) as Record<string, unknown>,
          },
          spaceId,
        );
        edgesImported++;
      }

      return { imported, duplicates, edgesImported, edgesSkipped };
    });

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
        blobs_imported: blobCount,
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
        blobs_imported: blobCount,
      },
      200,
    );
  });

  return router;
}
