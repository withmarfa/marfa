/**
 * Extension routes — namespaced metadata on items.
 *
 * Namespace ownership: a key can always write to the namespace matching its
 * label (e.g. a key with label "noter" can write to the "noter" namespace).
 * This coupling is intentional — the key label IS the namespace identity.
 * Additional access can be granted via extension_permissions on the key.
 */
import { Hono } from "hono";
import {
  ProtocolError,
  ErrorCode,
  isValidId,
  resolveExtensionPermission,
  filterExtensionsByPermission,
} from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";

export function extensionRoutes(storage: Storage): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // GET /items/:id/extensions — list all namespaces (filtered by permissions)
  router.get("/:id/extensions", async (c) => {
    requireAuth(c);
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new ProtocolError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const apiKey = c.get("apiKey");
    const tid = apiKey?.tenant_id;
    const item = await storage.items.get(id, tid);
    if (!item) {
      throw new ProtocolError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    const extensions = await storage.metadata.getExtensions(id);
    const filtered = filterExtensionsByPermission(
      extensions,
      apiKey?.extension_permissions,
      apiKey?.label ?? "",
      apiKey?.role === "admin",
    );

    return c.json({ extensions: filtered });
  });

  // GET /items/:id/extensions/:namespace — read a specific namespace
  router.get("/:id/extensions/:namespace", async (c) => {
    requireAuth(c);
    const id = c.req.param("id");
    const namespace = c.req.param("namespace");
    if (!isValidId(id)) {
      throw new ProtocolError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const apiKey = c.get("apiKey");
    const tid = apiKey?.tenant_id;
    const item = await storage.items.get(id, tid);
    if (!item) {
      throw new ProtocolError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
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
      throw new ProtocolError(
        ErrorCode.FORBIDDEN,
        `No read access to extension namespace "${namespace}"`,
      );
    }

    const extensions = await storage.metadata.getExtensions(id);
    const data = extensions[namespace] ?? null;

    return c.json({ namespace, data });
  });

  // PUT /items/:id/extensions/:namespace — write to a specific namespace
  router.put("/:id/extensions/:namespace", async (c) => {
    requireAuth(c);
    const id = c.req.param("id");
    const namespace = c.req.param("namespace");
    if (!isValidId(id)) {
      throw new ProtocolError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const apiKey = c.get("apiKey");
    const tid = apiKey?.tenant_id;
    const item = await storage.items.get(id, tid);
    if (!item) {
      throw new ProtocolError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    const perm =
      apiKey?.role === "admin"
        ? "write"
        : resolveExtensionPermission(
            namespace,
            apiKey?.extension_permissions,
            apiKey?.label ?? "",
          );
    if (perm !== "write") {
      throw new ProtocolError(
        ErrorCode.FORBIDDEN,
        `No write access to extension namespace "${namespace}"`,
      );
    }

    const body = await c.req.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new ProtocolError(
        ErrorCode.VALIDATION_ERROR,
        "Extension data must be a JSON object",
      );
    }

    // Enforce extension data size limit (100KB per namespace)
    const serialized = JSON.stringify(body);
    if (serialized.length > 102_400) {
      throw new ProtocolError(
        ErrorCode.VALIDATION_ERROR,
        "Extension data exceeds maximum size of 100KB",
      );
    }

    const extensions = await storage.metadata.setExtension(
      id,
      namespace,
      body as Record<string, unknown>,
    );

    return c.json({ extensions });
  });

  // DELETE /items/:id/extensions/:namespace — remove a namespace
  router.delete("/:id/extensions/:namespace", async (c) => {
    requireAuth(c);
    const id = c.req.param("id");
    const namespace = c.req.param("namespace");
    if (!isValidId(id)) {
      throw new ProtocolError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const apiKey = c.get("apiKey");
    const tid = apiKey?.tenant_id;
    const item = await storage.items.get(id, tid);
    if (!item) {
      throw new ProtocolError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    // Only admin or namespace owner can delete
    const isOwner = apiKey?.label === namespace;
    if (apiKey?.role !== "admin" && !isOwner) {
      const perm = resolveExtensionPermission(
        namespace,
        apiKey?.extension_permissions,
        apiKey?.label ?? "",
      );
      if (perm !== "write") {
        throw new ProtocolError(
          ErrorCode.FORBIDDEN,
          `No write access to extension namespace "${namespace}"`,
        );
      }
    }

    const extensions = await storage.metadata.deleteExtension(id, namespace);
    return c.json({ extensions });
  });

  return router;
}
