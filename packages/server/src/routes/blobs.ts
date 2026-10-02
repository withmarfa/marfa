import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode, isValidBlobHash } from "@withmarfa/shared";
import type { Context } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import type { AppConfig } from "../config.js";
import { withPreparedHeaders } from "../prepared-headers.js";
import { requireOperatorKey } from "../middleware/auth.js";
import { log } from "../middleware/logger.js";
import type { Storage } from "../storage/interface.js";
import type { BlobLayer } from "../storage/blob-layer.js";
import {
  BLOB_CONTENT_SECURITY_POLICY,
  blobDisposition,
  HashingTransform,
  resolveRange,
  type BlobRead,
  type BlobStore,
} from "../storage/blob-store.js";
import {
  blobLinkExpiry,
  MAX_BLOB_LINK_TTL_SECONDS,
  mintBlobLink,
  verifyBlobLink,
} from "../storage/blob-link.js";
import { withBlobUploadLock } from "../storage/blob-upload-lock.js";
import { NextCursorSchema, pageOf } from "./_schemas.js";
import type { Housekeeping } from "../housekeeping/scheduler.js";
import {
  CopiesBelowMinimum,
  LocationNotFound,
  dropBlobCopy,
} from "../housekeeping/blob-delete.js";
import {
  createOpenAPIRouter,
  makeErrorResponseSchema,
  OkResponseSchema,
} from "../openapi.js";
import { refuseUnknownQueryParams } from "./_unknown-query-keys.js";
import { requireBlobUpload, requireReadableBlob } from "./_blob-reach.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const BlobUploadResponseSchema = z.object({
  hash: z.string(),
  mime_type: z.string(),
  size_bytes: z.number(),
});

const BlobUrlResponseSchema = z.object({
  url: z.string(),
  expires_in: z.number(),
});

const BlobStoreSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["disk", "s3"]),
    locator: z.string(),
    policy: z.string(),
    attached_at: z.string(),
    detached_at: z.string().nullable(),
  })
  .openapi("BlobStore");

const BlobLocationSchema = z
  .object({
    store_id: z.string(),
    kind: z.enum(["disk", "s3"]),
    policy: z.string(),
    detached: z.boolean(),
    recorded_at: z.string(),
    verified_at: z.string().nullable(),
  })
  .openapi("BlobLocation");

const BlobOrphanSchema = z
  .object({
    hash: z.string(),
    mime_type: z.string(),
    size_bytes: z.number().int(),
    reported_at: z.string(),
  })
  .openapi("BlobOrphan");

const HashParam = z.object({
  hash: z.string().describe("Content-addressed `sha256:<hex>` blob hash."),
});

const HashAndStoreParam = z.object({
  hash: z.string().describe("Content-addressed `sha256:<hex>` blob hash."),
  store: z
    .string()
    .describe("A store's `id`, as `GET /blobs/stores` lists it."),
});

/** The headers a served blob carries, declared once for both doors. */
const BYTES_HEADERS = {
  "Content-Disposition": {
    description:
      'Always `attachment; filename="<hex>"`, whatever the type: the bytes are a file to save, never a page to render.',
    schema: { type: "string" as const },
  },
  "Content-Security-Policy": {
    description:
      "Always `sandbox; default-src 'none'`, so bytes a browser renders anyway run in an opaque origin with nothing loaded.",
    schema: { type: "string" as const },
  },
  "Accept-Ranges": {
    description: "Always `bytes`: one range of a blob can be asked for.",
    schema: { type: "string" as const },
  },
  ETag: {
    description:
      "The blob's content hash, so a cached copy is validated by the name it was fetched under.",
    schema: { type: "string" as const },
  },
};

const RANGE_HEADERS = {
  ...BYTES_HEADERS,
  "Content-Range": {
    description: "`bytes <first>-<last>/<size>` for the range served.",
    schema: { type: "string" as const },
  },
};

const UNSATISFIABLE_HEADERS = {
  "Content-Range": {
    description:
      "`bytes */<size>`: the blob's size, so the caller can ask again within it.",
    schema: { type: "string" as const },
  },
};

/**
 * The bytes a blob door hands back or takes in.
 *
 * Declared as a binary string rather than left open: a generated client
 * reading an open schema types the body as a JSON value, and the doors
 * carrying this one answer a byte stream.
 */
const BINARY_BODY = { type: "string" as const, format: "binary" as const };

/**
 * The refusal of a credential whose type map reaches nothing a blob door could
 * answer it for: no type to read a referencing item of, or none to write one.
 */
const TYPE_NOT_PERMITTED_RESPONSE = {
  content: {
    "application/json": {
      schema: makeErrorResponseSchema(["type_not_permitted"]),
    },
  },
  description:
    "The credential's type permissions reach no type, or, on an upload, grant write on none",
};

/** What a reading door answers for a blob the credential may not read. */
const UNREADABLE_BLOB_RESPONSE = {
  content: {
    "application/json": {
      schema: makeErrorResponseSchema(["blob_not_found"]),
    },
  },
  description:
    "No blob with this hash that an item the credential may read references",
};

/**
 * The rule every reading door states, written once so the descriptions
 * cannot drift apart.
 */
const READ_RULE =
  "A working key or a signed-in app reads a blob only when an item of a type it may read, in any lifecycle state, references the blob's digest in its properties, with a reference that lends: one a write sent for a credential that had uploaded the bytes or could read the blob as it wrote; any other blob answers `404 blob_not_found` as an unknown hash does, and a credential whose type permissions reach no type is refused `403 type_not_permitted`. The operator key reads every blob.";

const bytesResponses = {
  200: {
    content: { "application/octet-stream": { schema: BINARY_BODY } },
    headers: BYTES_HEADERS,
    description:
      "The bytes, with the content type the blob was first uploaded under, as a download.",
  },
  206: {
    content: { "application/octet-stream": { schema: BINARY_BODY } },
    headers: RANGE_HEADERS,
    description: "The one range asked for.",
  },
  404: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["blob_not_found"]),
      },
    },
    description: "No blob with this hash, or no store holding its bytes.",
  },
  416: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["range_not_satisfiable"]),
      },
    },
    headers: UNSATISFIABLE_HEADERS,
    description: "The range asked for lies outside the blob.",
  },
};

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
    "Takes the raw bytes as the body, with `Content-Type` naming their MIME type, and answers `201` with the `sha256:<hex>` content-addressed hash. The body streams to disk as it arrives and has no size cap. Uploading bytes already held answers the existing hash. `multipart/form-data` is refused: send the bytes themselves. Takes write, through the item doors, on at least one type registered when the request is made, since an item of any type can reference a blob; a credential with none is refused `403 type_not_permitted` before the body is read. The operator key uploads without one. Bytes become readable through an item whose properties name them once a write sending the digest is made for a credential that uploaded them or could read them.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/octet-stream": {
          schema: BINARY_BODY,
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
      description:
        "Blob stored. `mime_type` is the type the blob is served with: the type sent, or, for bytes already held, the type the upload that first stored them sent.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "An empty body, or a multipart one",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: TYPE_NOT_PERMITTED_RESPONSE,
  },
});

const listBlobStoresRoute = createRoute({
  operationId: "listBlobStores",
  method: "get",
  path: "/stores",
  tags: ["Blobs"],
  summary: "List the stores this instance keeps bytes in",
  description:
    "Every store the instance has attached: the disk it uploads to and, when one is configured, the object store. A store the configuration no longer names stays listed with `detached_at` set, because the location log still describes it. `min_copies` is the live copies a blob keeps at the least: a drop that would leave fewer is refused. Operator key only.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z
            .object({
              data: z.array(BlobStoreSchema),
              next_cursor: NextCursorSchema,
              min_copies: z.number().int(),
            })
            .openapi("BlobStorePage"),
        },
      },
      description: "The stores",
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
      description: "Operator key required",
    },
  },
});

const getBlobRoute = createRoute({
  operationId: "downloadBlob",
  method: "get",
  path: "/{hash}",
  tags: ["Blobs"],
  summary: "Download blob binary",
  description: `Streams the bytes of a blob as \`application/octet-stream\` from whichever store holds them, honoring one \`Range\`. \`HEAD\` answers the same headers with no body. A hash this instance does not hold answers \`404\`. ${READ_RULE}`,
  security: [{ bearerAuth: [] }],
  request: {
    params: HashParam,
  },
  responses: {
    ...bytesResponses,
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
    403: TYPE_NOT_PERMITTED_RESPONSE,
    404: {
      ...UNREADABLE_BLOB_RESPONSE,
      description: `${UNREADABLE_BLOB_RESPONSE.description}, or no store holding its bytes`,
    },
  },
});

const getBlobUrlRoute = createRoute({
  operationId: "getBlobUrl",
  method: "get",
  path: "/{hash}/url",
  tags: ["Blobs"],
  summary: "Get a time-limited link to a blob's bytes",
  description: `Answers a URL a client fetches the bytes from without a credential, and \`expires_in\`, the seconds until it stops working. When an object store holds the blob the link is the store's own signed link, so the bytes never pass through the instance; otherwise the instance serves it. \`ttl\` is capped at seven days. ${READ_RULE} The link is checked when it is minted: it serves the bytes for its lifetime whatever happens to the credential afterwards.`,
  security: [{ bearerAuth: [] }],
  request: {
    params: HashParam,
    query: z.object({
      ttl: z.coerce
        .number()
        .int()
        .min(1)
        .optional()
        .default(3600)
        .describe(
          "Link lifetime in seconds, capped at 604800 (seven days), which the answer's `expires_in` reports.",
        ),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: BlobUrlResponseSchema,
        },
      },
      description:
        "A link and its lifetime. Either link serves the blob's recorded type as a download (`Content-Disposition: attachment`).",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "Invalid blob hash or `ttl`",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: TYPE_NOT_PERMITTED_RESPONSE,
    404: UNREADABLE_BLOB_RESPONSE,
  },
});

/**
 * The target of an instance-served link. Not a door a client calls by name:
 * `GET /blobs/{hash}/url` hands the URL out, and the signature in the query
 * is the credential, so the route declares no bearer and stays out of the
 * published reference.
 */
const fetchBlobRoute = createRoute({
  operationId: "fetchBlob",
  method: "get",
  path: "/{hash}/fetch",
  tags: ["Blobs"],
  summary: "Fetch a blob's bytes through an instance-served link",
  description:
    "Serves the bytes to whoever holds a link minted by `GET /blobs/{hash}/url`. The `expires` and `signature` query values are the credential; a link past its expiry, or altered, answers `401`.",
  security: [],
  request: {
    params: HashParam,
    query: z.object({
      expires: z.string().describe("Unix seconds the link stops working at."),
      signature: z
        .string()
        .describe("The instance's signature over the hash and the expiry."),
    }),
  },
  responses: {
    ...bytesResponses,
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
      description: "The link has expired or was not minted here for this blob",
    },
  },
});

const listBlobLocationsRoute = createRoute({
  operationId: "listBlobLocations",
  method: "get",
  path: "/{hash}/locations",
  tags: ["Blobs"],
  summary: "List the stores holding a blob",
  description: `The location log for one blob: every store recorded as holding its bytes, with when the copy was recorded and when a check last found it present and intact (\`verified_at\`, \`null\` until one has). A store the configuration no longer names is shown \`detached\` and does not count as a copy. ${READ_RULE}`,
  security: [{ bearerAuth: [] }],
  request: {
    params: HashParam,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: pageOf(BlobLocationSchema, "BlobLocationPage"),
        },
      },
      description: "The locations",
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
    403: TYPE_NOT_PERMITTED_RESPONSE,
    404: UNREADABLE_BLOB_RESPONSE,
  },
});

const dropBlobLocationRoute = createRoute({
  operationId: "dropBlobLocation",
  method: "delete",
  path: "/{hash}/locations/{store}",
  tags: ["Blobs"],
  summary: "Drop one store's copy of a blob",
  description:
    "Removes the copy of the blob that one store holds, and its row in the location log, only when at least `min_copies` live copies would remain; otherwise the copy stays and the door answers `409 copies_below_minimum`. A store that holds no copy, or that is not attached, answers `404 blob_location_not_found`. Operator key only.",
  security: [{ bearerAuth: [] }],
  request: { params: HashAndStoreParam },
  responses: {
    200: {
      content: {
        "application/json": { schema: OkResponseSchema },
      },
      description: "The copy is gone",
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
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Operator key required",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "blob_not_found",
            "blob_location_not_found",
          ]),
        },
      },
      description: "No such blob, or no such copy",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["copies_below_minimum"]),
        },
      },
      description: "The drop would leave fewer live copies than the minimum",
    },
  },
});

const listBlobOrphansRoute = createRoute({
  operationId: "listBlobOrphans",
  method: "get",
  path: "/orphans",
  tags: ["Blobs"],
  summary: "List the blobs nothing references",
  description:
    "The orphan report: every registered blob the last run of the `blob-orphans` housekeeping job found nothing referencing, with when a run first said so. A blob stands here for the grace period before a later run purges it, and leaves the report if something names it again or its bytes are uploaded again. Operator key only.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: pageOf(BlobOrphanSchema, "BlobOrphanPage"),
        },
      },
      description: "The report, oldest first",
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
      description: "Operator key required",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** `sha256:` restored where a caller sent the bare hex, then validated. */
function normalizeHash(raw: string): string {
  const hash = raw.startsWith("sha256:") ? raw : `sha256:${raw}`;
  if (!isValidBlobHash(hash)) {
    throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid blob hash");
  }
  return hash;
}

export function blobRoutes(
  storage: Storage,
  blobs: BlobLayer,
  housekeeping: Pick<Housekeeping, "wake">,
  config: Pick<AppConfig, "authBaseUrl" | "authSecret" | "blobMinCopies">,
) {
  const minCopies = config.blobMinCopies ?? 1;
  const router = createOpenAPIRouter<AppEnv>();
  // The origin a link the instance serves is minted under. The base URL
  // rather than the request's own origin, because the request's scheme is
  // the socket's: behind an edge that terminates TLS every request arrives
  // as `http`, and a link saying so would be one a browser refuses to
  // follow from an `https` page.
  const linkOrigin = new URL(config.authBaseUrl).origin;

  /**
   * The bytes of a registered blob, from the first attached store that has
   * them, as a response. Shared by the bearer door and the link door, which
   * differ only in the credential they took and so in how they came by the
   * record. Every answer is a download under a sandbox, whatever the type:
   * the type is the uploader's word, and these answers come from the
   * instance's own origin.
   */
  async function serveBytes(
    c: Context<AppEnv>,
    hash: string,
    record: { mime_type: string; size_bytes: number },
    headOnly: boolean,
  ): Promise<Response> {
    const range = resolveRange(c.req.header("Range"), record.size_bytes);
    if (range === null) {
      // The size, so the caller can ask again within it. A header set
      // before the throw rides the error response like `Retry-After` does.
      c.header("Content-Range", `bytes */${String(record.size_bytes)}`);
      throw new MarfaError(
        ErrorCode.RANGE_NOT_SATISFIABLE,
        "The range asked for lies outside the blob",
        { size_bytes: record.size_bytes },
      );
    }

    const headers: Record<string, string> = {
      "Content-Type": record.mime_type,
      "Content-Disposition": blobDisposition(hash),
      "Content-Security-Policy": BLOB_CONTENT_SECURITY_POLICY,
      "Accept-Ranges": "bytes",
      ETag: `"${hash}"`,
    };

    // The registry is the truth for the headers, so a HEAD answers without
    // touching a store. Hono answers HEAD by running this handler and
    // dropping the body; a stream opened for a body nobody reads would hold
    // its file open, so the stream is never opened.
    if (headOnly) {
      const length = range ? range.end - range.start + 1 : record.size_bytes;
      headers["Content-Length"] = String(length);
      if (range) {
        headers["Content-Range"] =
          `bytes ${String(range.start)}-${String(range.end)}/${String(record.size_bytes)}`;
      }
      return withPreparedHeaders(
        c,
        new Response(null, { status: range ? 206 : 200, headers }),
      );
    }

    let read: BlobRead | null = null;
    for (const store of blobs.stores) {
      read = await store.get(hash, range ?? undefined);
      if (read) break;
    }
    if (!read) {
      throw new MarfaError(
        ErrorCode.BLOB_NOT_FOUND,
        "No store holds the bytes of this blob",
      );
    }

    headers["Content-Length"] = String(read.length);
    if (range) {
      headers["Content-Range"] =
        `bytes ${String(read.offset)}-${String(read.offset + read.length - 1)}/${String(read.size_bytes)}`;
    }
    return withPreparedHeaders(
      c,
      new Response(Readable.toWeb(read.stream) as ReadableStream, {
        status: range ? 206 : 200,
        headers,
      }),
    );
  }

  // POST /blobs — stream the body to the disk store, then register it
  router.openapi(uploadBlobRoute, async (c) => {
    const uploader = requireBlobUpload(c);

    const contentType =
      c.req.header("Content-Type") ?? "application/octet-stream";
    const mimeType = (contentType.split(";")[0] ?? contentType).trim();
    if (mimeType.toLowerCase() === "multipart/form-data") {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Send the bytes as the body with their Content-Type; multipart/form-data is not accepted",
      );
    }

    // Spooled onto the disk store's own filesystem while the hash is
    // computed, because the name is not known until the last byte has
    // arrived and the move into place must then be a rename.
    const disk = blobs.disk;
    const spool = disk.spoolPath();
    const hashing = new HashingTransform();
    try {
      const body = c.req.raw.body;
      if (body) {
        await pipeline(
          Readable.fromWeb(body),
          hashing,
          createWriteStream(spool),
        );
      }
    } catch (err) {
      await rm(spool, { force: true });
      throw err;
    }
    if (hashing.bytes === 0) {
      await rm(spool, { force: true });
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Empty blob");
    }
    const hash = hashing.digest();
    const sizeBytes = hashing.bytes;

    // Content addressing makes `present` decide two things at once: whether
    // these bytes need moving into place, and whether a refused registration
    // has anything to undo. The per-hash lock is what makes the answer
    // authoritative: taken across the check, the move and the registration,
    // a request that saw the bytes absent is the one that put them there and
    // the only one that may take them back.
    const recorded = await withBlobUploadLock(hash, async () => {
      const present = (await disk.has(hash)) !== null;
      if (present) {
        await rm(spool, { force: true });
      } else {
        await disk.put(hash, { path: spool, size_bytes: sizeBytes });
      }
      try {
        // The first upload fixes the type; a later one under another type
        // is answered with the type the bytes are served with.
        return await storage.runInTransaction(async () => {
          await storage.blobs.register(hash, mimeType, sizeBytes);
          await storage.blobs.recordLocation(hash, disk.id);
          await storage.blobs.recordUploader(hash, uploader);
          const row = await storage.blobs.get(hash);
          if (!row) throw new Error(`blob ${hash} was not registered`);
          return row.mime_type;
        });
      } catch (err) {
        // A file no row names is unreachable and nothing sweeps it. A failure
        // to undo leaves bytes behind rather than failing the request a
        // second time, so it is logged: the caller's error is the one worth
        // surfacing.
        if (!present) {
          try {
            await disk.delete(hash);
          } catch (cleanupErr) {
            log("error", "blob.orphaned_after_refused_upload", {
              hash,
              size_bytes: sizeBytes,
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
      key_id: c.get("apiKey")?.id,
      action: "blob.upload",
      resource_type: "blob",
      resource_id: hash,
      details: { mime_type: recorded, size_bytes: sizeBytes },
    });
    // The other stores get their copies at replication's next run, which
    // this brings forward; a wake is a hint, so a scheduler that is not
    // running loses nothing but the hurry.
    await housekeeping.wake("blob-replicate");

    return c.json({ hash, mime_type: recorded, size_bytes: sizeBytes }, 201);
  });

  // GET /blobs/orphans — the report the orphan sweep writes. Registered
  // ahead of `/{hash}` so the literal segment is never read as a hash.
  router.openapi(listBlobOrphansRoute, async (c) => {
    requireOperatorKey(c);
    const data = await storage.blobs.listOrphans();
    return c.json({ data, next_cursor: null }, 200);
  });

  // GET /blobs/stores — the attached stores (operator key only). Registered
  // ahead of `/{hash}` so the literal segment is never read as a hash.
  router.openapi(listBlobStoresRoute, async (c) => {
    requireOperatorKey(c);
    const data = await storage.blobs.listStores();
    return c.json({ data, next_cursor: null, min_copies: minCopies }, 200);
  });

  // GET /blobs/:hash — the bytes; HEAD — the headers
  router.openapi(getBlobRoute, async (c) => {
    const hash = normalizeHash(c.req.valid("param").hash);
    const record = await requireReadableBlob(c, storage, hash);
    return serveBytes(c, hash, record, c.req.method === "HEAD");
  });

  // GET /blobs/:hash/url — a link the bytes can be fetched from
  router.openapi(getBlobUrlRoute, async (c) => {
    refuseUnknownQueryParams(c.req.raw.url, getBlobUrlRoute.request.query);
    const hash = normalizeHash(c.req.valid("param").hash);
    const record = await requireReadableBlob(c, storage, hash);

    const ttl = Math.min(c.req.valid("query").ttl, MAX_BLOB_LINK_TTL_SECONDS);

    // A store that signs its own links is preferred the moment it holds a
    // copy, because its link keeps the bytes off the instance entirely.
    const signing = await signingStoreHolding(hash);
    if (signing?.link) {
      const url = await signing.link(hash, ttl, record.mime_type);
      return c.json({ url, expires_in: ttl }, 200);
    }

    const url = mintBlobLink(
      config.authSecret,
      linkOrigin,
      hash,
      blobLinkExpiry(Date.now(), ttl),
    );
    return c.json({ url, expires_in: ttl }, 200);
  });

  async function signingStoreHolding(
    hash: string,
  ): Promise<BlobStore | undefined> {
    const locations = await storage.blobs.listLocations(hash);
    for (const location of locations) {
      if (location.detached) continue;
      const store = blobs.byId(location.store_id);
      if (store?.link) return store;
    }
    return undefined;
  }

  // GET /blobs/:hash/fetch — the bytes, to whoever holds a link
  router.openapi(fetchBlobRoute, async (c) => {
    const hash = normalizeHash(c.req.valid("param").hash);
    const { expires, signature } = c.req.valid("query");
    if (
      !verifyBlobLink(
        config.authSecret,
        hash,
        expires,
        signature,
        Math.floor(Date.now() / 1000),
      )
    ) {
      throw new MarfaError(
        ErrorCode.UNAUTHORIZED,
        "The link has expired or was not minted for this blob",
      );
    }
    const record = await storage.blobs.get(hash);
    if (!record) {
      throw new MarfaError(ErrorCode.BLOB_NOT_FOUND, "Blob not found");
    }
    return serveBytes(c, hash, record, c.req.method === "HEAD");
  });

  // GET /blobs/:hash/locations — the location log for one blob
  router.openapi(listBlobLocationsRoute, async (c) => {
    const hash = normalizeHash(c.req.valid("param").hash);
    await requireReadableBlob(c, storage, hash);
    const data = await storage.blobs.listLocations(hash);
    return c.json({ data, next_cursor: null }, 200);
  });

  // DELETE /blobs/:hash/locations/:store — drop one store's copy
  router.openapi(dropBlobLocationRoute, async (c) => {
    requireOperatorKey(c);
    const params = c.req.valid("param");
    const hash = normalizeHash(params.hash);
    if (!(await storage.blobs.get(hash))) {
      throw new MarfaError(ErrorCode.BLOB_NOT_FOUND, "Blob not found");
    }
    try {
      await dropBlobCopy(storage, blobs, hash, params.store, minCopies);
    } catch (err) {
      if (err instanceof LocationNotFound) {
        throw new MarfaError(
          ErrorCode.BLOB_LOCATION_NOT_FOUND,
          `No attached store ${params.store} holds a copy of this blob`,
        );
      }
      if (err instanceof CopiesBelowMinimum) {
        throw new MarfaError(
          ErrorCode.COPIES_BELOW_MINIMUM,
          `Dropping this copy would leave ${String(err.live - 1)} live copies, below the minimum of ${String(err.minCopies)}`,
          { live: err.live, min_copies: err.minCopies },
        );
      }
      throw err;
    }
    await storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: c.get("apiKey")?.id,
      action: "blob.copy_dropped",
      resource_type: "blob",
      resource_id: hash,
      details: { store_id: params.store },
    });
    return c.json({ ok: true as const }, 200);
  });

  return router;
}
