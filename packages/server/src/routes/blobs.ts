import { createHash } from "node:crypto";
import { Hono } from "hono";
import { MymeError, ErrorCode, isValidBlobHash } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { BlobBackend } from "../storage/blob-backend.js";

const MAX_BLOB_SIZE = Number(process.env.MAX_BLOB_SIZE) || 50 * 1024 * 1024; // 50MB default

export function blobRoutes(
  storage: Storage,
  blobBackend: BlobBackend,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post("/", async (c) => {
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

    return c.json({ hash, mime_type: mimeType, size: data.length }, 201);
  });

  // HEAD /blobs/:hash — check blob existence without downloading
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

  router.get("/:hash", async (c) => {
    requireAuth(c);

    let hash = c.req.param("hash");
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

  // Presigned download URL (S3 backend only)
  router.get("/:hash/url", async (c) => {
    requireAuth(c);

    if (!blobBackend.getPresignedUrl) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Presigned URLs are not available with the current blob backend",
      );
    }

    let hash = c.req.param("hash");
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

    const ttl = Number(c.req.query("ttl")) || 3600;
    const url = await blobBackend.getPresignedUrl(hash, ttl);
    return c.json({ url, expires_in: ttl });
  });

  // POST /blobs/cleanup — remove unreferenced blobs (admin only)
  router.post("/cleanup", async (c) => {
    requireAdmin(c);

    const dryRun = c.req.query("dry_run") === "true";
    const tenantId = c.get("apiKey")?.tenant_id;

    // Collect all blob hashes registered in the store
    const allHashes = await storage.blobs.listAll();

    // Recursively scan a value tree for blob hashes.
    // Custom types can store blob hashes in any field (logo_blob_hash,
    // screenshots[].blob_hash, etc.), not just the standard blob_ref field.
    const collectBlobHashes = (value: unknown, out: Set<string>): void => {
      if (typeof value === "string") {
        if (isValidBlobHash(value)) out.add(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const el of value) collectBlobHashes(el, out);
        return;
      }
      if (typeof value === "object" && value !== null) {
        for (const v of Object.values(value as Record<string, unknown>)) {
          collectBlobHashes(v, out);
        }
      }
    };

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

    return c.json({
      total_blobs: allHashes.length,
      referenced: referencedHashes.size,
      orphaned: orphaned.length,
      removed: dryRun ? 0 : orphaned.length,
      dry_run: dryRun,
    });
  });

  return router;
}
