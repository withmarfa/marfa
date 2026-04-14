import { createHash } from "node:crypto";
import { createGzip, createGunzip } from "node:zlib";
import { Readable, PassThrough } from "node:stream";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  MymeError,
  ErrorCode,
  isValidTypeIdentifier,
  isValidBlobHash,
  ITEM_STATES,
} from "@mymehq/shared";
import type { ItemState } from "@mymehq/shared";
import * as tar from "tar-stream";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAdmin,
  requireAuth,
  getTypeFilter,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { BlobBackend } from "../storage/blob-backend.js";
import { collectBlobHashes } from "../storage/blob-utils.js";
import { createOpenAPIRouter, ErrorResponseSchema } from "../openapi.js";

const MAX_IMPORT_ITEMS = 5000;

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const importRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Import/Export"],
  summary: "Bulk import items or archive (admin only)",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(z.record(z.string(), z.unknown())),
          }),
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
            blobs_imported: z.number().optional(),
          }),
        },
      },
      description: "Import result",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Validation error",
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

const exportRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Import/Export"],
  summary: "Streaming NDJSON or archive export with filters",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      type: z.string().optional(),
      state: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      format: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "text/x-ndjson": {
          schema: z.string(),
        },
      },
      description:
        "Streaming NDJSON export of items with metadata (or archive when format=archive)",
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

// ---------------------------------------------------------------------------
// Routers
// ---------------------------------------------------------------------------

export function importRoutes(storage: Storage, blobBackend: BlobBackend) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(importRoute, async (c) => {
    requireAdmin(c);

    // Archive import: Content-Type: application/gzip or ?format=archive
    const contentType = c.req.header("Content-Type") ?? "";
    if (
      contentType === "application/gzip" ||
      contentType === "application/x-gzip" ||
      c.req.query("format") === "archive"
    ) {
      const result = await handleArchiveImport(c, storage, blobBackend);
      return c.json(result, 200);
    }

    const body = c.req.valid("json");
    const items = body.items;
    if (!Array.isArray(items)) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "items must be an array");
    }
    if (items.length > MAX_IMPORT_ITEMS) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        `Maximum ${String(MAX_IMPORT_ITEMS)} items per import`,
      );
    }
    if (items.length === 0) {
      return c.json({ imported: 0, duplicates: 0 }, 200);
    }

    // Validate type identifiers
    for (const [i, item] of items.entries()) {
      if (!item.type || !isValidTypeIdentifier(item.type as string)) {
        throw new MymeError(
          ErrorCode.VALIDATION_ERROR,
          `Item at index ${String(i)}: invalid or missing type`,
        );
      }
    }

    const tenantId = c.get("apiKey")?.tenant_id;

    const result = await storage.runInTransaction(async () => {
      let imported = 0;
      let duplicates = 0;

      for (const raw of items) {
        const item = raw;
        try {
          await storage.items.create(
            {
              type: item.type as string,
              properties: (item.properties ?? {}) as Record<string, unknown>,
              source: item.source as string | undefined,
              source_id: item.source_id as string | undefined,
              tags: item.tags as string[] | undefined,
              about: item.about as string[] | undefined,
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
      key_id: c.get("apiKey")?.id,
      action: "import",
      resource_type: "import",
      details: {
        imported: result.imported,
        duplicates: result.duplicates,
        total: items.length,
      },
    });

    return c.json(result, 200);
  });

  return router;
}

export function exportRoutes(storage: Storage, blobBackend: BlobBackend) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(exportRoute, (c) => {
    requireAuth(c);

    const query = c.req.valid("query");

    // Archive export: ?format=archive
    if (query.format === "archive") {
      return handleArchiveExport(c, storage, blobBackend);
    }

    const type = query.type;
    if (type && !isValidTypeIdentifier(type)) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid type identifier",
      );
    }

    const state = query.state as ItemState | undefined;
    if (state && !(ITEM_STATES as readonly string[]).includes(state)) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid state: ${state}`,
      );
    }

    const since = query.since;
    const until = query.until;

    // Stream NDJSON — one {item, metadata} per line, paginating internally.
    // Uses ReadableStream to avoid buffering the entire export in memory.
    const tenantId = c.get("apiKey")?.tenant_id;
    const allowedTypes = getTypeFilter(c);
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        let cursor: string | undefined;
        try {
          do {
            const result = await storage.items.list({
              tenantId,
              type,
              state,
              since,
              until,
              allowed_types: allowedTypes,
              limit: 200,
              cursor,
            });

            for (const item of result.data) {
              const metadata = await storage.metadata.get(item.id);
              controller.enqueue(
                encoder.encode(JSON.stringify({ item, metadata }) + "\n"),
              );
            }

            cursor = result.has_more
              ? (result.cursor as string | undefined)
              : undefined;
          } while (cursor);
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Archive helpers
// ---------------------------------------------------------------------------

interface ArchiveManifest {
  version: number;
  format: string;
  created_at: string;
  item_count: number;
  blob_count: number;
  blobs: Record<string, { mime_type: string; size: number }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HonoContext = Context<any, any, any>;

async function handleArchiveExport(
  c: HonoContext,
  storage: Storage,
  blobBackend: BlobBackend,
): Promise<Response> {
  const type = c.req.query("type");
  if (type && !isValidTypeIdentifier(type)) {
    throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid type identifier");
  }
  const state = c.req.query("state") as ItemState | undefined;
  if (state && !(ITEM_STATES as readonly string[]).includes(state)) {
    throw new MymeError(ErrorCode.VALIDATION_ERROR, `Invalid state: ${state}`);
  }
  const since = c.req.query("since");
  const until = c.req.query("until");
  const tenantId = c.get("apiKey")?.tenant_id;
  const allowedTypes = getTypeFilter(c);

  // Pass 1: Collect all items as NDJSON and gather blob hashes
  const lines: string[] = [];
  const blobHashes = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await storage.items.list({
      tenantId,
      type,
      state,
      since,
      until,
      allowed_types: allowedTypes,
      limit: 200,
      cursor,
    });
    for (const item of result.data) {
      const metadata = await storage.metadata.get(item.id);
      lines.push(JSON.stringify({ item, metadata }));
      collectBlobHashes(item.properties, blobHashes);
      collectBlobHashes(metadata.extensions, blobHashes);
    }
    cursor = result.has_more
      ? (result.cursor as string | undefined)
      : undefined;
  } while (cursor);

  // Resolve blob metadata from the database
  const blobMeta: Record<string, { mime_type: string; size: number }> = {};
  for (const hash of blobHashes) {
    const record = await storage.blobs.get(hash);
    if (record) {
      blobMeta[hash] = { mime_type: record.mime_type, size: record.size };
    }
  }

  // Build manifest
  const manifest: ArchiveManifest = {
    version: 1,
    format: "myme-archive-v1",
    created_at: new Date().toISOString(),
    item_count: lines.length,
    blob_count: Object.keys(blobMeta).length,
    blobs: blobMeta,
  };

  // Pack tar.gz
  const pack = tar.pack();
  const gzip = createGzip();
  const passthrough = new PassThrough();
  pack.pipe(gzip).pipe(passthrough);

  // Write entries asynchronously
  const writeEntries = async (): Promise<void> => {
    // 1. Manifest
    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2));
    pack.entry(
      { name: "manifest.json", size: manifestBuf.length },
      manifestBuf,
    );

    // 2. Items NDJSON
    const ndjsonBuf = Buffer.from(lines.join("\n") + "\n");
    pack.entry({ name: "items.ndjson", size: ndjsonBuf.length }, ndjsonBuf);

    // 3. Blobs
    for (const hash of Object.keys(blobMeta)) {
      const data = await blobBackend.get(hash);
      if (data) {
        pack.entry({ name: `blobs/${hash}`, size: data.length }, data);
      }
    }

    pack.finalize();
  };

  writeEntries().catch(() => {
    passthrough.destroy();
  });

  // Convert Node stream to Web ReadableStream
  const webStream = Readable.toWeb(passthrough) as ReadableStream;

  const date = new Date().toISOString().split("T")[0] ?? "today";
  return new Response(webStream, {
    status: 200,
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="myme-export-${date}.tar.gz"`,
    },
  });
}

async function handleArchiveImport(
  c: HonoContext,
  storage: Storage,
  blobBackend: BlobBackend,
): Promise<{ imported: number; duplicates: number; blobs_imported: number }> {
  const rawBody = await c.req.arrayBuffer();
  if (rawBody.byteLength === 0) {
    throw new MymeError(ErrorCode.VALIDATION_ERROR, "Empty archive");
  }

  let manifest: ArchiveManifest | null = null;
  const itemLines: string[] = [];
  const blobUploads: Promise<void>[] = [];
  let blobCount = 0;

  // Extract tar.gz entries
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
            // Verify hash integrity
            const hex = createHash("sha256").update(buf).digest("hex");
            const computed = `sha256:${hex}`;
            if (computed === hash) {
              blobCount++;
              const mimeType =
                manifest?.blobs[hash]?.mime_type ?? "application/octet-stream";
              blobUploads.push(
                blobBackend
                  .put(hash, buf, mimeType)
                  .then(() =>
                    storage.blobs.register(hash, mimeType, buf.length, hash),
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

  // Wait for all blob uploads to complete
  await Promise.all(blobUploads);

  // Import items using the existing transaction-wrapped logic
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
      // Skip malformed lines
    }
  }

  if (items.length > MAX_IMPORT_ITEMS) {
    throw new MymeError(
      ErrorCode.VALIDATION_ERROR,
      `Maximum ${String(MAX_IMPORT_ITEMS)} items per import`,
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
            about: item.about as string[] | undefined,
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
    key_id: c.get("apiKey")?.id,
    action: "import",
    resource_type: "import",
    details: {
      format: "archive",
      imported: result.imported,
      duplicates: result.duplicates,
      blobs_imported: blobCount,
      total_items: items.length,
    },
  });

  return {
    imported: result.imported,
    duplicates: result.duplicates,
    blobs_imported: blobCount,
  };
}
