/**
 * The per-connection user-mapping surface: read, set, and clear the
 * mapping document on `system.connection.properties.mapping`.
 *
 * A JSON surface rather than a form: a mapping is a structured document
 * a client composes, and the configure page's key-value form has no
 * vocabulary for rules. Validation is wholesale at PUT — every refusal
 * names the field — and only integrations whose manifest declares
 * `supports_user_mappings` accept one, so a stored mapping can never be
 * silently ignored by a handler that predates the mechanism.
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  ErrorCode,
  MarfaError,
  validateConnectionMapping,
  type Item,
} from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireSpaceAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { resolveConnectionManifest } from "../connections/resolve-manifest.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";

const ConnectionIdParam = z.object({
  id: z.string().min(1).openapi({ description: "Connection item id" }),
});

const MappingBodySchema = z
  .looseObject({
    version: z.literal(1),
    rules: z.array(z.unknown()).min(1),
    otherwise: z.enum(["family", "skip"]).optional(),
  })
  .openapi("ConnectionMappingDocument", {
    description:
      "The mapping document. Validated wholesale against the connection's space registry; each refusal names the offending field.",
  });

const MappingResponseSchema = z
  .object({
    connection_id: z.string(),
    mapping: z.unknown().nullable(),
  })
  .openapi("ConnectionMappingResponse");

const errorResponses = {
  401: {
    content: {
      "application/json": { schema: makeErrorResponseSchema(["unauthorized"]) },
    },
    description: "Missing or invalid bearer token.",
  },
  404: {
    content: {
      "application/json": { schema: makeErrorResponseSchema(["not_found"]) },
    },
    description: "Connection not found in the caller's space.",
  },
} as const;

const getMappingRoute = createRoute({
  operationId: "getConnectionMapping",
  method: "get",
  path: "/{id}/mapping",
  tags: ["Connections"],
  summary: "Read a connection's user mapping",
  security: [{ bearerAuth: [] }],
  request: { params: ConnectionIdParam },
  responses: {
    200: {
      content: { "application/json": { schema: MappingResponseSchema } },
      description: "The stored mapping, or null when none is configured.",
    },
    ...errorResponses,
  },
});

const putMappingRoute = createRoute({
  operationId: "setConnectionMapping",
  method: "put",
  path: "/{id}/mapping",
  tags: ["Connections"],
  summary: "Set a connection's user mapping",
  description:
    "Stores the user's routing for this connection: conditions on the incoming record choose the target type, and fields are assigned onto that type's schema. The document is validated wholesale — target types must resolve in the space (reserved namespaces refused), every assigned field must exist on its target, and required target fields must be covered. Shipped write families stay the default for records no rule matches.",
  security: [{ bearerAuth: [] }],
  request: {
    params: ConnectionIdParam,
    body: {
      content: { "application/json": { schema: MappingBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: MappingResponseSchema } },
      description: "Mapping stored.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description:
        "The mapping failed validation, or this integration does not consult user mappings.",
    },
    ...errorResponses,
  },
});

const deleteMappingRoute = createRoute({
  operationId: "clearConnectionMapping",
  method: "delete",
  path: "/{id}/mapping",
  tags: ["Connections"],
  summary: "Clear a connection's user mapping",
  security: [{ bearerAuth: [] }],
  request: { params: ConnectionIdParam },
  responses: {
    200: {
      content: { "application/json": { schema: MappingResponseSchema } },
      description: "Mapping cleared; the shipped write families apply again.",
    },
    ...errorResponses,
  },
});

export function connectionMappingRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  async function resolveConnection(
    id: string,
    spaceId: string | undefined,
  ): Promise<Item> {
    const item = await storage.items.get(id, spaceId);
    if (item?.type !== "system.connection") {
      throw new MarfaError(ErrorCode.NOT_FOUND, "Connection not found");
    }
    const kind = (item.properties as { kind?: string }).kind;
    if (kind !== "integration") {
      // App grants carry no runtime and write nothing, so a mapping on
      // one could only ever be dead configuration.
      throw new MarfaError(ErrorCode.NOT_FOUND, "Connection not found");
    }
    return item;
  }

  router.openapi(getMappingRoute, async (c) => {
    const apiKey = requireSpaceAdmin(c);
    const { id } = c.req.valid("param");
    const item = await resolveConnection(id, apiKey.space_id);
    const mapping = (item.properties as { mapping?: unknown }).mapping ?? null;
    return c.json({ connection_id: id, mapping }, 200);
  });

  router.openapi(putMappingRoute, async (c) => {
    const apiKey = requireSpaceAdmin(c);
    const { id } = c.req.valid("param");
    const item = await resolveConnection(id, apiKey.space_id);

    const resolved = await resolveConnectionManifest(
      storage,
      id,
      apiKey.space_id,
    );
    if (resolved.manifest.supports_user_mappings !== true) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "This integration does not consult user mappings; a stored mapping would be silently ignored",
      );
    }

    const body = await c.req.json();
    const validated = validateConnectionMapping(body, apiKey.space_id);
    if (!validated.ok) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "The mapping does not validate against this space's registry",
        { issues: validated.issues },
      );
    }

    await storage.items.update(
      id,
      { properties: { ...item.properties, mapping: validated.mapping } },
      apiKey.space_id,
    );
    void storage.audit.log({
      action: "connection.mapping_set",
      resource_type: "system.connection",
      resource_id: id,
      client_ip: c.var.clientIp,
      details: { rules: validated.mapping.rules.length },
    });
    return c.json({ connection_id: id, mapping: validated.mapping }, 200);
  });

  router.openapi(deleteMappingRoute, async (c) => {
    const apiKey = requireSpaceAdmin(c);
    const { id } = c.req.valid("param");
    await resolveConnection(id, apiKey.space_id);
    // Property updates merge shallowly, so removing a key takes an
    // explicit null under null_clears; re-sending the remainder without
    // the key would leave the stored value in place.
    await storage.items.update(
      id,
      { properties: { mapping: null }, null_clears: true },
      apiKey.space_id,
    );
    void storage.audit.log({
      action: "connection.mapping_cleared",
      resource_type: "system.connection",
      resource_id: id,
      client_ip: c.var.clientIp,
      details: {},
    });
    return c.json({ connection_id: id, mapping: null }, 200);
  });

  return router;
}
