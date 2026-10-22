/**
 * The owner's profile picture: two doors that take its bytes and one that
 * serves them. The kind is decided from the bytes (`readPicture`); the type
 * and file name a sender claims are ignored.
 */
import { createRoute } from "@hono/zod-openapi";
import type { ReadableStreamReadResult } from "node:stream/web";
import type { Context } from "hono";
import {
  ErrorCode,
  MarfaError,
  profilePermissionCovers,
} from "@withmarfa/shared";
import {
  authorityId,
  directAuthorityOnly,
  isDirectAuthority,
  requireAuth,
  requireRecentOwnerAuthentication,
  standingRule,
  type AppEnv,
} from "../middleware/auth.js";
import {
  createOpenAPIRouter,
  makeErrorResponseSchema,
  OkResponseSchema,
} from "../openapi.js";
import {
  PICTURE_MAX_BYTES,
  PICTURE_TOO_LARGE_WORDS,
  PICTURE_WORDS,
  readPicture,
} from "../picture.js";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
import { BLOB_CONTENT_SECURITY_POLICY } from "../storage/blob-store.js";
import type { Storage } from "../storage/interface.js";
import { OwnerSchema, ownerWire } from "./owner-wire.js";

const BINARY_BODY = { type: "string" as const, format: "binary" as const };

const failure = (
  codes: Parameters<typeof makeErrorResponseSchema>[0],
  description: string,
) => ({
  content: { "application/json": { schema: makeErrorResponseSchema(codes) } },
  description,
});

const PICTURE_BODY = {
  required: true,
  description:
    "The picture's bytes, sent as they are, not as `multipart/form-data`. Marfa decides the kind from the bytes and ignores `Content-Type` and any file name. A PNG, JPEG or WebP of 2 MiB or less, 1 to 4096 pixels on each side.",
  content: { "application/octet-stream": { schema: BINARY_BODY } },
};

const uploadRefusals = {
  400: failure(
    ["validation_error"],
    "The body is empty, damaged, not a PNG, JPEG or WebP, or larger than 4096 pixels on a side. For example, a GIF, an AVIF or an SVG.",
  ),
  404: failure(["owner_not_found"], "The owner is unavailable."),
};

const putOwnerPictureRoute = createRoute({
  operationId: "replaceOwnerPicture",
  method: "put",
  path: "/",
  tags: ["Owner"],
  summary: "Replace the owner's picture",
  security: [{ ownerSession: [] }],
  middleware: directAuthorityOnly,
  description:
    "Stores the request body as the owner's picture and returns the owner. Requires a direct owner sign-in within five minutes or private machine authority.",
  request: { body: PICTURE_BODY },
  responses: {
    200: {
      content: { "application/json": { schema: OwnerSchema } },
      description:
        "The updated owner, whose `avatar` is the picture's address.",
    },
    ...uploadRefusals,
    401: failure(["unauthorized"], "Sign in as the owner."),
    403: failure(
      ["forbidden"],
      "The request needs private machine authority or direct owner authentication within five minutes.",
    ),
  },
});

const putProfilePictureRoute = createRoute({
  operationId: "replaceProfilePicture",
  method: "put",
  path: "/",
  tags: ["Owner"],
  summary: "Replace the picture as an app",
  security: [{ bearerAuth: [] }],
  middleware: standingRule("profile write on avatar", (c) => {
    const key = requireAuth(c);
    if (!profilePermissionCovers(key.profile_permissions, "avatar", "write"))
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        "Missing profile.avatar:write permission",
      );
  }),
  description:
    "Stores the request body as the owner's picture and returns `ok: true`. Requires profile write permission for the avatar.",
  request: { body: PICTURE_BODY },
  responses: {
    200: {
      content: { "application/json": { schema: OkResponseSchema } },
      description: "Returns ok: true. The picture was stored.",
    },
    ...uploadRefusals,
    401: failure(["unauthorized"], "The credential is missing or expired."),
    403: failure(
      ["forbidden"],
      "The credential lacks profile write permission for the avatar.",
    ),
  },
});

const PICTURE_HEADERS = {
  ETag: {
    schema: { type: "string" as const },
    description: "The quoted SHA-256 of the picture's bytes.",
  },
};

const getOwnerPictureRoute = createRoute({
  operationId: "getOwnerPicture",
  method: "get",
  path: "/",
  tags: ["Owner"],
  summary: "Get the owner's picture",
  security: [{ ownerSession: [] }, { bearerAuth: [] }],
  middleware: standingRule("owner session, or profile avatar read", (c) => {
    if (isDirectAuthority(c)) return;
    const key = requireAuth(c);
    const literal =
      c.get("authType") === "oauth" &&
      (c.get("oauthGrant")?.scopes ?? []).includes("profile");
    if (
      !literal &&
      !profilePermissionCovers(key.profile_permissions, "avatar", "read")
    )
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        "Missing profile.avatar:read permission",
      );
  }),
  description:
    "Returns the owner's picture as an image download. Requires an owner sign-in or a credential with profile read permission for the avatar. Send `If-None-Match` to revalidate.",
  responses: {
    200: {
      content: {
        "image/png": { schema: BINARY_BODY },
        "image/jpeg": { schema: BINARY_BODY },
        "image/webp": { schema: BINARY_BODY },
      },
      headers: PICTURE_HEADERS,
      description: "Returns the picture's bytes.",
    },
    304: {
      headers: { ETag: PICTURE_HEADERS.ETag },
      description: "The picture still matches the `If-None-Match` value.",
    },
    401: failure(["unauthorized"], "The credential is missing or expired."),
    403: failure(
      ["forbidden"],
      "The credential lacks profile read permission for the avatar.",
    ),
    404: failure(["not_found"], "No picture is set."),
  },
});

/**
 * The request's whole body, counted as it arrives. A body past the cap is
 * refused as soon as the count passes it, with no more than one chunk held
 * beyond it, whether or not the sender declared a length.
 */
async function readBody(c: Context<AppEnv>): Promise<Uint8Array> {
  const tooLarge = () =>
    new MarfaError(ErrorCode.REQUEST_TOO_LARGE, PICTURE_TOO_LARGE_WORDS);
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > PICTURE_MAX_BYTES) throw tooLarge();
  const reader = c.req.raw.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let held = 0;
  for (;;) {
    let read: ReadableStreamReadResult<Uint8Array>;
    try {
      read = await reader.read();
    } catch {
      // The sender went away mid-body: a refusal of what arrived, not a
      // fault of the server's.
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "The body did not arrive whole",
      );
    }
    if (read.done) break;
    if (held + read.value.byteLength > PICTURE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    held += read.value.byteLength;
    chunks.push(read.value);
  }
  return Buffer.concat(chunks, held);
}

/** The picture a body holds, or the refusal it earns. */
async function acceptedPicture(c: Context<AppEnv>) {
  const bytes = await readBody(c);
  const reading = readPicture(bytes);
  if (!reading.ok)
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      PICTURE_WORDS[reading.reason],
    );
  return { contentType: reading.contentType, bytes };
}

function ownerUnavailable(): MarfaError {
  return new MarfaError(ErrorCode.OWNER_NOT_FOUND, "The owner is unavailable.");
}

/** Whether an `If-None-Match` value names `etag`, weakly as a cache may. */
function namesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .some((candidate) => candidate === "*" || candidate === etag);
}

export function ownerPictureRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();
  router.openapi(putOwnerPictureRoute, async (c) => {
    requireRecentOwnerAuthentication(c);
    const picture = await acceptedPicture(c);
    const owner = await runAuditedTransaction(
      storage,
      async () => {
        const updated = await storage.owner?.setPicture(picture);
        if (!updated) throw ownerUnavailable();
        return updated;
      },
      {
        action: "owner.update",
        resource_type: "auth_user",
        key_id: authorityId(c),
        client_ip: c.get("clientIp") ?? null,
        details: { fields: ["avatar"] },
      },
    );
    return c.json(ownerWire(owner, c.var.config.authBaseUrl), 200);
  });
  router.openapi(getOwnerPictureRoute, async (c) => {
    const picture = await storage.owner?.findPicture();
    if (!picture)
      throw new MarfaError(ErrorCode.NOT_FOUND, "No picture is set");
    const etag = `"${picture.sha256}"`;
    const held = {
      ETag: etag,
      "Cache-Control": "private, no-cache",
    };
    c.header("Pragma", undefined);
    if (namesEtag(c.req.header("if-none-match"), etag))
      return c.body(null, 304, held);
    return c.body(new Uint8Array(picture.bytes), 200, {
      ...held,
      "Content-Type": picture.contentType,
      "Content-Length": String(picture.bytes.length),
      "Content-Disposition": 'attachment; filename="picture"',
      "Content-Security-Policy": BLOB_CONTENT_SECURITY_POLICY,
      "X-Content-Type-Options": "nosniff",
    });
  });
  return router;
}

export function profilePictureRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();
  router.openapi(putProfilePictureRoute, async (c) => {
    requireAuth(c);
    const picture = await acceptedPicture(c);
    await runAuditedTransaction(
      storage,
      async () => {
        const key = requireAuth(c);
        if (
          !profilePermissionCovers(key.profile_permissions, "avatar", "write")
        )
          throw new MarfaError(
            ErrorCode.FORBIDDEN,
            "Missing profile.avatar:write permission",
          );
        if (!(await storage.owner?.setPicture(picture)))
          throw ownerUnavailable();
      },
      {
        action: "profile.update",
        resource_type: "auth_user",
        key_id: authorityId(c),
        client_ip: c.get("clientIp") ?? null,
        details: { fields: ["avatar"] },
      },
    );
    return c.json({ ok: true as const }, 200);
  });
  return router;
}
