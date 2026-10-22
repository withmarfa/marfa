import { createRoute } from "@hono/zod-openapi";
import {
  ErrorCode,
  MarfaError,
  profilePermissionCovers,
} from "@withmarfa/shared";
import {
  authorityId,
  requireAuth,
  standingRule,
  type AppEnv,
} from "../middleware/auth.js";
import {
  createOpenAPIRouter,
  makeErrorResponseSchema,
  OkResponseSchema,
} from "../openapi.js";
import { ProfileUpdateSchema } from "../profile-fields.js";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
import type { Storage } from "../storage/interface.js";
import { setNoStore } from "./no-store.js";
import { profilePictureRoutes } from "./picture.js";

const updateProfileRoute = createRoute({
  operationId: "updateProfile",
  method: "patch",
  path: "/",
  tags: ["Owner"],
  summary: "Update the owner's profile",
  description:
    "Updates the owner's name or removes the picture and returns `ok: true`. Requires profile write permission for every submitted field; email cannot be changed here. All fields commit together.",
  security: [{ bearerAuth: [] }],
  middleware: standingRule("profile write on name or avatar", (c) => {
    const key = requireAuth(c);
    if (
      !["name", "avatar"].some((field) =>
        profilePermissionCovers(key.profile_permissions, field, "write"),
      )
    )
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        "This credential has no writable profile field",
      );
  }),
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: ProfileUpdateSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: OkResponseSchema } },
      description: "Returns ok: true. The profile was updated.",
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
      description:
        "The body is empty, contains an unknown field, or a field is invalid.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "The credential is missing, revoked, or expired.",
    },
    403: {
      content: {
        "application/json": { schema: makeErrorResponseSchema(["forbidden"]) },
      },
      description:
        "The credential lacks profile write permission for a submitted field.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["owner_not_found"]),
        },
      },
      description: "The owner is unavailable.",
    },
  },
});

export function profileRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();
  router.openapi(updateProfileRoute, async (c) => {
    setNoStore(c);
    requireAuth(c);
    const body = c.req.valid("json");
    await runAuditedTransaction(
      storage,
      async () => {
        const key = requireAuth(c);
        for (const field of Object.keys(body)) {
          if (!profilePermissionCovers(key.profile_permissions, field, "write"))
            throw new MarfaError(
              ErrorCode.FORBIDDEN,
              `Missing profile.${field}:write permission`,
            );
        }
        if (!(await storage.owner?.update(body)))
          throw new MarfaError(
            ErrorCode.OWNER_NOT_FOUND,
            "The owner is unavailable.",
          );
      },
      {
        action: "profile.update",
        resource_type: "auth_user",
        key_id: authorityId(c),
        client_ip: c.get("clientIp") ?? null,
        details: { fields: Object.keys(body) },
      },
    );
    return c.json({ ok: true as const }, 200);
  });
  router.route("/picture", profilePictureRoutes(storage));
  return router;
}
