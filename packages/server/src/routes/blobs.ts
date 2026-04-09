import { createHash } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { MymeError, ErrorCode, isValidBlobHash } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { BlobBackend } from "../storage/blob-backend.js";
import { collectBlobHashes } from "../storage/blob-utils.js";
import { createOpenAPIRouter, ErrorResponseSchema } from "../openapi.js";

const MAX_BLOB_SIZE = Number(process.env.MAX_BLOB_SIZE) || 50 * 1024 * 1024; // 50MB default

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
  method: "post",
  path: "/",
  tags: ["Blobs"],
  summary: "Upload a blob (multipart or raw binary)",
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Validation error",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
});

const getBlobRoute = createRoute({
  method: "get",
  path: "/{hash}",
  tags: ["Blobs"],
  summary: "Download blob binary",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      hash: z.string(),
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid blob hash",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Blob not found",
    },
  },
});

const getBlobUrlRoute = createRoute({
  method: "get",
  path: "/{hash}/url",
  tags: ["Blobs"],
  summary: "Get a presigned download URL for a blob",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      hash: z.string(),
    }),
    query: z.object({
      ttl: z.coerce.number().int().min(1).optional().default(3600),
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid blob hash or presigned URLs not available",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Blob not found",
    },
  },
});

const cleanupBlobsRoute = createRoute({
  method: "post",
  path: "/cleanup",
  tags: ["Blobs"],
  summary: "Remove unreferenced blobs (admin only)",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      dry_run: z.enum(["true", "false"]).optional().default("false"),
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
});

const reconcileBlobsRoute = createRoute({
  method: "post",
  path: "/reconcile",
  tags: ["Blobs"],
  summary: "Reconcile blob storage against database (admin only)",
  description:
    "Compares the blob storage backend against the database to find " +
    "orphaned files (in storage but not DB) and missing files (in DB but " +
    "not storage). Defaults to dry_run=true for safety.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      dry_run: z.enum(["true", "false"]).optional().default("true"),
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Backend does not support listing",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function blobRoutes(storage: Storage, blobBackend: BlobBackend) {
  const router = createOpenAPIRouter<AppEnv>();

  // POST /blobs — upload blob
  router.openapi(uploadBlobRoute, async (c) => {
    requireAuth(c);

    const contentType =
      c.req.header("Content-Type") ?? "application/octet-stream";
    let data: Buffer;
    let mimeType: string;

    if (contentType.startsWith("multipart/form-data")) {
      const formData = await c.req.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        throw new MymeError(
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
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Empty blob");
    }

    if (data.length > MAX_BLOB_SIZE) {
      throw new MymeError(
        ErrorCode.BLOB_TOO_LARGE,
        `Blob exceeds maximum size of ${String(MAX_BLOB_SIZE)} bytes`,
      );
    }

    // Compute content-addressed hash
    const hex = createHash("sha256").update(data).digest("hex");
    const hash = `sha256:${hex}`;

    // Store if not already present
    if (!(await blobBackend.exists(hash))) {
      await blobBackend.put(hash, data, mimeType);
    }

    // Register metadata (idempotent)
    await storage.blobs.register(hash, mimeType, data.length, hash);

    await storage.audit.log({
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
    requireAuth(c);

    let hash = c.req.param("hash");
    if (!hash.startsWith("sha256:")) {
      hash = `sha256:${hash}`;
    }
    if (!isValidBlobHash(hash)) {
      return new Response(null, { status: 400 });
    }

    const record = await storage.blobs.get(hash);
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
    requireAuth(c);

    let hash = c.req.valid("param").hash;
    if (!hash.startsWith("sha256:")) {
      hash = `sha256:${hash}`;
    }
    if (!isValidBlobHash(hash)) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid blob hash");
    }

    const record = await storage.blobs.get(hash);
    if (!record) {
      throw new MymeError(ErrorCode.BLOB_NOT_FOUND, "Blob not found");
    }

    const data = await blobBackend.get(hash);
    if (!data) {
      throw new MymeError(ErrorCode.BLOB_NOT_FOUND, "Blob data not found");
    }

    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        "Content-Type": record.mime_type,
        "Content-Length": String(data.length),
      },
    });
  });

  // GET /blobs/:hash/url — presigned download URL
  router.openapi(getBlobUrlRoute, async (c) => {
    requireAuth(c);

    if (!blobBackend.getPresignedUrl) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Presigned URLs are not available with the current blob backend",
      );
    }

    let hash = c.req.valid("param").hash;
    if (!hash.startsWith("sha256:")) {
      hash = `sha256:${hash}`;
    }
    if (!isValidBlobHash(hash)) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid blob hash");
    }

    const record = await storage.blobs.get(hash);
    if (!record) {
      throw new MymeError(ErrorCode.BLOB_NOT_FOUND, "Blob not found");
    }

    const { ttl } = c.req.valid("query");
    const url = await blobBackend.getPresignedUrl(hash, ttl);
    return c.json({ url, expires_in: ttl }, 200);
  });

  // POST /blobs/cleanup — remove unreferenced blobs (admin only)
  router.openapi(cleanupBlobsRoute, async (c) => {
    requireAdmin(c);

    const dryRun = c.req.valid("query").dry_run === "true";
    const tenantId = c.get("apiKey")?.tenant_id;

    // Collect all blob hashes registered in the store
    const allHashes = await storage.blobs.listAll();

    // Paginate through all items and extract every blob hash from properties
    const referencedHashes = new Set<string>();

    const scanItems = async (state?: string): Promise<void> => {
      let cursor: string | undefined;
      let hasMore = true;
      while (hasMore) {
        const page = await storage.items.list({
          tenantId,
          state: state as import("@mymehq/shared").ItemState | undefined,
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

    const orphaned = allHashes.filter((h) => !referencedHashes.has(h));

    if (!dryRun) {
      for (const hash of orphaned) {
        await blobBackend.delete(hash);
        await storage.blobs.remove(hash);
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
      throw new MymeError(
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
