import { createRoute, z } from "@hono/zod-openapi";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import {
  directAuthorityOnly,
  requireRecentOwnerAuthentication,
  type AppEnv,
} from "../middleware/auth.js";
import {
  createOpenAPIRouter,
  makeErrorResponseSchema,
  OkResponseSchema,
} from "../openapi.js";
import type { Storage } from "../storage/interface.js";
import type { MarfaAuth, OwnerPasskey } from "../auth/instance.js";
import { SIGN_IN_NAME_MAX, UNPRINTABLE } from "../auth/sign-in-names.js";
const PasskeySchema = z
  .object({
    id: z
      .string()
      .describe("Unique identifier for the passkey.")
      .openapi({ example: "Q2xYvR8mKp4TnW6aBc0dEf1gHi3jKl5M" }),
    name: z
      .string()
      .nullable()
      .describe("The owner's name for the passkey, or `null` when unnamed."),
    created_at: z
      .string()
      .describe("When the passkey was registered, in UTC.")
      .openapi({ example: "2026-10-03T09:30:00.000Z" }),
  })
  .describe("An owner's registered passkey, without credential material.")
  .openapi("OwnerPasskey");
const params = z.object({ id: z.string().describe("The ID of the passkey.") });
const failure = (
  codes: Parameters<typeof makeErrorResponseSchema>[0],
  description: string,
) => ({
  content: { "application/json": { schema: makeErrorResponseSchema(codes) } },
  description,
});
const authFailures = {
  401: failure(["unauthorized"], "Sign in as the owner."),
  403: failure(
    ["forbidden"],
    "Requires direct owner or local authority. Mutations require an owner sign-in within five minutes.",
  ),
};
const missing = failure(
  ["passkey_not_found"],
  "No registered passkey of the owner has this ID.",
);
const list = createRoute({
  operationId: "listOwnerPasskeys",
  method: "get",
  path: "/",
  tags: ["Access"],
  summary: "List passkeys",
  security: [{ ownerSession: [] }],
  middleware: directAuthorityOnly,
  description:
    "Returns every registered owner passkey, oldest first. Requires the owner's browser session or private local authority.",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z
            .object({
              data: z
                .array(PasskeySchema)
                .describe("Every registered owner passkey, oldest first."),
              next_cursor: z
                .null()
                .describe(
                  "Always `null`: every passkey is returned in one page.",
                ),
            })
            .describe("Every registered owner passkey.")
            .openapi("OwnerPasskeyList"),
        },
      },
      description: "Returns every registered owner passkey.",
    },
    ...authFailures,
  },
});
const rename = createRoute({
  operationId: "updateOwnerPasskey",
  method: "patch",
  path: "/{id}",
  tags: ["Access"],
  summary: "Rename a passkey",
  security: [{ ownerSession: [] }],
  middleware: directAuthorityOnly,
  description:
    "Renames the passkey and returns its public details. Requires the owner's browser session authenticated within five minutes or private local authority.",
  request: {
    params,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.strictObject({
            name: z
              .string()
              .refine(
                (name) =>
                  !UNPRINTABLE.test(name) && !/\p{Bidi_Control}/u.test(name),
                {
                  message:
                    "name can't hold a control or bidirectional formatting character",
                },
              )
              .trim()
              .min(1)
              .max(SIGN_IN_NAME_MAX)
              .describe("The new name. Marfa trims spaces from each end."),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: PasskeySchema } },
      description: "Returns the renamed passkey.",
    },
    400: failure(
      ["missing_required_field", "validation_error"],
      "The name is missing, empty, too long, or holds a control or bidirectional character, or the body contains another field.",
    ),
    ...authFailures,
    404: missing,
  },
});
const remove = createRoute({
  operationId: "removeOwnerPasskey",
  method: "delete",
  path: "/{id}",
  tags: ["Access"],
  summary: "Remove a passkey",
  security: [{ ownerSession: [] }],
  middleware: directAuthorityOnly,
  description:
    "Removes one passkey so it cannot sign in again. Existing sign-ins remain usable. Requires the owner's browser session authenticated within five minutes or private local authority.",
  request: { params },
  responses: {
    200: {
      content: { "application/json": { schema: OkResponseSchema } },
      description: "Returns `ok: true`. The passkey was removed.",
    },
    ...authFailures,
    404: missing,
  },
});
function wire(row: OwnerPasskey) {
  return {
    id: row.id,
    name: row.name,
    created_at: row.createdAt.toISOString(),
  };
}
export function ownerPasskeyRoutes(storage: Storage, auth: MarfaAuth) {
  const router = createOpenAPIRouter<AppEnv>();
  const ownerId = async () => {
    const owner = await storage.owner?.find();
    if (!owner)
      throw new MarfaError(
        ErrorCode.OWNER_NOT_FOUND,
        "The owner's account is unavailable.",
      );
    return owner.id;
  };
  const notFound = () =>
    new MarfaError(
      ErrorCode.PASSKEY_NOT_FOUND,
      "No registered passkey of the owner has this ID.",
    );
  router.openapi(list, async (c) =>
    c.json(
      {
        data: (await auth.listOwnerPasskeys(await ownerId())).map(wire),
        next_cursor: null,
      },
      200,
    ),
  );
  router.openapi(rename, async (c) => {
    requireRecentOwnerAuthentication(c);
    const { id } = c.req.valid("param");
    const { name } = c.req.valid("json");
    const row = await auth.renameOwnerPasskey(
      await ownerId(),
      id,
      name,
      c.get("clientIp") ?? null,
    );
    if (!row) throw notFound();
    return c.json(wire(row), 200);
  });
  router.openapi(remove, async (c) => {
    requireRecentOwnerAuthentication(c);
    if (
      !(await auth.removeOwnerPasskey(
        await ownerId(),
        c.req.valid("param").id,
        c.get("clientIp") ?? null,
      ))
    )
      throw notFound();
    return c.json({ ok: true as const }, 200);
  });
  return router;
}
