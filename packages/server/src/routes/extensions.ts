/**
 * Extension routes — namespaced metadata on items.
 *
 * Namespace ownership: a key can always write to the namespace matching its
 * label (e.g. a key with label "noter" can write to the "noter" namespace).
 * This coupling is intentional — the key label IS the namespace identity.
 * Additional access can be granted via extension_permissions on the key.
 *
 * Reserved namespaces (core, myme, system) cannot be written to by non-admin keys.
 */

import { createRoute, z } from "@hono/zod-openapi";
import {
  MymeError,
  ErrorCode,
  isValidId,
  resolveExtensionPermission,
  filterExtensionsByPermission,
} from "@mymehq/shared";

const RESERVED_NAMESPACES = new Set(["core", "myme", "system"]);

/** Workstream 3 Layer 1 PR 4: the `connection.runtime` namespace is
 *  reserved for the per-Connection runtime credential's hot state.
 *  Only credentials minted by the lease broker (is_runtime_credential
 *  + connection_id stamped) can write it; admin keys can read but not
 *  write so operators can inspect runtime state in the UI without
 *  corrupting it. */
const RUNTIME_NAMESPACE = "connection.runtime";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, ErrorResponseSchema } from "../openapi.js";

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
  method: "get",
  path: "/{id}/extensions",
  tags: ["Extensions"],
  summary: "List extension namespaces for an item",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid item ID",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Item not found",
    },
  },
});

const getExtensionRoute = createRoute({
  method: "get",
  path: "/{id}/extensions/{namespace}",
  tags: ["Extensions"],
  summary: "Get an extension namespace",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
      namespace: z.string(),
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid item ID",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "No read access to namespace",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Item not found",
    },
  },
});

const setExtensionRoute = createRoute({
  method: "put",
  path: "/{id}/extensions/{namespace}",
  tags: ["Extensions"],
  summary: "Replace an extension namespace",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
      namespace: z.string(),
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Validation error",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "No write access to namespace",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Item not found",
    },
  },
});

const deleteExtensionRoute = createRoute({
  method: "delete",
  path: "/{id}/extensions/{namespace}",
  tags: ["Extensions"],
  summary: "Delete an extension namespace",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
      namespace: z.string(),
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid item ID",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "No write access to namespace",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Item not found",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function extensionRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  // GET /items/:id/extensions — list all namespaces (filtered by permissions)
  router.openapi(listExtensionsRoute, async (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const apiKey = c.get("apiKey");
    const tid = apiKey?.tenant_id;
    const item = await storage.items.get(id, tid);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    const extensions = await storage.metadata.getExtensions(id);
    const filtered = filterExtensionsByPermission(
      extensions,
      apiKey?.extension_permissions,
      apiKey?.label ?? "",
      apiKey?.role === "admin",
    );

    return c.json({ extensions: filtered }, 200);
  });

  // GET /items/:id/extensions/:namespace — read a specific namespace
  router.openapi(getExtensionRoute, async (c) => {
    requireAuth(c);
    const { id, namespace } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const apiKey = c.get("apiKey");
    const tid = apiKey?.tenant_id;
    const item = await storage.items.get(id, tid);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    const perm =
      apiKey?.role === "admin"
        ? "write"
        : resolveExtensionPermission(
            namespace,
            apiKey?.extension_permissions,
            apiKey?.label ?? "",
          );
    if (perm === "none") {
      throw new MymeError(
        ErrorCode.FORBIDDEN,
        `No read access to extension namespace "${namespace}"`,
      );
    }

    const extensions = await storage.metadata.getExtensions(id);
    const data = extensions[namespace] ?? null;

    return c.json({ namespace, data }, 200);
  });

  // PUT /items/:id/extensions/:namespace — write to a specific namespace
  router.openapi(setExtensionRoute, async (c) => {
    requireAuth(c);
    const { id, namespace } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const apiKey = c.get("apiKey");
    const tid = apiKey?.tenant_id;
    const item = await storage.items.get(id, tid);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    // Workstream 3 Layer 1 PR 4: connection.runtime is the runtime
    // credential's hot-state subtree. Only credentials minted by the
    // lease broker may write it, and only to the matching connection's
    // item. Admin keys can read but not write so operators can inspect
    // runtime state in the UI without corrupting it.
    if (namespace === RUNTIME_NAMESPACE) {
      if (!apiKey?.is_runtime_credential) {
        throw new MymeError(
          ErrorCode.FORBIDDEN,
          `Namespace "${RUNTIME_NAMESPACE}" is writable only by runtime credentials`,
        );
      }
      if (apiKey.connection_id !== id) {
        throw new MymeError(
          ErrorCode.FORBIDDEN,
          `Runtime credential for connection ${apiKey.connection_id ?? "unset"} cannot write the runtime namespace of connection ${id}`,
        );
      }
    } else if (RESERVED_NAMESPACES.has(namespace) && apiKey?.role !== "admin") {
      throw new MymeError(
        ErrorCode.FORBIDDEN,
        `Namespace "${namespace}" is reserved`,
      );
    }

    // The general permission gate runs for non-runtime writes. Runtime
    // credentials bypass it on the connection.runtime namespace because
    // the dedicated check above fully covers that case.
    if (namespace !== RUNTIME_NAMESPACE) {
      const perm =
        apiKey?.role === "admin"
          ? "write"
          : resolveExtensionPermission(
              namespace,
              apiKey?.extension_permissions,
              apiKey?.label ?? "",
            );
      if (perm !== "write") {
        throw new MymeError(
          ErrorCode.FORBIDDEN,
          `No write access to extension namespace "${namespace}"`,
        );
      }
    }

    const body = c.req.valid("json");

    // Enforce extension data size limit (100KB per namespace)
    const serialized = JSON.stringify(body);
    if (serialized.length > 102_400) {
      throw new MymeError(
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

  // DELETE /items/:id/extensions/:namespace — remove a namespace
  router.openapi(deleteExtensionRoute, async (c) => {
    requireAuth(c);
    const { id, namespace } = c.req.valid("param");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const apiKey = c.get("apiKey");
    const tid = apiKey?.tenant_id;
    const item = await storage.items.get(id, tid);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    // Workstream 3 Layer 1 PR 4: same gate as setExtensionRoute — only
    // the matching runtime credential may delete its own
    // connection.runtime namespace; admins read-only.
    if (namespace === RUNTIME_NAMESPACE) {
      if (!apiKey?.is_runtime_credential) {
        throw new MymeError(
          ErrorCode.FORBIDDEN,
          `Namespace "${RUNTIME_NAMESPACE}" is writable only by runtime credentials`,
        );
      }
      if (apiKey.connection_id !== id) {
        throw new MymeError(
          ErrorCode.FORBIDDEN,
          `Runtime credential for connection ${apiKey.connection_id ?? "unset"} cannot delete the runtime namespace of connection ${id}`,
        );
      }
    } else if (RESERVED_NAMESPACES.has(namespace) && apiKey?.role !== "admin") {
      throw new MymeError(
        ErrorCode.FORBIDDEN,
        `Namespace "${namespace}" is reserved`,
      );
    } else {
      // Only admin or namespace owner can delete
      const isOwner = apiKey?.label === namespace;
      if (apiKey?.role !== "admin" && !isOwner) {
        const perm = resolveExtensionPermission(
          namespace,
          apiKey?.extension_permissions,
          apiKey?.label ?? "",
        );
        if (perm !== "write") {
          throw new MymeError(
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
