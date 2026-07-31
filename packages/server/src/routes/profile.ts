// The profile itself is virtual: its fields are served from the `users`
// table joined to `auth_user` for the canonical email, never from an item,
// so there is one writer for a username and one place to read it. The wire
// shape is defined in @withmarfa/shared (`Profile`, `UpdateProfileInput`)
// and validated by the Zod schemas below.
//
// The one exception is `account_holder_item_id`, the id of the space's
// `system.account_holder` row. That row is a graph handle and nothing else:
// it exists so an edge has something to point at when it means "the person
// who owns this space", and it carries none of the fields above.
//
// Apps consume profile data through `/oauth/userinfo` gated on the
// standard OIDC `profile` and `email` scopes; first-party callers
// (CLI, MCP, the user themselves) hit the endpoints in this file
// directly with a bearer token resolving to a space.
//
// Avatar storage is content-addressed: `users.avatar_blob_hash` references
// a row in the existing `blobs` table (R2 / filesystem backend). The wire
// `avatar_url` is reconstructed at read time as `/blobs/<hash>` for an
// uploaded avatar or `/profile/placeholder/<username>.svg` for the
// generated placeholder.

import { createHash } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import {
  MarfaError,
  ErrorCode,
  isValidHandle,
  isReservedHandle,
} from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { reserveQuota } from "../middleware/quota.js";
import { log } from "../middleware/logger.js";
import type { Storage } from "../storage/interface.js";
import type { BlobBackend } from "../storage/blob-backend.js";
import { withBlobUploadLock } from "../storage/blob-upload-lock.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { findAccountHolderItem } from "../auth/account-holder.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ProfileSchema = z.object({
  username: z.string().nullable(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  bio: z.string().nullable(),
  avatar_url: z.string(),
  email: z.string(),
  email_verified: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  account_holder_item_id: z.string().optional(),
});

// PATCH input — every field optional. `username` collides with handle
// validation; long-form fields cap at modest lengths so a single bad
// PATCH can't blow up the row size.
const UpdateProfileSchema = z.object({
  username: z.string().optional(),
  first_name: z.string().max(64).nullable().optional(),
  last_name: z.string().max(64).nullable().optional(),
  bio: z.string().max(280).nullable().optional(),
});

// Avatar upload constraints — stricter than the generic /blobs route.
// Inline image MIME types only; oversized payloads are caught by the
// shared MAX_BLOB_SIZE gate via the blob layer.
const ALLOWED_AVATAR_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
]);

// Placeholder palette — picked once, hashed by username. Saturated
// enough to be readable on white + dark backgrounds; small enough that
// the SVG stays well under 24KB.
const PLACEHOLDER_PALETTE = [
  "#0e7c7b",
  "#7c4dff",
  "#d65a31",
  "#2563eb",
  "#16a34a",
  "#db2777",
  "#ca8a04",
  "#475569",
] as const;

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getProfileRoute = createRoute({
  operationId: "getProfile",
  method: "get",
  path: "/me",
  tags: ["Profile"],
  summary: "Get the calling user's profile",
  description:
    "Returns the profile for the user who owns the caller's space. `avatar_url` resolves to the uploaded avatar when present, otherwise to a deterministic placeholder generated from the username; for OIDC-shaped userinfo, use `GET /auth/userinfo` instead. `account_holder_item_id` names the `system.account_holder` item that represents the account holder in the item graph, so an edge such as `authored-by` can target them directly.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: ProfileSchema } },
      description: "Profile",
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
          schema: makeErrorResponseSchema(["not_found"]),
        },
      },
      description: "No profile bound to this credential",
    },
  },
});

const updateProfileRoute = createRoute({
  operationId: "updateProfile",
  method: "patch",
  path: "/me",
  tags: ["Profile"],
  summary: "Update the calling user's profile",
  description:
    "Updates any subset of the profile fields. A username change runs through the same validators as handle claims — collisions return `409 conflict` and reserved values return `400 handle_reserved`. Email is read-only and cannot be updated here.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: UpdateProfileSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ProfileSchema } },
      description: "Updated profile",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "handle_reserved",
          ]),
        },
      },
      description: "Invalid handle format or field length",
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
          schema: makeErrorResponseSchema(["not_found"]),
        },
      },
      description: "No profile bound to this credential",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["conflict"]),
        },
      },
      description: "Handle already claimed by another user",
    },
  },
});

const setAvatarRoute = createRoute({
  operationId: "uploadAvatar",
  method: "post",
  path: "/me/avatar",
  tags: ["Profile"],
  summary: "Upload an avatar",
  description:
    "Uploads an image as the user's avatar, stored as a content-addressed blob. Subject to the standard blob size cap and the space's `blobs` and `storage_bytes` quotas — an over-size payload returns `413`.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "multipart/form-data": { schema: z.any() } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ProfileSchema } },
      description: "Avatar set; returns the updated profile",
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
      description: "Invalid file (missing, empty, or unsupported MIME type)",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    413: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["blob_too_large"]),
        },
      },
      description: "Avatar exceeds maximum blob size",
    },
  },
});

const deleteAvatarRoute = createRoute({
  operationId: "deleteAvatar",
  method: "delete",
  path: "/me/avatar",
  tags: ["Profile"],
  summary: "Delete the avatar",
  description:
    "Clears the uploaded avatar, so the next profile read resolves `avatar_url` to a deterministic placeholder generated from the username. Idempotent — clearing when no avatar is set returns the unchanged profile.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: ProfileSchema } },
      description: "Avatar cleared; returns the updated profile",
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
          schema: makeErrorResponseSchema(["not_found"]),
        },
      },
      description: "No profile bound to this credential",
    },
  },
});

// Placeholder route uses Hono's plain handler — SVG bodies aren't JSON
// and we don't want OpenAPI emitting a JSON content-type for them.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ResolvedProfile {
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  bio: string | null;
  avatar_url: string;
  email: string;
  email_verified: boolean;
  created_at: string;
  updated_at: string;
  account_holder_item_id?: string;
}

/**
 * Builds the wire `Profile` shape from a `users` row + the joined
 * `auth_user` email pair. The auth join is required for email; a
 * `users` row with no `auth_user_id` falls back to empty string +
 * unverified. Routes upstream of this helper decide whether to surface
 * the partial state or 404.
 *
 * `accountHolderItemId` is omitted from the response rather than sent as
 * null when absent: null would read as "this account has no graph handle",
 * a state the model does not have. Absence means the instance has not
 * backfilled yet, and a client that cannot see the field falls back to the
 * same path it took before the field existed.
 */
function buildProfile(
  user: {
    handle: string | null;
    first_name: string | null;
    last_name: string | null;
    bio: string | null;
    avatar_blob_hash: string | null;
    created_at: string;
    updated_at: string;
  },
  authEmail: { email: string; email_verified: boolean } | null,
  accountHolderItemId?: string | null,
): ResolvedProfile {
  const username = user.handle;
  const avatar_url = user.avatar_blob_hash
    ? `/blobs/${user.avatar_blob_hash}`
    : `/profile/placeholder/${encodeURIComponent(username ?? "user")}.svg`;
  return {
    username,
    first_name: user.first_name,
    last_name: user.last_name,
    bio: user.bio,
    avatar_url,
    email: authEmail?.email ?? "",
    email_verified: authEmail?.email_verified ?? false,
    created_at: user.created_at,
    updated_at: user.updated_at,
    ...(accountHolderItemId
      ? { account_holder_item_id: accountHolderItemId }
      : {}),
  };
}

/** Picks a stable color from the palette by hashing the username. */
function placeholderColor(username: string): string {
  const h = createHash("sha256").update(username).digest();
  const idx = (h[0] ?? 0) % PLACEHOLDER_PALETTE.length;
  return PLACEHOLDER_PALETTE[idx] ?? PLACEHOLDER_PALETTE[0];
}

/** Compute initials from username — first two alphanumerics, uppercased. */
function placeholderInitials(username: string): string {
  const cleaned = username.replace(/[^a-z0-9]/gi, "");
  const first = cleaned[0] ?? "";
  const second = cleaned[1] ?? "";
  return (first + second).toUpperCase() || "?";
}

/**
 * Renders a deterministic placeholder avatar SVG. Same username always
 * yields the same bytes — proven by the test suite. Tiny by design (well
 * under 24KB; in practice a few hundred bytes) and rendered with a fixed
 * 256x256 viewBox so the consumer can size it freely.
 */
function renderPlaceholderSvg(username: string): string {
  const initials = placeholderInitials(username);
  const color = placeholderColor(username);
  // viewBox-driven layout means the SVG scales without intrinsic size
  // mattering. Font stack ordered to match the consent screen's so the
  // initials match across browsers without needing a webfont.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="${escapeXml(username)} placeholder avatar">` +
    `<rect width="256" height="256" fill="${color}"/>` +
    `<text x="128" y="128" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" ` +
    `font-size="112" font-weight="600" fill="#ffffff">${escapeXml(initials)}</text>` +
    `</svg>`
  );
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Profile router. Mounted at `/profile`. Requires `storage.users` so it's
 * only meaningful in hosted mode; in keys mode the routes still mount but
 * 404 with an explicit error body.
 */
export function profileRoutes(
  storage: Storage,
  blobBackend: BlobBackend,
  maxBlobSize: number,
) {
  const router = createOpenAPIRouter<AppEnv>();

  // Resolve the calling user's `users` row + email pair, or throw a
  // typed error if the auth path isn't bound to a profile. The 404 here
  // is the "you authenticated but I have no profile for you" shape —
  // most likely a bootstrap admin key created before the user was
  // provisioned.
  async function resolveOwnProfile(c: Parameters<typeof requireAuth>[0]) {
    const apiKey = requireAuth(c);
    if (!storage.users) {
      throw new MarfaError(
        ErrorCode.NOT_FOUND,
        "Profile is unavailable on instances running in keys mode",
      );
    }
    const spaceId = apiKey.space_id;
    if (!spaceId) {
      throw new MarfaError(
        ErrorCode.NOT_FOUND,
        "No profile bound to this credential",
      );
    }
    const user = await storage.users.getBySpaceId(spaceId);
    if (!user) {
      throw new MarfaError(
        ErrorCode.NOT_FOUND,
        "No profile bound to this credential",
      );
    }
    const authEmail = user.auth_user_id
      ? await storage.users.getAuthUserEmail(user.auth_user_id)
      : null;
    const accountHolder = await findAccountHolderItem(storage, spaceId);
    return { user, authEmail, accountHolderItemId: accountHolder?.id ?? null };
  }

  router.openapi(getProfileRoute, async (c) => {
    const { user, authEmail, accountHolderItemId } = await resolveOwnProfile(c);
    return c.json(buildProfile(user, authEmail, accountHolderItemId), 200);
  });

  router.openapi(updateProfileRoute, async (c) => {
    const { user, accountHolderItemId } = await resolveOwnProfile(c);
    if (!storage.users) {
      // resolveOwnProfile already threw for this case; the redundant
      // guard satisfies TypeScript's flow analysis below.
      throw new MarfaError(ErrorCode.NOT_FOUND, "Profile unavailable");
    }
    const userStore = storage.users;
    const body = c.req.valid("json");

    // Username change — runs through the same gauntlet as
    // PUT /auth/me/handle: reserved → invalid → collision.
    let updatedUser = user;
    if (body.username !== undefined) {
      const handle = body.username.toLowerCase();
      if (isReservedHandle(handle)) {
        throw new MarfaError(
          ErrorCode.HANDLE_RESERVED,
          `Handle "${handle}" is reserved`,
          { handle: body.username },
        );
      }
      if (!isValidHandle(handle)) {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          "Invalid handle: lowercase alphanumeric + hyphens, 3-32 chars",
          { handle: body.username },
        );
      }
      // Allow no-op (set the same handle as before) so a PATCH with
      // unchanged username + a bio change still works.
      if (handle !== user.handle) {
        const collision = await userStore.getByHandle(handle);
        if (collision && collision.id !== user.id) {
          throw new MarfaError(
            ErrorCode.CONFLICT,
            `Handle "${handle}" is already claimed`,
            { handle },
          );
        }
        updatedUser = await userStore.setHandle(user.id, handle);
      }
    }

    // Skip the update entirely when no profile fields changed, to avoid
    // stamping `updated_at` on a no-op PATCH.
    const profilePatch: {
      first_name?: string | null;
      last_name?: string | null;
      bio?: string | null;
    } = {};
    let hasFieldUpdate = false;
    if (body.first_name !== undefined) {
      profilePatch.first_name = body.first_name;
      hasFieldUpdate = true;
    }
    if (body.last_name !== undefined) {
      profilePatch.last_name = body.last_name;
      hasFieldUpdate = true;
    }
    if (body.bio !== undefined) {
      profilePatch.bio = body.bio;
      hasFieldUpdate = true;
    }
    if (hasFieldUpdate) {
      updatedUser = await userStore.updateProfile(user.id, profilePatch);
    }

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "profile.update",
      resource_type: "profile",
      resource_id: updatedUser.id,
      details: {
        username_changed: body.username !== undefined,
        fields_changed: Object.keys(profilePatch),
      },
    });

    const authEmail = updatedUser.auth_user_id
      ? await userStore.getAuthUserEmail(updatedUser.auth_user_id)
      : null;
    return c.json(
      buildProfile(updatedUser, authEmail, accountHolderItemId),
      200,
    );
  });

  router.openapi(setAvatarRoute, async (c) => {
    const { user, accountHolderItemId } = await resolveOwnProfile(c);
    if (!storage.users) {
      throw new MarfaError(ErrorCode.NOT_FOUND, "Profile unavailable");
    }
    const userStore = storage.users;

    const declaredLength = Number(c.req.header("Content-Length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBlobSize) {
      throw new MarfaError(
        ErrorCode.BLOB_TOO_LARGE,
        `Avatar exceeds maximum size of ${String(maxBlobSize)} bytes`,
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
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Empty avatar");
    }
    if (data.length > maxBlobSize) {
      throw new MarfaError(
        ErrorCode.BLOB_TOO_LARGE,
        `Avatar exceeds maximum size of ${String(maxBlobSize)} bytes`,
      );
    }
    if (!ALLOWED_AVATAR_MIME.has(mimeType)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Unsupported avatar MIME type: ${mimeType}. Allowed: ${Array.from(ALLOWED_AVATAR_MIME).join(", ")}`,
      );
    }

    // Same shape as the blob upload route: both ceilings reserved around
    // the write, with the physical put inside so refused bytes are never
    // left on disk unregistered.
    const hex = createHash("sha256").update(data).digest("hex");
    const hash = `sha256:${hex}`;
    const blobSpaceId = c.get("apiKey")?.space_id ?? "";
    // Content addressing makes `existed` decide two things at once: whether
    // these bytes need writing, and whether a later refusal has anything to
    // undo. The per-hash lock is what makes the second answer true — see the
    // comment on `POST /blobs`, which this mirrors.
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

    const updatedUser = await userStore.updateProfile(user.id, {
      avatar_blob_hash: hash,
    });
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "profile.avatar.set",
      resource_type: "profile",
      resource_id: updatedUser.id,
      details: { mime_type: mimeType, size: data.length, hash },
    });

    const authEmail = updatedUser.auth_user_id
      ? await userStore.getAuthUserEmail(updatedUser.auth_user_id)
      : null;
    return c.json(
      buildProfile(updatedUser, authEmail, accountHolderItemId),
      200,
    );
  });

  router.openapi(deleteAvatarRoute, async (c) => {
    const { user, accountHolderItemId } = await resolveOwnProfile(c);
    if (!storage.users) {
      throw new MarfaError(ErrorCode.NOT_FOUND, "Profile unavailable");
    }
    const userStore = storage.users;
    const updatedUser = await userStore.updateProfile(user.id, {
      avatar_blob_hash: null,
    });
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "profile.avatar.clear",
      resource_type: "profile",
      resource_id: updatedUser.id,
      details: {},
    });
    const authEmail = updatedUser.auth_user_id
      ? await userStore.getAuthUserEmail(updatedUser.auth_user_id)
      : null;
    return c.json(
      buildProfile(updatedUser, authEmail, accountHolderItemId),
      200,
    );
  });

  // GET /profile/placeholder/:filename — public, deterministic SVG.
  // Using a plain Hono route (not createRoute) because SVG is not JSON
  // and OpenAPI's response-content-type plumbing assumes JSON for typed
  // routes. The `:filename` param strips a trailing `.svg` for tooling
  // compatibility; we don't strictly require it.
  router.get("/placeholder/:filename", (c) => {
    const filename = c.req.param("filename");
    const username = filename.replace(/\.svg$/, "").toLowerCase();
    if (!username) {
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Missing username");
    }
    // Defense in depth — never render arbitrary input. The handle
    // grammar already covers this for valid users; for the placeholder
    // we relax to "alphanumeric + hyphens up to 64 chars" so call sites
    // can pre-render before a user has finished sign-up.
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(username)) {
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid username");
    }
    const svg = renderPlaceholderSvg(username);
    return new Response(svg, {
      status: 200,
      headers: {
        "Content-Type": "image/svg+xml",
        // Daily revalidation; placeholder SVGs are pure functions of
        // username so a long cache is safe. Strong ETag from the SHA of
        // the body itself for revalidation cheapness.
        "Cache-Control": "public, max-age=86400, immutable",
        ETag: `"${createHash("sha256").update(svg).digest("hex").slice(0, 16)}"`,
      },
    });
  });

  return router;
}

// Exposed for tests.
export {
  buildProfile,
  renderPlaceholderSvg,
  placeholderInitials,
  placeholderColor,
};
