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
import { operatorOnly } from "../middleware/auth.js";
import { log } from "../middleware/logger.js";
import type { Storage } from "../storage/interface.js";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
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
import { wholeListOf } from "./_schemas.js";
import { READ_REFUSED } from "./_item-refusals.js";
import type { Housekeeping } from "../housekeeping/scheduler.js";
import {
  CopiesBelowMinimum,
  LocationNotFound,
  dropBlobCopy,
  finishCopyDeletion,
} from "../housekeeping/blob-delete.js";
import {
  createOpenAPIRouter,
  makeErrorResponseSchema,
  OkResponseSchema,
  OPERATOR_ONLY_RESPONSE,
} from "../openapi.js";
import {
  requireBlobUpload,
  requireReadableBlob,
  readsBlobs,
  uploadsBlobs,
} from "./_blob-reach.js";
import { errorMessage } from "../error-text.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const BlobUploadResponseSchema = z.object({
  hash: z
    .string()
    .describe("The blob's hash: `sha256:` and 64 hexadecimal characters."),
  mime_type: z
    .string()
    .describe(
      "The MIME type Marfa serves the blob with: the `Content-Type` of the first upload of these bytes, without parameters such as `charset`.",
    ),
  size_bytes: z.number().describe("The blob's size in bytes."),
});

const BlobUrlResponseSchema = z.object({
  url: z.string().describe("A URL that serves the bytes without a credential."),
  expires_in: z.number().describe("Seconds until the URL stops working."),
});

const BlobStoreSchema = z
  .object({
    id: z.string().describe("Unique identifier for the store."),
    kind: z
      .enum(["disk", "s3"])
      .describe(
        "The kind of store: `disk` for the disk beside the server, `s3` for an S3-compatible bucket.",
      ),
    locator: z
      .string()
      .describe(
        "Where the store is: its directory for a `disk` store, `s3://<bucket>/<prefix>` for an `s3` store.",
      ),
    policy: z
      .string()
      .describe(
        "Which blobs the store takes. Marfa defines one policy, `all`: the store takes every blob.",
      ),
    attached_at: z
      .string()
      .describe("When the instance first attached the store, in UTC."),
    detached_at: z
      .string()
      .nullable()
      .describe(
        "When the instance's configuration stopped naming the store, in UTC, or `null` while it names it.",
      ),
  })
  .openapi("BlobStore", {
    description:
      "A store is a place a blob's bytes live: the disk beside the server, or an S3-compatible bucket.",
  });

const BlobLocationSchema = z
  .object({
    store_id: z.string().describe("The ID of the store that holds the copy."),
    kind: z
      .enum(["disk", "s3"])
      .describe(
        "The kind of store: `disk` for the disk beside the server, `s3` for an S3-compatible bucket.",
      ),
    policy: z
      .string()
      .describe(
        "Which blobs the store takes. Marfa defines one policy, `all`: the store takes every blob.",
      ),
    detached: z
      .boolean()
      .describe(
        "`true` if the instance's configuration no longer names the store. A copy in a detached store doesn't count toward `min_copies`.",
      ),
    recorded_at: z.string().describe("When Marfa recorded the copy, in UTC."),
    verified_at: z
      .string()
      .nullable()
      .describe(
        "When a check last found the copy present and intact, in UTC, or `null` if none has.",
      ),
  })
  .openapi("BlobLocation", {
    description: "A location is one store's copy of a blob.",
  });

const BlobOrphanSchema = z
  .object({
    hash: z.string().describe("The blob's hash."),
    mime_type: z.string().describe("The MIME type Marfa serves the blob with."),
    size_bytes: z.number().int().describe("The blob's size in bytes."),
    reported_at: z
      .string()
      .describe(
        "When a run of the `blob-orphans` housekeeping job first found nothing referencing the blob, in UTC.",
      ),
  })
  .openapi("BlobOrphan", {
    description:
      "An orphan is a blob that nothing references, waiting to be purged.",
  });

/** Who may read a blob: the rule each reading door states on its `hash`. */
const READ_RULE =
  "You can read a blob only if an item, edge or extension you can read references its hash, and whoever wrote that reference had uploaded the bytes or could read them. The operator key reads every blob.";

const HashParam = z.object({
  hash: z.string().describe(`The blob's hash, \`sha256:<hex>\`. ${READ_RULE}`),
});

const HashAndStoreParam = z.object({
  hash: z.string().describe("The blob's hash, `sha256:<hex>`."),
  store: z
    .string()
    .describe("The ID of the store, as `GET /blobs/stores` lists it."),
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

/** The refusal of a credential reaching no type to read a referencing item of. */
const READ_REFUSED_RESPONSE = {
  content: {
    "application/json": {
      schema: makeErrorResponseSchema(["type_not_permitted"]),
    },
  },
  description: READ_REFUSED,
};

/** The refusal of a credential that writes no registered type. */
const UPLOAD_REFUSED_RESPONSE = {
  content: {
    "application/json": {
      schema: makeErrorResponseSchema(["type_not_permitted"]),
    },
  },
  description:
    "- `type_not_permitted`: your credential has no write on any registered type. Marfa refuses the upload before it reads the body.",
};

/** What a reading door answers for a blob the credential may not read. */
const UNREADABLE_BLOB_RESPONSE = {
  content: {
    "application/json": {
      schema: makeErrorResponseSchema(["blob_not_found"]),
    },
  },
  description:
    "- `blob_not_found`: no blob has this hash, or nothing you can read references it.",
};

const INVALID_HASH_RESPONSE = {
  content: {
    "application/json": {
      schema: makeErrorResponseSchema(["validation_error"]),
    },
  },
  description: "- `validation_error`: the hash is malformed.",
};

const unauthorized = {
  401: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["unauthorized"]),
      },
    },
    description: "Unauthorized",
  },
};

const bytesResponses = {
  200: {
    content: { "application/octet-stream": { schema: BINARY_BODY } },
    headers: BYTES_HEADERS,
    description:
      "Returns the bytes, with the `Content-Type` the blob was first uploaded under, as a download.",
  },
  206: {
    content: { "application/octet-stream": { schema: BINARY_BODY } },
    headers: RANGE_HEADERS,
    description:
      "Returns the range you asked for. Marfa serves one range, `bytes=<first>-<last>` or `bytes=<first>-`. For any other `Range`, it returns the whole blob with `200`.",
  },
  404: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["blob_not_found"]),
      },
    },
    description:
      "- `blob_not_found`: no blob has this hash, or no store holds its bytes.",
  },
  416: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["range_not_satisfiable"]),
      },
    },
    headers: UNSATISFIABLE_HEADERS,
    description:
      "- `range_not_satisfiable`: the range starts past the end of the blob, or ends before it starts. `Content-Range` gives the blob's size.",
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
    "Stores the request body as a blob and returns its `sha256:` hash. Uploading bytes Marfa already holds returns the same hash, and there is no size limit. To read the blob back, first write its hash into an item, edge or extension.",
  security: [{ bearerAuth: [] }],
  middleware: uploadsBlobs,
  request: {
    body: {
      required: true,
      description:
        "The bytes to store, sent as they are, not as `multipart/form-data`. Set `Content-Type` to their MIME type.",
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
        "Returns the blob's `hash`, `mime_type` and `size_bytes`. If Marfa already held these bytes, `mime_type` is the type of the first upload, not the one you sent.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description:
        "- `validation_error`: the body is empty, or is `multipart/form-data`.",
    },
    ...unauthorized,
    403: UPLOAD_REFUSED_RESPONSE,
  },
});

const listBlobStoresRoute = createRoute({
  operationId: "listBlobStores",
  method: "get",
  path: "/stores",
  tags: ["Blobs"],
  summary: "List blob stores",
  description:
    "Returns every store the instance has attached, including any it has since detached, and `min_copies`, the fewest live copies Marfa keeps of a blob. Requires the operator key.",
  security: [{ bearerAuth: [] }],
  middleware: operatorOnly,
  responses: {
    200: {
      content: {
        "application/json": {
          schema: wholeListOf(BlobStoreSchema, "BlobStorePage", "store", {
            min_copies: z
              .number()
              .int()
              .describe(
                "The fewest live copies Marfa keeps of each blob. `DELETE /blobs/{hash}/locations/{store}` won't delete a copy that would leave fewer.",
              ),
          }),
        },
      },
      description: "Returns every store, in one page.",
    },
    ...unauthorized,
    403: OPERATOR_ONLY_RESPONSE,
  },
});

const getBlobRoute = createRoute({
  operationId: "downloadBlob",
  method: "get",
  path: "/{hash}",
  tags: ["Blobs"],
  summary: "Download a blob",
  description:
    "Returns the bytes of a blob, from whichever store holds them, as a download. Send one `Range` to get part of it. `HEAD` returns the headers alone.",
  security: [{ bearerAuth: [] }],
  middleware: readsBlobs,
  request: {
    params: HashParam,
  },
  responses: {
    ...bytesResponses,
    400: INVALID_HASH_RESPONSE,
    ...unauthorized,
    403: READ_REFUSED_RESPONSE,
    404: {
      ...UNREADABLE_BLOB_RESPONSE,
      description:
        "- `blob_not_found`: no blob has this hash, nothing you can read references it, or no store holds its bytes.",
    },
  },
});

const getBlobUrlRoute = createRoute({
  operationId: "getBlobUrl",
  method: "get",
  path: "/{hash}/url",
  tags: ["Blobs"],
  summary: "Get a blob URL",
  description:
    "Returns a URL that serves the blob's bytes without a credential, and `expires_in`, the seconds until it stops working. The URL keeps working for that time even if you revoke your credential.",
  security: [{ bearerAuth: [] }],
  middleware: readsBlobs,
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
          "How long the URL works, in seconds. Marfa caps it at 604800 (seven days) and returns the lifetime it used as `expires_in`.",
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
        "Returns the `url` and `expires_in`. The URL serves the blob with its recorded `Content-Type`, as a download.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description:
        "- `validation_error`: the hash is malformed, or `ttl` isn't a positive integer.",
    },
    ...unauthorized,
    403: READ_REFUSED_RESPONSE,
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
    "Serves the bytes to whoever holds a link minted by `GET /blobs/{hash}/url`. The `expires` and `signature` query values are the credential.",
  security: [],
  request: {
    params: z.object({
      hash: z.string().describe("The blob's hash, `sha256:<hex>`."),
    }),
    query: z.object({
      expires: z.string().describe("Unix seconds the link stops working at."),
      signature: z
        .string()
        .describe("The instance's signature over the hash and the expiry."),
    }),
  },
  responses: {
    ...bytesResponses,
    400: INVALID_HASH_RESPONSE,
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description:
        "- `unauthorized`: the link has expired or was not minted here for this blob.",
    },
  },
});

const listBlobLocationsRoute = createRoute({
  operationId: "listBlobLocations",
  method: "get",
  path: "/{hash}/locations",
  tags: ["Blobs"],
  summary: "List a blob's locations",
  description:
    "Returns the stores that hold a copy of the blob, with when each copy was recorded and when a check last found it intact.",
  security: [{ bearerAuth: [] }],
  middleware: readsBlobs,
  request: {
    params: HashParam,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: wholeListOf(
            BlobLocationSchema,
            "BlobLocationPage",
            "location",
          ),
        },
      },
      description: "Returns every location, in one page.",
    },
    400: INVALID_HASH_RESPONSE,
    ...unauthorized,
    403: READ_REFUSED_RESPONSE,
    404: UNREADABLE_BLOB_RESPONSE,
  },
});

const deleteBlobLocationRoute = createRoute({
  operationId: "deleteBlobLocation",
  method: "delete",
  path: "/{hash}/locations/{store}",
  tags: ["Blobs"],
  summary: "Delete a blob's copy in a store",
  description:
    "Deletes the copy of a blob that one store holds, and its row in the location log. Requires the operator key.",
  security: [{ bearerAuth: [] }],
  middleware: operatorOnly,
  request: { params: HashAndStoreParam },
  responses: {
    200: {
      content: {
        "application/json": { schema: OkResponseSchema },
      },
      description:
        "Returns `ok: true`. The store no longer holds the copy, and the location log no longer lists it.",
    },
    400: INVALID_HASH_RESPONSE,
    ...unauthorized,
    403: OPERATOR_ONLY_RESPONSE,
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "blob_not_found",
            "blob_location_not_found",
          ]),
        },
      },
      description:
        "- `blob_not_found`: no blob has this hash.\n- `blob_location_not_found`: the store holds no copy of the blob, or isn't attached.",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["copies_below_minimum"]),
        },
      },
      description:
        "- `copies_below_minimum`: deleting the copy would leave fewer live copies than `min_copies`. Nothing changes.",
    },
  },
});

const listBlobOrphansRoute = createRoute({
  operationId: "listBlobOrphans",
  method: "get",
  path: "/orphans",
  tags: ["Blobs"],
  summary: "List orphaned blobs",
  description:
    "Returns the blobs that nothing references, as the last run of the `blob-orphans` housekeeping job found them, oldest first. Requires the operator key.",
  security: [{ bearerAuth: [] }],
  middleware: operatorOnly,
  responses: {
    200: {
      content: {
        "application/json": {
          schema: wholeListOf(BlobOrphanSchema, "BlobOrphanPage", "orphan"),
        },
      },
      description:
        "Returns every orphan, in one page. A later run purges a blob once it has been listed longer than the grace period. It leaves the list if something references it again or you upload its bytes again.",
    },
    ...unauthorized,
    403: OPERATOR_ONLY_RESPONSE,
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
      await finishCopyDeletion(storage, disk, hash);
      const present = (await disk.has(hash)) !== null;
      if (present) {
        await rm(spool, { force: true });
      } else {
        await disk.put(hash, { path: spool, size_bytes: sizeBytes });
      }
      try {
        // The first upload fixes the type; a later one under another type
        // is answered with the type the bytes are served with.
        return await runAuditedTransaction(
          storage,
          async () => {
            await storage.blobs.register(hash, mimeType, sizeBytes);
            await storage.blobs.recordLocation(hash, disk.id);
            await storage.blobs.recordUploader(hash, uploader);
            const row = await storage.blobs.get(hash);
            if (!row) throw new Error(`blob ${hash} was not registered`);
            return row.mime_type;
          },
          (recorded) => ({
            client_ip: c.get("clientIp") ?? null,
            key_id: c.get("apiKey")?.id,
            action: "blob.upload",
            resource_type: "blob",
            resource_id: hash,
            details: { mime_type: recorded, size_bytes: sizeBytes },
          }),
        );
      } catch (err) {
        // A file no row names is unreachable and nothing sweeps it. A failure
        // to undo leaves bytes behind rather than failing the request a
        // second time, so it is logged: the caller's error is the one worth
        // surfacing.
        if (!present) {
          try {
            if ((await storage.blobs.get(hash)) === null)
              await disk.delete(hash);
          } catch (cleanupErr) {
            log("error", "blob.orphaned_after_refused_upload", {
              hash,
              size_bytes: sizeBytes,
              error: errorMessage(cleanupErr),
            });
          }
        }
        throw err;
      }
    }).finally(() => rm(spool, { force: true }));

    // The other stores get their copies at replication's next run, which
    // this brings forward; a wake is a hint, so a scheduler that is not
    // running loses nothing but the hurry.
    await housekeeping.wake("blob-replicate");

    return c.json({ hash, mime_type: recorded, size_bytes: sizeBytes }, 201);
  });

  // GET /blobs/orphans — the report the orphan sweep writes. Registered
  // ahead of `/{hash}` so the literal segment is never read as a hash.
  router.openapi(listBlobOrphansRoute, async (c) => {
    const data = await storage.blobs.listOrphans();
    return c.json({ data, next_cursor: null }, 200);
  });

  // GET /blobs/stores — the attached stores (operator key only). Registered
  // ahead of `/{hash}` so the literal segment is never read as a hash.
  router.openapi(listBlobStoresRoute, async (c) => {
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
  router.openapi(deleteBlobLocationRoute, async (c) => {
    const params = c.req.valid("param");
    const hash = normalizeHash(params.hash);
    if (!(await storage.blobs.get(hash))) {
      throw new MarfaError(ErrorCode.BLOB_NOT_FOUND, "Blob not found");
    }
    try {
      await dropBlobCopy(storage, blobs, hash, params.store, minCopies, {
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
      });
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
    return c.json({ ok: true as const }, 200);
  });

  return router;
}
