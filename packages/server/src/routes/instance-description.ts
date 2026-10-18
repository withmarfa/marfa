import { createRoute, z } from "@hono/zod-openapi";
import { makeErrorResponseSchema } from "../openapi.js";

export const InstanceDescriptionSchema = z
  .object({
    name: z
      .string()
      .describe("The instance's display name. Defaults to `Marfa`."),
    version: z.string().describe("The build the instance runs."),
    instance_id: z
      .string()
      .describe(
        "Unique identifier for the instance. `GET /config` and an archive's manifest show the same value.",
      ),
    contract: z
      .number()
      .int()
      .min(0)
      .describe(
        "The contract version, the same number as this document's `info.version`. It stays at `0` until the first public release.",
      ),
    features: z
      .array(z.string())
      .describe(
        "The features the instance serves, such as `items` and `webhooks`.",
      ),
  })
  .describe("An instance: its identity, build, contract version and features.")
  .openapi("InstanceDescription");

export const instanceDescriptionRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "getInstance",
  tags: ["Instance"],
  summary: "Describe the instance",
  description:
    "Describes the instance: its display name, `instance_id`, the build it runs, the contract version it speaks and the features it serves. Needs no credential.",
  responses: {
    200: {
      description:
        "Returns the instance's description. A request whose `Accept` header prefers `text/html` gets an HTML page instead.",
      content: { "application/json": { schema: InstanceDescriptionSchema } },
    },
    400: {
      description:
        "- `validation_error`: the query has a parameter this endpoint doesn't take.",
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
    },
  },
});
