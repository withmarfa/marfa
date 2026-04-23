import { createGzip } from "node:zlib";
import { Readable, PassThrough } from "node:stream";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  MymeError,
  ErrorCode,
  isValidTypeIdentifier,
  ITEM_STATES,
} from "@mymehq/shared";
import type { ItemState } from "@mymehq/shared";
import * as tar from "tar-stream";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, getTypeFilter } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { BlobBackend } from "../storage/blob-backend.js";
import { collectBlobHashes } from "../storage/blob-utils.js";
import { createOpenAPIRouter, ErrorResponseSchema } from "../openapi.js";

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const exportRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Export"],
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
// Router
// ---------------------------------------------------------------------------

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
// Archive export helper
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

  const writeEntries = async (): Promise<void> => {
    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2));
    pack.entry(
      { name: "manifest.json", size: manifestBuf.length },
      manifestBuf,
    );

    const ndjsonBuf = Buffer.from(lines.join("\n") + "\n");
    pack.entry({ name: "items.ndjson", size: ndjsonBuf.length }, ndjsonBuf);

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
