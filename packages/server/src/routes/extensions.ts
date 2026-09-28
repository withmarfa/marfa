/**
 * Extension routes — namespaced metadata on items.
 *
 * Namespace ownership: a key can always write to the namespace matching its
 * label (e.g. a key with label "noter" can write to the "noter" namespace).
 * This coupling is intentional — the key label IS the namespace identity.
 * Additional access can be granted via extension_permissions on the key.
 *
 * The namespace is the second of two gates. Every door first asks the key's
 * type map for the item's type, at `read` or `write` as the item doors do.
 *
 * **Reserved namespaces (core, marfa, system) are closed to every
 * credential.** What writes them is the platform's own machinery, through
 * the storage layer, which is also what writes a `system.*` row.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { extensionLabelOf } from "../auth/extension-label.js";
import {
  MarfaError,
  ErrorCode,
  isValidId,
  resolveExtensionPermission,
  filterExtensionsByPermission,
} from "@withmarfa/shared";

const RESERVED_NAMESPACES = new Set(["core", "marfa", "system"]);

import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, requireTypeAccess } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { publish } from "../pubsub.js";
import { itemAfterMetadataWrite } from "./_metadata-publish.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ExtensionsResponseSchema = z
  .object({
    extensions: z.record(z.string(), z.record(z.string(), z.unknown())),
  })
  .openapi("ExtensionsResponse");

const SingleExtensionResponseSchema = z.object({
  namespace: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listExtensionsRoute = createRoute({
  operationId: "listItemExtensions",
  method: "get",
  path: "/{id}/extensions",
  tags: ["Extensions"],
  summary: "List extension namespaces for an item",
  description:
    "Returns every extension namespace attached to the item that the caller has permission to read. Requires read on the item's type, refused `403 type_not_permitted` as `GET /items/{id}` refuses it. Namespaces the credential doesn't declare in its `extension_permissions` map are silently filtered out.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("Item ID."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ExtensionsResponseSchema,
        },
      },
      description: "Extension namespaces (filtered by permissions)",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_id"]),
        },
      },
      description: "Invalid item ID",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["type_not_permitted"]),
        },
      },
      description: "No read access to the item's type",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description: "Item not found",
    },
  },
});

const getExtensionRoute = createRoute({
  operationId: "getItemExtension",
  method: "get",
  path: "/{id}/extensions/{namespace}",
  tags: ["Extensions"],
  summary: "Get an extension namespace",
  description:
    "Returns the JSON payload for one extension namespace on the item. Two gates, in order: read on the item's type, refused `403 type_not_permitted` as `GET /items/{id}` refuses it, and then read on the namespace, refused `403 forbidden` whatever the caller holds on the type.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("Item ID."),
      namespace: z.string().describe("Extension namespace to read."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: SingleExtensionResponseSchema,
        },
      },
      description: "Extension namespace data",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_id"]),
        },
      },
      description: "Invalid item ID",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden", "type_not_permitted"]),
        },
      },
      description:
        "`type_not_permitted` without read on the item's type; `forbidden` without read on the namespace",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description: "Item not found",
    },
  },
});

const setExtensionRoute = createRoute({
  operationId: "replaceItemExtension",
  method: "put",
  path: "/{id}/extensions/{namespace}",
  tags: ["Extensions"],
  summary: "Replace an extension namespace",
  description:
    "Replaces the JSON payload for one extension namespace on the item, requiring write on the item's type, refused `403 type_not_permitted` as `PATCH /items/{id}` refuses it, and then `write` on that namespace, refused `403 forbidden`. The body is capped at 100KB, and the reserved namespaces `core`, `marfa` and `system` are refused to every credential. A successful write publishes `metadata.changed` carrying the item and its whole metadata row, so realtime subscribers and webhooks hear it as they do a tag change. No namespace is exempt from the announcement.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("Item ID."),
      namespace: z.string().describe("Extension namespace to replace."),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.record(z.string(), z.unknown()),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ExtensionsResponseSchema,
        },
      },
      description: "Updated extensions",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "invalid_id",
          ]),
        },
      },
      description: "Validation error",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden", "type_not_permitted"]),
        },
      },
      description:
        "`type_not_permitted` without write on the item's type; `forbidden` without write on the namespace",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description: "Item not found",
    },
  },
});

const deleteExtensionRoute = createRoute({
  operationId: "deleteItemExtension",
  method: "delete",
  path: "/{id}/extensions/{namespace}",
  tags: ["Extensions"],
  summary: "Delete an extension namespace",
  description:
    "Removes one extension namespace from the item, requiring write on the item's type, refused `403 type_not_permitted` as `PATCH /items/{id}` refuses it, and then `write` on that namespace, refused `403 forbidden`. Idempotent — deleting a namespace that doesn't exist returns 200 with the unchanged extensions response. Every call publishes `metadata.changed` carrying the item and its whole metadata row, including one that removes nothing, exactly as a tag write that changes nothing still publishes. No namespace is exempt from the announcement.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("Item ID."),
      namespace: z.string().describe("Extension namespace to delete."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ExtensionsResponseSchema,
        },
      },
      description: "Remaining extensions after deletion",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_id"]),
        },
      },
      description: "Invalid item ID",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden", "type_not_permitted"]),
        },
      },
      description:
        "`type_not_permitted` without write on the item's type; `forbidden` without write on the namespace",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description: "Item not found",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function extensionRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(listExtensionsRoute, async (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const apiKey = c.get("apiKey");
    const item = await storage.items.get(id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }
    requireTypeAccess(c, item.type, "read");

    const extensions = await storage.metadata.getExtensions(id);
    const filtered = filterExtensionsByPermission(
      extensions,
      apiKey?.extension_permissions,
      extensionLabelOf(apiKey),
    );

    return c.json({ extensions: filtered }, 200);
  });

  router.openapi(getExtensionRoute, async (c) => {
    requireAuth(c);
    const { id, namespace } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const apiKey = c.get("apiKey");
    const item = await storage.items.get(id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }
    requireTypeAccess(c, item.type, "read");

    const perm = resolveExtensionPermission(
      namespace,
      apiKey?.extension_permissions,
      extensionLabelOf(apiKey),
    );
    if (perm === "none") {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        `No read access to extension namespace "${namespace}"`,
      );
    }

    const extensions = await storage.metadata.getExtensions(id);
    const data = extensions[namespace] ?? null;

    return c.json({ namespace, data }, 200);
  });

  router.openapi(setExtensionRoute, async (c) => {
    requireAuth(c);
    const { id, namespace } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const apiKey = c.get("apiKey");
    const item = await storage.items.get(id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }
    // An extension is part of the item's row, so the item's type gate runs
    // first, as it does on the tag doors, whatever the namespace grants.
    requireTypeAccess(c, item.type, "write");

    if (RESERVED_NAMESPACES.has(namespace)) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        `Namespace "${namespace}" is reserved`,
      );
    }

    const perm = resolveExtensionPermission(
      namespace,
      apiKey?.extension_permissions,
      extensionLabelOf(apiKey),
    );
    if (perm !== "write") {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        `No write access to extension namespace "${namespace}"`,
      );
    }

    const body = c.req.valid("json");

    const serialized = JSON.stringify(body);
    if (serialized.length > 102_400) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Extension data exceeds maximum size of 100KB",
      );
    }

    const extensions = await storage.metadata.setExtension(id, namespace, body);

    // The extensions map and the tags are one metadata row, and the four
    // doors that write the other half of it publish. A subscriber cannot
    // tell which door wrote the row, so emitting for one and not the other
    // makes propagation depend on which the writer happened to use — and an
    // app storing sidecar state here changed a record no second device was
    // ever told about.
    //
    // Read the row back rather than composing the event from the extensions
    // this call returned: the payload carries the whole metadata, and half
    // of it is the half this door did not touch.
    await publish({
      type: "metadata_changed",
      item: await itemAfterMetadataWrite(storage, item),
      metadata: await storage.metadata.get(id),
    });

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: c.get("apiKey")?.id,
      action: "extension.set",
      resource_type: "item",
      resource_id: id,
      details: { namespace },
    });
    return c.json({ extensions }, 200);
  });

  router.openapi(deleteExtensionRoute, async (c) => {
    requireAuth(c);
    const { id, namespace } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const apiKey = c.get("apiKey");
    const item = await storage.items.get(id);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }
    // An extension is part of the item's row, so the item's type gate runs
    // first, as it does on the tag doors, whatever the namespace grants.
    requireTypeAccess(c, item.type, "write");

    if (RESERVED_NAMESPACES.has(namespace)) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        `Namespace "${namespace}" is reserved`,
      );
    } else {
      const isOwner = extensionLabelOf(apiKey) === namespace;
      if (!isOwner) {
        const perm = resolveExtensionPermission(
          namespace,
          apiKey?.extension_permissions,
          extensionLabelOf(apiKey),
        );
        if (perm !== "write") {
          throw new MarfaError(
            ErrorCode.FORBIDDEN,
            `No write access to extension namespace "${namespace}"`,
          );
        }
      }
    }

    const extensions = await storage.metadata.deleteExtension(id, namespace);

    // A removal is as observable as a write, and for the same reason as
    // the replace door above: the namespace's absence from the payload is
    // how a subscriber learns to drop its own copy.
    await publish({
      type: "metadata_changed",
      item: await itemAfterMetadataWrite(storage, item),
      metadata: await storage.metadata.get(id),
    });

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: c.get("apiKey")?.id,
      action: "extension.delete",
      resource_type: "item",
      resource_id: id,
      details: { namespace },
    });
    return c.json({ extensions }, 200);
  });

  return router;
}
