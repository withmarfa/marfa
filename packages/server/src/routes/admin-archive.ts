/**
 * POST /admin/restore-archive — admin-only, tar.gz body.
 *
 * Lifts the archive-import behaviour that used to live at
 * POST /import?format=archive into a dedicated endpoint. Content-type is
 * `application/gzip` (not JSON); response is `{imported, duplicates,
 * blobs_imported}`. Preserves the manifest v1 contract, blob-hash
 * verification, and the item-import transaction boundary the original
 * handler had.
 *
 * Paired with GET /export?format=archive, which stays where it is.
 */

import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { createRoute, z } from "@hono/zod-openapi";
import * as tar from "tar-stream";
import { MymeError, ErrorCode, isValidBlobHash } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { BlobBackend } from "../storage/blob-backend.js";
import { createOpenAPIRouter, ErrorResponseSchema } from "../openapi.js";
import { constantTimeEqual } from "../utils/crypto.js";

const MAX_ARCHIVE_ITEMS = 5000;

interface ArchiveManifest {
  version: number;
  format: string;
  created_at: string;
  item_count: number;
  blob_count: number;
  blobs: Record<string, { mime_type: string; size: number }>;
}

const restoreArchiveRoute = createRoute({
  method: "post",
  path: "/restore-archive",
  tags: ["Admin"],
  summary: "Restore items and blobs from a myme-archive-v1 tar.gz (admin only)",
  security: [{ bearerAuth: [] }],
  request: {
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
            blobs_imported: z.number(),
          }),
        },
      },
      description: "Restore result",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid archive or unsupported version",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Admin required",
    },
  },
});

export function adminArchiveRoutes(storage: Storage, blobBackend: BlobBackend) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(restoreArchiveRoute, async (c) => {
    requireAdmin(c);

    const rawBody = await c.req.arrayBuffer();
    if (rawBody.byteLength === 0) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Empty archive");
    }

    let manifest: ArchiveManifest | null = null;
    const itemLines: string[] = [];
    const blobUploads: Promise<void>[] = [];
    let blobCount = 0;
    // T-049: archive restore lands blobs under the calling admin's tenant
    // scope. Empty-string sentinel for platform admins on single-tenant
    // self-hosts. Cross-tenant restore (platform admin restoring into a
    // specific tenant) is the T-053 follow-up; for now, the calling
    // admin's tenant_id wins.
    const restoreTenantId = c.get("apiKey")?.tenant_id ?? "";

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
                  new MymeError(
                    ErrorCode.VALIDATION_ERROR,
                    `Unsupported archive version: ${String(manifest.version)}`,
                  ),
                );
                return;
              }
            } catch (err) {
              if (err instanceof MymeError) {
                reject(err);
                return;
              }
              reject(
                new MymeError(
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
                        restoreTenantId,
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

    await Promise.all(blobUploads);

    const tenantId = c.get("apiKey")?.tenant_id;
    const items: Record<string, unknown>[] = [];
    for (const line of itemLines) {
      try {
        const parsed = JSON.parse(line) as {
          item: Record<string, unknown>;
          metadata?: unknown;
        };
        items.push(parsed.item);
      } catch {
        // Skip malformed lines; the round-trip export always emits valid
        // JSON so a bad line means the archive was hand-edited.
      }
    }

    if (items.length > MAX_ARCHIVE_ITEMS) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        `Maximum ${String(MAX_ARCHIVE_ITEMS)} items per archive`,
      );
    }

    const result = await storage.runInTransaction(async () => {
      let imported = 0;
      let duplicates = 0;

      for (const item of items) {
        try {
          await storage.items.create(
            {
              type: item.type as string,
              properties: (item.properties ?? {}) as Record<string, unknown>,
              source: item.source as string | undefined,
              source_id: item.source_id as string | undefined,
              tags: item.tags as string[] | undefined,
            },
            tenantId,
          );
          imported++;
        } catch (err) {
          if (
            err instanceof MymeError &&
            err.code === ErrorCode.DUPLICATE_SOURCE
          ) {
            duplicates++;
          } else {
            throw err;
          }
        }
      }

      return { imported, duplicates };
    });

    await storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "admin.restore_archive",
      resource_type: "admin.restore_archive",
      details: {
        imported: result.imported,
        duplicates: result.duplicates,
        blobs_imported: blobCount,
        total_items: items.length,
      },
    });

    return c.json(
      {
        imported: result.imported,
        duplicates: result.duplicates,
        blobs_imported: blobCount,
      },
      200,
    );
  });

  return router;
}
