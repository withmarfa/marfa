import { createRoute, z } from "@hono/zod-openapi";
import { NextCursorSchema } from "./_schemas.js";
import { directAuthorityOnly, standingPermission } from "../middleware/auth.js";
import { makeErrorResponseSchema } from "../openapi.js";
const error = (
  codes: Parameters<typeof makeErrorResponseSchema>[0],
  description: string,
) => ({
  content: { "application/json": { schema: makeErrorResponseSchema(codes) } },
  description,
});
const example = {
  id: "019980d6-7612-7000-8000-000000000001",
  kind: "app" as const,
  client_id: "reader",
  client_name: "Reader",
  origins: [],
  scopes: ["core.note:read"],
  status: "active",
  granted_at: "2026-10-03T09:30:00.000Z",
  last_used_at: null,
};
export const GrantSchema = z
  .object({
    id: z.string().describe("Unique identifier for the app's grant."),
    kind: z
      .enum(["app", "web", "cli"])
      .describe(
        "`cli` registered the `marfa` command line's `software_id`; otherwise `web` has approved web origins, and `app` is any other app.",
      ),
    client_id: z.string().describe("The ID of the registered app."),
    client_name: z
      .string()
      .nullable()
      .describe("The app's registered name, or null if unavailable."),
    origins: z
      .array(z.string())
      .describe("Approved web origins, empty for a native app."),
    scopes: z
      .array(z.string())
      .describe("The access the owner approved for the app."),
    status: z.string().describe("The grant's status."),
    granted_at: z
      .string()
      .describe("When the owner last approved the app, in UTC."),
    last_used_at: z
      .string()
      .nullable()
      .describe(
        "When the app last used its access, in UTC, or null if never used.",
      ),
  })
  .describe("An app's standing access to Marfa.")
  .openapi("AppGrant", { example });
const path = z.object({
  id: z.string().describe("The ID of the app's grant."),
});
const security: Record<string, string[]>[] = [
  { bearerAuth: [] },
  { ownerSession: [] },
];
export const listGrantsRoute = createRoute({
  method: "get",
  path: "/grants",
  operationId: "listAppGrants",
  tags: ["Access"],
  security,
  middleware: standingPermission("grants.manage"),
  summary: "List app grants",
  description:
    "Returns every active app grant in one page. Requires `grants.manage` or direct authority.",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z
            .object({
              data: z.array(GrantSchema).describe("Every active app grant."),
              next_cursor: NextCursorSchema.describe(
                "Always null: every grant is returned in one page.",
              ),
            })
            .describe("The active app grants.")
            .openapi("AppGrantList", {
              example: { data: [example], next_cursor: null },
            }),
        },
      },
      description: "Returns every active app grant.",
    },
    401: error(["unauthorized"], "- `unauthorized`: a credential is required."),
    403: error(
      ["forbidden"],
      "- `forbidden`: the credential lacks `grants.manage`.",
    ),
  },
});
export const deleteGrantRoute = createRoute({
  method: "delete",
  path: "/grants/{id}",
  operationId: "revokeAppGrant",
  tags: ["Access"],
  security,
  middleware: standingPermission("grants.manage"),
  summary: "Revoke an app grant",
  description:
    "Revokes the app's tokens and consent. Requires `grants.manage` or direct authority; an owner browser needs a sign-in within five minutes.",
  request: {
    params: path,
    query: z.object({
      revoke_keys: z
        .string()
        .optional()
        .describe(
          "`true` or `1` also revokes keys the app minted. Every other value, or omission, leaves those keys working.",
        ),
    }),
  },
  responses: {
    204: { description: "The app's grant is revoked." },
    401: error(["unauthorized"], "- `unauthorized`: a credential is required."),
    403: error(
      ["forbidden"],
      "- `forbidden`: the credential lacks `grants.manage`, or the owner must confirm a recent sign-in.",
    ),
    404: error(
      ["oauth_grant_not_found"],
      "- `oauth_grant_not_found`: the ID does not name an app grant.",
    ),
  },
});
export const narrowGrantRoute = createRoute({
  method: "patch",
  path: "/grants/{id}",
  operationId: "narrowAppGrant",
  tags: ["Access"],
  security: [{ ownerSession: [] }],
  middleware: directAuthorityOnly,
  summary: "Narrow an app grant",
  description:
    "Narrows standing access. Requires a recent owner sign-in or private authority. Overbroad tokens, their refresh chains and pending codes end; covered chains keep working. The app may need to reconnect. Minted keys keep working.",
  request: {
    params: path,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.strictObject({
            scopes: z
              .array(z.string().min(1))
              .max(1000)
              .describe(
                "The complete resulting scope set, no wider than the current grant.",
              ),
            expected_scopes: z
              .array(z.string())
              .max(1000)
              .describe(
                "The complete scope set last read from the grant. A changed grant refuses the update.",
              ),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z
            .object({
              scopes: z.array(z.string()).describe("The resulting scope set."),
            })
            .describe("The app's narrowed access.")
            .openapi("NarrowedAppGrant", {
              example: { scopes: ["core.note:read"] },
            }),
        },
      },
      description: "Returns the app's narrowed access.",
    },
    400: error(
      ["validation_error", "missing_required_field"],
      "- `validation_error`: the body has an invalid or unknown field.\n- `missing_required_field`: a required field is absent.",
    ),
    401: error(["unauthorized"], "- `unauthorized`: a credential is required."),
    403: error(
      ["forbidden"],
      "- `forbidden`: direct recent owner or private machine authority is required, or the requested scopes widen access.",
    ),
    404: error(
      ["oauth_grant_not_found"],
      "- `oauth_grant_not_found`: the ID does not name a live app grant.",
    ),
    409: error(
      ["conflict"],
      "- `conflict`: the grant's scopes changed; read them again before submitting.",
    ),
  },
});
