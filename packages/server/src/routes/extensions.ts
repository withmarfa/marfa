/**
 * Extension routes — namespaced metadata on items.
 *
 * Namespace ownership: a key can always write to the namespace matching its
 * label (e.g. a key with label "noter" can write to the "noter" namespace).
 * This coupling is intentional — the key label IS the namespace identity.
 * Additional access can be granted via extension_permissions on the key.
 *
 * Reserved namespaces (core, marfa, system) cannot be written to by non-admin keys.
 */

import { createRoute, z } from "@hono/zod-openapi";
import {
  MarfaError,
  ErrorCode,
  isValidId,
  resolveExtensionPermission,
  filterExtensionsByPermission,
} from "@withmarfa/shared";
import type { ApiKey } from "@withmarfa/shared";

const RESERVED_NAMESPACES = new Set(["core", "marfa", "system"]);

/**
 * Reserved extension namespaces are the metadata-layer twin of the
 * reserved *type* namespaces, which `checkTypeAccess` gates on
 * `is_platform` rather than on rank. Read them the same way: platform
 * authority, or an explicit platform credential — never rank alone. A
 * tenant-bound `admin` (the shape `POST /admin/tenants/{id}/keys` mints)
 * is admin within one tenant, not a platform principal, so it does not
 * qualify to write platform-internal namespaces.
 */
function mayWriteReservedNamespace(apiKey: ApiKey | undefined): boolean {
  if (!apiKey) return false;
  return hasPlatformAuthority(apiKey) || apiKey.is_platform;
}

/** The `connection.runtime` namespace is reserved for the
 *  per-Connection runtime credential's hot state. Only credentials
 *  minted by the lease broker (is_runtime_credential + connection_id
 *  stamped) can write it; admin keys can read but not write so
 *  operators can inspect runtime state in the UI without corrupting
 *  it. */
const RUNTIME_NAMESPACE = "connection.runtime";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  roleBypassesPermissionMaps,
  hasPlatformAuthority,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";

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
    "Replaces the JSON payload for one extension namespace on the item, requiring `write` on that namespace. The body is capped at 100KB; reserved namespaces such as `connection.runtime` carry additional write constraints.",
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
    "Removes one extension namespace from the item, requiring `write` on that namespace. Idempotent — deleting a namespace that doesn't exist returns 200 with the unchanged extensions response.",
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
    const tid = apiKey?.tenant_id;
    const item = await storage.items.get(id, tid);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    const extensions = await storage.metadata.getExtensions(id);
    const filtered = filterExtensionsByPermission(
      extensions,
      apiKey?.extension_permissions,
      apiKey?.label ?? "",
      roleBypassesPermissionMaps(apiKey),
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
    const tid = apiKey?.tenant_id;
    const item = await storage.items.get(id, tid);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    const perm = roleBypassesPermissionMaps(apiKey)
      ? "write"
      : resolveExtensionPermission(
          namespace,
          apiKey?.extension_permissions,
          apiKey?.label ?? "",
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
    const tid = apiKey?.tenant_id;
    const item = await storage.items.get(id, tid);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    // connection.runtime is the runtime credential's hot-state subtree.
    // Only credentials minted by the lease broker may write it, and
    // only to the matching connection's item. Admin keys can read but
    // not write so operators can inspect runtime state without
    // corrupting it.
    if (namespace === RUNTIME_NAMESPACE) {
      if (!apiKey?.is_runtime_credential) {
        throw new MarfaError(
          ErrorCode.FORBIDDEN,
          `Namespace "${RUNTIME_NAMESPACE}" is writable only by runtime credentials`,
        );
      }
      if (apiKey.connection_id !== id) {
        throw new MarfaError(
          ErrorCode.FORBIDDEN,
          `Runtime credential for connection ${apiKey.connection_id ?? "unset"} cannot write the runtime namespace of connection ${id}`,
        );
      }
    } else if (
      RESERVED_NAMESPACES.has(namespace) &&
      !mayWriteReservedNamespace(apiKey)
    ) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        `Namespace "${namespace}" is reserved`,
      );
    }

    if (namespace !== RUNTIME_NAMESPACE) {
      const perm = roleBypassesPermissionMaps(apiKey)
        ? "write"
        : resolveExtensionPermission(
            namespace,
            apiKey?.extension_permissions,
            apiKey?.label ?? "",
          );
      if (perm !== "write") {
        throw new MarfaError(
          ErrorCode.FORBIDDEN,
          `No write access to extension namespace "${namespace}"`,
        );
      }
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

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
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
    const tid = apiKey?.tenant_id;
    const item = await storage.items.get(id, tid);
    if (!item) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    if (namespace === RUNTIME_NAMESPACE) {
      if (!apiKey?.is_runtime_credential) {
        throw new MarfaError(
          ErrorCode.FORBIDDEN,
          `Namespace "${RUNTIME_NAMESPACE}" is writable only by runtime credentials`,
        );
      }
      if (apiKey.connection_id !== id) {
        throw new MarfaError(
          ErrorCode.FORBIDDEN,
          `Runtime credential for connection ${apiKey.connection_id ?? "unset"} cannot delete the runtime namespace of connection ${id}`,
        );
      }
    } else if (
      RESERVED_NAMESPACES.has(namespace) &&
      !mayWriteReservedNamespace(apiKey)
    ) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        `Namespace "${namespace}" is reserved`,
      );
    } else {
      const isOwner = apiKey?.label === namespace;
      if (!roleBypassesPermissionMaps(apiKey) && !isOwner) {
        const perm = resolveExtensionPermission(
          namespace,
          apiKey?.extension_permissions,
          apiKey?.label ?? "",
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
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
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
