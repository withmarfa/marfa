import { createHash } from "node:crypto";
import { Hono } from "hono";
import { ProtocolError, ErrorCode, isValidBlobHash } from "@myme/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { FilesystemBlobBackend } from "../storage/blob-backend.js";

export function blobRoutes(
  storage: Storage,
  blobBackend: FilesystemBlobBackend,
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
        throw new ProtocolError(
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
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Empty blob");
    }

    // Compute content-addressed hash
    const hex = createHash("sha256").update(data).digest("hex");
    const hash = `sha256:${hex}`;

    // Store if not already present
    if (!blobBackend.exists(hash)) {
      blobBackend.put(hash, data);
    }

    // Register metadata (idempotent)
    await storage.blobs.register(hash, mimeType, data.length, hash);

    return c.json({ hash, mime_type: mimeType, size: data.length }, 201);
  });

  router.get("/:hash", async (c) => {
    requireAuth(c);

    let hash = c.req.param("hash");
    // Accept both "sha256:<hex>" and bare "<hex>"
    if (!hash.startsWith("sha256:")) {
      hash = `sha256:${hash}`;
    }
    if (!isValidBlobHash(hash)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid blob hash");
    }

    const record = await storage.blobs.get(hash);
    if (!record) {
      throw new ProtocolError(ErrorCode.BLOB_NOT_FOUND, "Blob not found");
    }

    const data = blobBackend.get(hash);
    if (!data) {
      throw new ProtocolError(ErrorCode.BLOB_NOT_FOUND, "Blob data not found");
    }

    return new Response(data, {
      status: 200,
      headers: {
        "Content-Type": record.mime_type,
        "Content-Length": String(data.length),
      },
    });
  });

  return router;
}
