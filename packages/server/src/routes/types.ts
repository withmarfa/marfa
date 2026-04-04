import { Hono } from "hono";
import {
  MymeError,
  ErrorCode,
  getTypeSchema,
  TYPE_REGISTRY,
  ALL_TYPES,
  validateTypeSchema,
  isValidTypeIdentifier,
} from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";

/** Check if a type is a built-in core type (from codegen, not user-registered). */
const CORE_TYPE_IDS = new Set(ALL_TYPES.map((t) => t.id));

export function typeRoutes(storage: Storage): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // GET /types — list all registered types (core + custom)
  router.get("/", (c) => {
    requireAuth(c);
    return c.json(Array.from(TYPE_REGISTRY.values()));
  });

  // GET /types/:id — get a single type schema
  router.get("/:id", (c) => {
    requireAuth(c);
    const id = c.req.param("id");
    const schema = getTypeSchema(id);
    if (!schema) {
      throw new MymeError(ErrorCode.TYPE_NOT_FOUND, `Type "${id}" not found`);
    }
    return c.json(schema);
  });

  // POST /types — register a custom type (admin only)
  router.post("/", async (c) => {
    requireAdmin(c);
    const body = await c.req.json();

    // Pre-validation for specific error codes
    if (typeof body.id === "string" && !isValidTypeIdentifier(body.id)) {
      throw new MymeError(ErrorCode.INVALID_TYPE, "Invalid type identifier");
    }
    if (body.fields === undefined || body.fields === null) {
      throw new MymeError(
        ErrorCode.MISSING_REQUIRED_FIELD,
        "fields is required",
      );
    }

    const result = validateTypeSchema(body);
    if (!result.success) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid type schema", {
        errors: result.errors,
      });
    }

    const schema = result.data;

    if (getTypeSchema(schema.id)) {
      throw new MymeError(
        ErrorCode.TYPE_ALREADY_EXISTS,
        `Type "${schema.id}" already exists`,
      );
    }

    const tenantId = c.get("apiKey")?.tenant_id;
    const created = await storage.types.create(schema, tenantId);
    return c.json({ type: created }, 201);
  });

  // PUT /types/:id — update a custom type (admin only)
  router.put("/:id", async (c) => {
    requireAdmin(c);
    const id = c.req.param("id");

    if (!isValidTypeIdentifier(id)) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid type identifier",
      );
    }

    if (CORE_TYPE_IDS.has(id)) {
      throw new MymeError(
        ErrorCode.CORE_TYPE_IMMUTABLE,
        `Cannot modify core types`,
      );
    }

    const existing = getTypeSchema(id);
    if (!existing) {
      throw new MymeError(ErrorCode.TYPE_NOT_FOUND, `Type "${id}" not found`);
    }

    const body = await c.req.json();
    const result = validateTypeSchema({ ...body, id });
    if (!result.success) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid type schema", {
        errors: result.errors,
      });
    }

    const schema = result.data;
    if (schema.version <= existing.version) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        `Version must be greater than current version (${String(existing.version)})`,
      );
    }

    const updated = await storage.types.update(id, schema);
    return c.json({ type: updated });
  });

  // DELETE /types/:id — delete a custom type (admin only)
  router.delete("/:id", async (c) => {
    requireAdmin(c);
    const id = c.req.param("id");

    if (CORE_TYPE_IDS.has(id)) {
      throw new MymeError(
        ErrorCode.CORE_TYPE_IMMUTABLE,
        `Cannot delete core types`,
      );
    }

    const existing = getTypeSchema(id);
    if (!existing) {
      throw new MymeError(ErrorCode.TYPE_NOT_FOUND, `Type "${id}" not found`);
    }

    const force = c.req.query("force") === "true";
    if (!force) {
      const tenantId = c.get("apiKey")?.tenant_id;
      const items = await storage.items.list({
        tenantId,
        type: id,
        limit: 1,
      });
      if (items.data.length > 0) {
        throw new MymeError(
          ErrorCode.TYPE_IN_USE,
          `Type "${id}" has existing items. Use ?force=true to delete anyway.`,
        );
      }
    }

    await storage.types.delete(id);
    return c.json({ ok: true });
  });

  return router;
}
