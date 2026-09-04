import { createHash } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode, isValidBlobHash } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { withPreparedHeaders } from "../prepared-headers.js";
import { resolveBlobForSpace } from "../storage/blob-reader.js";
import type { ResolvedBlob } from "../storage/blob-reader.js";
import {
  requireAuth,
  requireAdmin,
  hasPlatformAuthority,
} from "../middleware/auth.js";
import type { ApiKey } from "@withmarfa/shared";
import { reserveQuota } from "../middleware/quota.js";
import { log } from "../middleware/logger.js";
import type { Storage } from "../storage/interface.js";
import type { BlobBackend } from "../storage/blob-backend.js";
import { collectBlobHashes } from "../storage/blob-utils.js";
import { withBlobUploadLock } from "../storage/blob-upload-lock.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const BlobUploadResponseSchema = z.object({
  hash: z.string(),
  mime_type: z.string(),
  size: z.number(),
});

const BlobUrlResponseSchema = z.object({
  url: z.string(),
  expires_in: z.number(),
});

const BlobCleanupResponseSchema = z.object({
  total_blobs: z.number(),
  referenced: z.number(),
  orphaned: z.number(),
  removed: z.number(),
  dry_run: z.boolean(),
});

const BlobReconcileResponseSchema = z.object({
  s3_total: z.number(),
  db_total: z.number(),
  healthy: z.number(),
  orphaned_s3: z.number(),
  missing_s3: z.number(),
  orphaned_s3_sample: z.array(z.string()),
  missing_s3_sample: z.array(z.string()),
  deleted: z.number(),
  dry_run: z.boolean(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const uploadBlobRoute = createRoute({
  operationId: "uploadBlob",
  method: "post",
  path: "/",
  tags: ["Blobs"],
  summary: "Upload a blob",
  description:
    "Uploads binary content and returns its `sha256:<hex>` content-addressed hash, accepting `multipart/form-data` or `application/octet-stream`. Uploads are idempotent — identical bytes return the existing hash without re-storing — and are capped at `MAX_BLOB_SIZE` (default 50 MB), over which they return `413 blob_too_large`.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "multipart/form-data": {
          schema: z.any(),
        },
        "application/octet-stream": {
          schema: z.any(),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: BlobUploadResponseSchema,
        },
      },
      description: "Blob uploaded",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
          ]),
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

const getBlobRoute = createRoute({
  operationId: "downloadBlob",
  method: "get",
  path: "/{hash}",
  tags: ["Blobs"],
  summary: "Download blob binary",
  description:
    "Streams the raw bytes for a previously-uploaded blob as `application/octet-stream`. Space-scoped — a hash uploaded in one space is invisible to another, so cross-space probes return 404.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      hash: z.string().describe("Content-addressed `sha256:<hex>` blob hash."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/octet-stream": {
          schema: z.any(),
        },
      },
      description: "Blob binary data",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "Invalid blob hash",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["blob_not_found"]),
        },
      },
      description: "Blob not found",
    },
  },
});

const getBlobUrlRoute = createRoute({
  operationId: "getBlobUrl",
  method: "get",
  path: "/{hash}/url",
  tags: ["Blobs"],
  summary: "Get a presigned download URL for a blob",
  description:
    "Returns a time-limited presigned URL pointing directly at the S3-compatible object store, so clients fetch the blob without proxying through the API. Available only when `BLOB_BACKEND=s3`; filesystem-backed deployments return `400` and must stream via `GET /blobs/{hash}`.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      hash: z.string().describe("Content-addressed `sha256:<hex>` blob hash."),
    }),
    query: z.object({
      ttl: z.coerce
        .number()
        .int()
        .min(1)
        .optional()
        .default(3600)
        .describe("URL lifetime in seconds."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: BlobUrlResponseSchema,
        },
      },
      description: "Presigned URL",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "Invalid blob hash or presigned URLs not available",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["blob_not_found"]),
        },
      },
      description: "Blob not found",
    },
  },
});

const cleanupBlobsRoute = createRoute({
  operationId: "cleanupBlobs",
  method: "post",
  path: "/cleanup",
  tags: ["Blobs"],
  summary: "Remove unreferenced blobs",
  description:
    "Removes blobs that nothing references. Live items, trashed items, metadata extensions, and version history all count as references. Admin-only; defaults to `dry_run=true`, so deletion requires an explicit `dry_run=false`.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      dry_run: z
        .enum(["true", "false"])
        .optional()
        .default("true")
        .describe(
          "Preview removals without deleting when `true` (the default); pass `false` to delete.",
        ),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: BlobCleanupResponseSchema,
        },
      },
      description: "Cleanup result",
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

const reconcileBlobsRoute = createRoute({
  operationId: "reconcileBlobs",
  method: "post",
  path: "/reconcile",
  tags: ["Blobs"],
  summary: "Reconcile blob storage",
  description:
    "Compares the blob storage backend against the database to find orphaned files (in storage, not the DB) and missing files (in the DB, not storage). Admin-only; defaults to `dry_run=true` for safety.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      dry_run: z
        .enum(["true", "false"])
        .optional()
        .default("true")
        .describe("Report only without deleting orphans when `true`."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: BlobReconcileResponseSchema,
        },
      },
      description: "Reconciliation result",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "Backend does not support listing",
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

/**
 * A reader's view of a blob, keyed on whether the credential is confined to
 * a space. The rule itself lives in `storage/blob-reader.ts`, shared with the
 * export path, which had the same shape and the old behavior.
 */
async function resolveBlobForReader(
  storage: Storage,
  apiKey: ApiKey,
  hash: string,
): Promise<ResolvedBlob | null> {
  return resolveBlobForSpace(
    storage,
    hasPlatformAuthority(apiKey) ? undefined : (apiKey.space_id ?? ""),
    hash,
  );
}

export function blobRoutes(
  storage: Storage,
  blobBackend: BlobBackend,
  maxBlobSize: number,
) {
  const router = createOpenAPIRouter<AppEnv>();

  // POST /blobs — upload blob
  router.openapi(uploadBlobRoute, async (c) => {
    requireAuth(c);

    // Cheap pre-read check: reject based on declared Content-Length before
    // buffering the body. Closes the "advertise huge body, force allocation"
    // case. Absent/invalid header falls through to the post-buffer check.
    const declaredLength = Number(c.req.header("Content-Length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBlobSize) {
      throw new MarfaError(
        ErrorCode.BLOB_TOO_LARGE,
        `Blob exceeds maximum size of ${String(maxBlobSize)} bytes`,
      );
    }

    const contentType =
      c.req.header("Content-Type") ?? "application/octet-stream";
    let data: Buffer;
    let mimeType: string;

    if (contentType.startsWith("multipart/form-data")) {
      const formData = await c.req.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          "Missing 'file' in multipart upload",
        );
      }
      data = Buffer.from(await file.arrayBuffer());
      mimeType = file.type || "application/octet-stream";
    } else {
      data = Buffer.from(await c.req.arrayBuffer());
      mimeType = (contentType.split(";")[0] ?? contentType).trim();
    }

    if (data.length === 0) {
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Empty blob");
    }

    if (data.length > maxBlobSize) {
      throw new MarfaError(
        ErrorCode.BLOB_TOO_LARGE,
        `Blob exceeds maximum size of ${String(maxBlobSize)} bytes`,
      );
    }

    // Compute content-addressed hash
    const hex = createHash("sha256").update(data).digest("hex");
    const hash = `sha256:${hex}`;

    // Both ceilings are reserved around the registration, not checked
    // before it. `storage_bytes` is the one that matters most here: it is
    // unbounded disk, so an overshoot costs real space rather than a row.
    //
    // The physical write happens inside the reservation too. Putting bytes
    // on disk that the registration then refuses would leak them, since
    // nothing sweeps an unregistered blob — and content addressing means a
    // later legitimate upload of the same bytes finds them already there.
    const blobSpaceId = c.get("apiKey")?.space_id ?? "";
    // Content addressing makes `existed` decide two things at once: whether
    // these bytes need writing, and whether a later refusal has anything to
    // undo. The second answer is only true while no other request can be
    // writing the same bytes, which is what the per-hash lock buys: taken
    // across the check, the write and the registration, `existed === false`
    // means this request wrote them and is the only one that may take them
    // back. Without it two spaces uploading identical bytes both read false,
    // and the one that is refused deletes the other's committed blob.
    await withBlobUploadLock(hash, async () => {
      const existed = await blobBackend.exists(hash);
      if (!existed) {
        await blobBackend.put(hash, data, mimeType);
      }
      try {
        await storage.runInTransaction(async () => {
          await reserveQuota(c, storage, [
            { resource: "blobs", increment: 1 },
            { resource: "storage_bytes", increment: data.length },
          ]);
          // Register the metadata row scoped to the caller's space. Empty-
          // string sentinel for instance-wide / single-space / platform-admin
          // uploads. Different spaces uploading the same hash bytes get
          // separate rows; the storage backend dedupes the physical file.
          await storage.blobs.register(
            hash,
            mimeType,
            data.length,
            hash,
            blobSpaceId,
          );
        });
      } catch (err) {
        // Refused, or the registration failed. An unregistered blob is
        // unreachable and nothing sweeps it, so undo this request's own put —
        // and only its own. A failure to undo leaves bytes behind rather than
        // failing the request a second time, so it is logged, not thrown: the
        // caller's error is the one worth surfacing.
        if (!existed) {
          try {
            await blobBackend.delete(hash);
          } catch (cleanupErr) {
            log("error", "blob.orphaned_after_refused_upload", {
              hash,
              size: data.length,
              error:
                cleanupErr instanceof Error
                  ? cleanupErr.message
                  : String(cleanupErr),
            });
          }
        }
        throw err;
      }
    });

    await storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "blob.upload",
      resource_type: "blob",
      resource_id: hash,
      details: { mime_type: mimeType, size: data.length },
    });

    return c.json({ hash, mime_type: mimeType, size: data.length }, 201);
  });

  // HEAD /blobs/:hash — check blob existence without downloading
  // HEAD is not supported by createRoute, use .on() directly
  router.on("HEAD", "/:hash", async (c) => {
    const apiKey = requireAuth(c);

    let hash = c.req.param("hash");
    if (!hash.startsWith("sha256:")) {
      hash = `sha256:${hash}`;
    }
    if (!isValidBlobHash(hash)) {
      return new Response(null, { status: 400 });
    }

    // Space-scoped lookup. Cross-space probes return 404.
    const record = await resolveBlobForReader(storage, apiKey, hash);
    if (!record) {
      return new Response(null, { status: 404 });
    }

    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": record.mime_type,
        "Content-Length": String(record.size),
      },
    });
  });

  // GET /blobs/:hash — download blob binary
  router.openapi(getBlobRoute, async (c) => {
    const apiKey = requireAuth(c);

    let hash = c.req.valid("param").hash;
    if (!hash.startsWith("sha256:")) {
      hash = `sha256:${hash}`;
    }
    if (!isValidBlobHash(hash)) {
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid blob hash");
    }

    // Space-scoped lookup. Cross-space probes return 404.
    const record = await resolveBlobForReader(storage, apiKey, hash);
    if (!record) {
      throw new MarfaError(ErrorCode.BLOB_NOT_FOUND, "Blob not found");
    }

    const data = await blobBackend.get(hash);
    if (!data) {
      throw new MarfaError(ErrorCode.BLOB_NOT_FOUND, "Blob data not found");
    }

    return withPreparedHeaders(
      c,
      new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          "Content-Type": record.mime_type,
          "Content-Length": String(data.length),
        },
      }),
    );
  });

  // GET /blobs/:hash/url — presigned download URL
  router.openapi(getBlobUrlRoute, async (c) => {
    const apiKey = requireAuth(c);

    if (!blobBackend.getPresignedUrl) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Presigned URLs are not available with the current blob backend",
      );
    }

    let hash = c.req.valid("param").hash;
    if (!hash.startsWith("sha256:")) {
      hash = `sha256:${hash}`;
    }
    if (!isValidBlobHash(hash)) {
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid blob hash");
    }

    // Space-scoped lookup. Cross-space probes return 404.
    const record = await resolveBlobForReader(storage, apiKey, hash);
    if (!record) {
      throw new MarfaError(ErrorCode.BLOB_NOT_FOUND, "Blob not found");
    }

    const { ttl } = c.req.valid("query");
    const url = await blobBackend.getPresignedUrl(hash, ttl);
    return c.json({ url, expires_in: ttl }, 200);
  });

  // POST /blobs/cleanup — remove unreferenced blobs (admin only)
  router.openapi(cleanupBlobsRoute, async (c) => {
    requireAdmin(c);

    const dryRun = c.req.valid("query").dry_run === "true";
    const spaceId = c.get("apiKey")?.space_id;

    // Collect all blob hashes registered in the store
    const allHashes = await storage.blobs.listAll();

    // Paginate through all items and extract every blob hash from properties
    const referencedHashes = new Set<string>();

    const scanItems = async (state?: string): Promise<void> => {
      let cursor: string | undefined;
      let hasMore = true;
      while (hasMore) {
        const page = await storage.items.list({
          spaceId,
          state: state as import("@withmarfa/shared").ItemState | undefined,
          limit: 200,
          cursor,
        });
        for (const item of page.data) {
          collectBlobHashes(item.properties, referencedHashes);
        }

        // Also scan metadata extensions for blob references
        const ids = page.data.map((item) => item.id);
        const metadataList = await storage.metadata.getMany(ids);
        for (const meta of metadataList) {
          collectBlobHashes(meta.extensions, referencedHashes);
        }
        cursor = page.cursor ?? undefined;
        hasMore = page.has_more;
      }
    };

    // Scan active items and trashed items (don't remove blobs still in trash)
    await scanItems();
    await scanItems("trashed");

    // A hash referenced only by a version snapshot is still referenced:
    // deleting it would strip the bytes out from under a version read.
    let versionCursor: string | undefined;
    for (;;) {
      const page = await storage.versions.scanProperties(200, versionCursor);
      for (const props of page.properties) {
        collectBlobHashes(props, referencedHashes);
      }
      if (!page.cursor) break;
      versionCursor = page.cursor;
    }

    const orphaned = allHashes.filter((h) => !referencedHashes.has(h));

    if (!dryRun) {
      for (const hash of orphaned) {
        await blobBackend.delete(hash);
        // Platform-admin orphan cleanup nukes the row in every space
        // — this hash is unreferenced everywhere as far as the admin's
        // visible items go.
        await storage.blobs.removeAllForHash(hash);
      }
    }

    return c.json(
      {
        total_blobs: allHashes.length,
        referenced: referencedHashes.size,
        orphaned: orphaned.length,
        removed: dryRun ? 0 : orphaned.length,
        dry_run: dryRun,
      },
      200,
    );
  });

  // POST /blobs/reconcile — compare storage backend against database (admin only)
  router.openapi(reconcileBlobsRoute, async (c) => {
    requireAdmin(c);

    if (!blobBackend.list) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Reconciliation requires a blob backend that supports listing",
      );
    }

    const dryRun = c.req.valid("query").dry_run !== "false";

    // Collect all keys from the storage backend
    const storageHashes = new Set<string>();
    for await (const hash of blobBackend.list()) {
      storageHashes.add(hash);
    }

    // Get all database records
    const dbHashes = new Set(await storage.blobs.listAll());

    // Compare both directions
    const orphanedStorage: string[] = [];
    const missingStorage: string[] = [];
    let healthy = 0;

    for (const hash of storageHashes) {
      if (dbHashes.has(hash)) {
        healthy++;
      } else {
        orphanedStorage.push(hash);
      }
    }

    for (const hash of dbHashes) {
      if (!storageHashes.has(hash)) {
        missingStorage.push(hash);
      }
    }

    // In execute mode, delete storage orphans
    let deleted = 0;
    if (!dryRun) {
      for (const hash of orphanedStorage) {
        await blobBackend.delete(hash);
        deleted++;
      }
    }

    await storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "blob.reconcile",
      resource_type: "blob",
      details: {
        s3_total: storageHashes.size,
        db_total: dbHashes.size,
        orphaned_s3: orphanedStorage.length,
        missing_s3: missingStorage.length,
        deleted,
        dry_run: dryRun,
      },
    });

    return c.json(
      {
        s3_total: storageHashes.size,
        db_total: dbHashes.size,
        healthy,
        orphaned_s3: orphanedStorage.length,
        missing_s3: missingStorage.length,
        orphaned_s3_sample: orphanedStorage.slice(0, 20),
        missing_s3_sample: missingStorage.slice(0, 20),
        deleted,
        dry_run: dryRun,
      },
      200,
    );
  });

  return router;
}
