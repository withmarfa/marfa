import { createRoute, z } from "@hono/zod-openapi";
import { readAttention } from "../attention.js";
import {
  requireDirectAuthority,
  standingRule,
  type AppEnv,
} from "../middleware/auth.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import type { Storage } from "../storage/interface.js";
import type { ConsoleHealth } from "./console-health.js";

const route = createRoute({
  method: "get",
  path: "/",
  operationId: "listAttention",
  tags: ["Health and maintenance"],
  summary: "List attention items",
  description:
    "Returns current concerns for the owner or a private local command. Failed or timed-out checks appear as unavailable items alongside known concerns. An empty list means every check completed without a concern.",
  security: [{ ownerSession: [] }],
  middleware: standingRule("owner or local command", requireDirectAuthority),
  request: { query: z.object({}) },
  responses: {
    200: {
      description: "Returns concerns and any checks whose state is unknown.",
      content: {
        "application/json": {
          schema: z
            .object({
              data: z
                .array(
                  z
                    .object({
                      kind: z
                        .enum([
                          "health",
                          "job",
                          "connector",
                          "folder",
                          "key",
                          "unavailable",
                        ])
                        .describe(
                          "health: degraded or down; job: failed last run; connector: failed, problems, or quiet; folder: sync concern; key: expires within seven days; unavailable: check failed or timed out.",
                        ),
                      reference: z
                        .string()
                        .describe(
                          "The component or job name, connector, folder, or key ID, or unavailable check name.",
                        ),
                      title: z
                        .string()
                        .describe("A short name for the concern."),
                      description: z
                        .string()
                        .describe("What needs attention or remains unknown."),
                      href: z
                        .string()
                        .describe("The local console path for the concern."),
                      tone: z
                        .enum(["warn", "danger"])
                        .optional()
                        .describe(
                          "warn: needs a look; danger: a component or connector failed. Present when the concern has a severity.",
                        ),
                    })
                    .openapi("AttentionConcern", {
                      description: "One known concern or unavailable check.",
                    }),
                )
                .describe(
                  "Every known concern and unavailable check; empty when all checks report no concerns.",
                ),
            })
            .openapi("AttentionList", {
              description:
                "The current attention inventory, without pagination.",
              example: { data: [] },
            }),
        },
      },
    },
    400: {
      description: "- `validation_error`: a query field is unknown.",
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
    },
    401: {
      description: "- `unauthorized`: authentication is required.",
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
    },
    403: {
      description:
        "- `forbidden`: only the owner or a private local command can read this inventory.",
      content: {
        "application/json": { schema: makeErrorResponseSchema(["forbidden"]) },
      },
    },
  },
});

export function attentionRoutes(storage: Storage, health: ConsoleHealth) {
  const router = createOpenAPIRouter<AppEnv>();
  router.openapi(route, async (c) => {
    requireDirectAuthority(c);
    return c.json({ data: await readAttention(storage, health) }, 200);
  });
  return router;
}
