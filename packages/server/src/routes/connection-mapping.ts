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
import { closeMappingBreaks } from "../connections/mapping-health.js";
import { resolveConnectionManifest } from "../connections/resolve-manifest.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";

/**
 * How long a "yes, bring the existing items" answer stays true.
 *
 * Twenty-four hours is generous against a corpus that takes several
 * scheduled runs to drain — an hourly sweep moving a slice per chain
 * clears a few thousand items well inside it — and short enough that an
 * answer nobody followed through on expires by itself.
 */
const REAPPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

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
    /**
     * Reported rather than assumed, because "the corpus is being brought
     * along" and "it was, and that has now lapsed" are different states
     * and a caller cannot tell them apart from the mapping alone.
     */
    reapply_until: z
      .string()
      .nullable()
      .optional()
      .describe(
        "While this instant is in the future, the connection's runs bring items already stored onto the type this mapping names. Null when no answer stands.",
      ),
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
    "Stores the user's routing for this connection: conditions on the incoming record choose the target type, and fields are assigned onto that type's schema. The document is validated wholesale — target types must resolve in the space (reserved namespaces refused), every assigned field must exist on its target, and required target fields must be covered. Shipped write families stay the default for records no rule matches.\n\nA mapping applies to what arrives next. `reapply=true` also brings the items already stored: the connection's next runs re-type the rows they resolve onto the type the mapping now names, instead of being refused as a type mismatch. Both answers are correct — declining leaves the older items where they are, which is a legitimate end state.\n\n**It re-types what the connection re-syncs, not the whole corpus.** A mapping's conditions read the upstream record, which is not stored anywhere, so nothing can replay a mapping against items already written; the items brought along are the ones the next runs fetch again. A record the upstream no longer returns keeps its old type.\n\nThe answer expires — see `reapply_until` in the response — rather than persisting until something clears it. A sweep that parks and never resumes, or a connection paused mid-run, would otherwise leave every future run re-typing a corpus nobody asked it to.",
  security: [{ bearerAuth: [] }],
  request: {
    params: ConnectionIdParam,
    query: z.object({
      reapply: z
        .enum(["true", "false"])
        .optional()
        .describe(
          "Bring the items already stored onto the type this mapping names. Omitted or `false` clears any answer still standing.",
        ),
    }),
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
    const props = item.properties as {
      mapping?: unknown;
      mapping_reapply_until?: unknown;
    };
    const mapping = props.mapping ?? null;
    // Returned on the read, not only on the write that set it. "The corpus
    // is being brought along" and "it was, and that has lapsed" are
    // different states, and until this was here the only caller who could
    // tell them apart was the one that had just supplied the answer — so a
    // settings page reloading the connection could not see a live window,
    // which is the question the deadline exists to answer.
    const reapplyUntil =
      typeof props.mapping_reapply_until === "string"
        ? props.mapping_reapply_until
        : null;
    return c.json(
      { connection_id: id, mapping, reapply_until: reapplyUntil },
      200,
    );
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

    // How long an answered "yes" stays true. A deadline rather than a
    // flag cleared on success, because a state that can only be left
    // through the happy path is a state that can be entered and never
    // left: a sweep that parks and never resumes, or a connection paused
    // mid-run, would leave every future run re-typing rows nobody asked
    // it to. It also answers the question a person will actually ask —
    // why is this still on — with a time rather than a hunt through run
    // history.
    const reapplyUntil =
      c.req.valid("query").reapply === "true"
        ? new Date(Date.now() + REAPPLY_WINDOW_MS).toISOString()
        : null;

    await storage.items.update(
      id,
      {
        properties: {
          ...item.properties,
          mapping: validated.mapping,
          mapping_reapply_until: reapplyUntil,
        },
        // The answer is a fresh one every time a mapping is saved, so a
        // "no" has to clear a "yes" still standing rather than leave it
        // in place. A shallow merge cannot express that without this.
        null_clears: true,
      },
      apiKey.space_id,
    );
    // A mapping that validates answers whatever break was reported against
    // it, so the row leaves the Repairs inbox rather than sitting in it as
    // a permanent complaint about a document that is now correct.
    const closed = await closeMappingBreaks(storage, id, apiKey.space_id);
    void storage.audit.log({
      action: "connection.mapping_set",
      resource_type: "system.connection",
      resource_id: id,
      client_ip: c.var.clientIp,
      details: {
        rules: validated.mapping.rules.length,
        breaks_closed: closed,
        reapply: reapplyUntil !== null,
      },
    });
    return c.json(
      {
        connection_id: id,
        mapping: validated.mapping,
        reapply_until: reapplyUntil,
      },
      200,
    );
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
      {
        // The answer goes with the question. A standing "bring the corpus
        // along" against a mapping that no longer exists could only move
        // rows towards whatever the write family writes, which is not
        // what anybody agreed to.
        properties: { mapping: null, mapping_reapply_until: null },
        null_clears: true,
      },
      apiKey.space_id,
    );
    // Clearing the mapping answers the break as surely as repairing it:
    // there is no longer a document naming a type that does not resolve.
    const closed = await closeMappingBreaks(storage, id, apiKey.space_id);
    void storage.audit.log({
      action: "connection.mapping_cleared",
      resource_type: "system.connection",
      resource_id: id,
      client_ip: c.var.clientIp,
      details: { breaks_closed: closed },
    });
    return c.json({ connection_id: id, mapping: null }, 200);
  });

  return router;
}
