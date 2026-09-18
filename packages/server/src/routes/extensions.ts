/**
 * Extension routes — namespaced metadata on items.
 *
 * Namespace ownership: a key can always write to the namespace matching its
 * label (e.g. a key with label "noter" can write to the "noter" namespace).
 * This coupling is intentional — the key label IS the namespace identity.
 * Additional access can be granted via extension_permissions on the key.
 *
 * **Reserved namespaces (core, marfa, system) are closed to every
 * credential.** They used to be fenced to the operator key, with the
 * extension permission map consulted after the flag, so a writer had to hold
 * both. Nothing can: the row constraint makes `is_operator` and space-less
 * the same thing, and a space-less credential holds no permissions at all, so
 * the map refused whatever the fence said. The fence went rather than staying
 * as a gate that could not answer. What writes these namespaces is the
 * platform's own machinery, through the storage layer, which is also what
 * writes a `system.*` row.
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
import { requireAuth } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { publish } from "../pubsub.js";
import { itemAfterMetadataWrite } from "./_metadata-publish.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ExtensionsResponseSchema = z.object({
  extensions: z.record(z.string(), z.record(z.string(), z.unknown())),
});

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
    "Returns every extension namespace attached to the item that the caller has permission to read. Namespaces the credential doesn't declare in its `extension_permissions` map are silently filtered out.",
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
    "Returns the JSON payload for one extension namespace on the item. Missing `read` permission on the namespace returns `403 forbidden`, regardless of the caller's type access to the parent item.",
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
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "No read access to namespace",
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
    "Replaces the JSON payload for one extension namespace on the item, requiring `write` on that namespace. The body is capped at 100KB; reserved namespaces such as `connection.runtime` carry additional write constraints. A successful write publishes `metadata.changed` carrying the item and its whole metadata row, so realtime subscribers and webhooks hear it as they do a tag change. Namespaces under the reserved `connection.` root are the exception and stay silent: they carry per-Connection runtime state written on the machine's behalf.",
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
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "No write access to namespace",
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
    "Removes one extension namespace from the item, requiring `write` on that namespace. Idempotent — deleting a namespace that doesn't exist returns 200 with the unchanged extensions response. Every call publishes `metadata.changed` carrying the item and its whole metadata row, including one that removes nothing, exactly as a tag write that changes nothing still publishes. Namespaces under the reserved `connection.` root stay silent.",
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
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "No write access to namespace",
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
