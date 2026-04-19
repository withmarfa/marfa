import { createRoute, z } from "@hono/zod-openapi";
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
import { resolveTypeSchema } from "../storage/policy.js";
import {
  createOpenAPIRouter,
  ErrorResponseSchema,
  OkResponseSchema,
} from "../openapi.js";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

/** Check if a type is a built-in core type (from codegen, not user-registered). */
const CORE_TYPE_IDS = new Set(ALL_TYPES.map((t) => t.id));

const MAX_INHERITANCE_DEPTH = 10;

/** Validate parent chain: parent must exist, no circular references, depth capped. */
function validateParentChain(typeId: string, parentId: string): void {
  let current = parentId;
  let depth = 0;
  while (current) {
    depth++;
    if (depth > MAX_INHERITANCE_DEPTH) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        `Inheritance chain exceeds maximum depth of ${String(MAX_INHERITANCE_DEPTH)}`,
      );
    }
    if (current === typeId) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Circular inheritance detected",
      );
    }
    const parentSchema = getTypeSchema(current);
    if (!parentSchema) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        `Parent type "${current}" not found`,
      );
    }
    current = parentSchema.parent ?? "";
    if (!current) break;
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const MergeStrategySchema = z.enum(["last_writer_wins", "keep_both_copies"]);

const TypeSchemaResponse = z.object({
  id: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  parent: z.string().optional(),
  fields: z.record(z.string(), z.unknown()),
  version: z.number(),
  display_hints: z
    .object({
      title_field: z.string().optional(),
      body_field: z.string().optional(),
    })
    .optional(),
  version_policy: z
    .object({
      recent_days: z.number().optional(),
      daily_snapshot_days: z.number().optional(),
      weekly_snapshot_days: z.number().optional(),
      max_versions: z.number().optional(),
    })
    .optional(),
  merge_policy: z
    .object({
      fields: z.record(z.string(), MergeStrategySchema).optional(),
      default: MergeStrategySchema.optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listTypesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Types"],
  summary: "List all registered types",
  description: "Returns all registered types including core and custom types.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.array(TypeSchemaResponse),
        },
      },
      description: "List of all type schemas",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
});

const getTypeRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Types"],
  summary: "Get a single type schema",
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
          schema: TypeSchemaResponse,
        },
      },
      description: "Type schema",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Type not found",
    },
  },
});

const registerTypeRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Types"],
  summary: "Register a custom type",
  description:
    "Register a new custom type schema. Admin only. Body is validated via validateTypeSchema().",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.record(z.string(), z.unknown()),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: z.object({ type: TypeSchemaResponse }),
        },
      },
      description: "Custom type registered",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Type already exists",
    },
  },
});

const updateTypeRoute = createRoute({
  method: "put",
  path: "/{id}",
  tags: ["Types"],
  summary: "Update a custom type",
  description:
    "Update an existing custom type schema. Admin only. Core types cannot be modified. Body is validated via validateTypeSchema().",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
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
          schema: z.object({ type: TypeSchemaResponse }),
        },
      },
      description: "Custom type updated",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Type not found",
    },
  },
});

const deleteTypeRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Types"],
  summary: "Delete a custom type",
  description:
    "Delete a custom type. Admin only. Core types cannot be deleted. Use ?force=true to delete even if items exist.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    query: z.object({
      force: z.enum(["true", "false"]).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: OkResponseSchema,
        },
      },
      description: "Type deleted",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Type not found",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Type in use",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function typeRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  // GET /types — list all registered types (core + custom)
  router.openapi(listTypesRoute, (c) => {
    requireAuth(c);
    return c.json(Array.from(TYPE_REGISTRY.values()), 200);
  });

  // GET /types/:id — get a single type schema, inheritance-resolved.
  // Walks the parent chain and returns the effective view of `fields`,
  // `display_hints`, `version_policy`, and `merge_policy` so callers don't
  // have to resolve inheritance themselves. Mirrors the resolver already used
  // at 409-conflict assembly time.
  router.openapi(getTypeRoute, (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");
    const schema = resolveTypeSchema(id, TYPE_REGISTRY);
    if (!schema) {
      throw new MymeError(ErrorCode.TYPE_NOT_FOUND, `Type "${id}" not found`);
    }
    return c.json(schema, 200);
  });

  // POST /types — register a custom type (admin only)
  router.openapi(registerTypeRoute, async (c) => {
    requireAdmin(c);
    const body = c.req.valid("json");

    // Pre-validation for specific error codes
    if (typeof body.id === "string" && !isValidTypeIdentifier(body.id)) {
      throw new MymeError(
        ErrorCode.INVALID_TYPE,
        "Invalid type identifier. Must be dot-separated lowercase segments (e.g. acme.deal). Forward slashes are not allowed.",
      );
    }
    if (body.fields === undefined || body.fields === null) {
      throw new MymeError(
        ErrorCode.MISSING_REQUIRED_FIELD,
        "fields is required",
      );
    }

    const result = validateTypeSchema(body);
    if (!result.success) {
      // If any error carries the inheritance_violation discriminator, surface
      // the specific code so clients (e.g. mock-myme conformance) can
      // disambiguate from generic schema-shape failures.
      const hasInheritanceViolation = result.errors.some(
        (e) => e.code === "inheritance_violation",
      );
      const code = hasInheritanceViolation
        ? ErrorCode.INHERITANCE_VIOLATION
        : ErrorCode.INVALID_SCHEMA;
      const message = hasInheritanceViolation
        ? "Child type redefines a field declared by an ancestor"
        : "Invalid type schema";
      throw new MymeError(code, message, { errors: result.errors });
    }

    const schema = result.data;

    // Auto-generate label from type ID if not provided
    if (!schema.label) {
      const lastSegment = schema.id.split(".").pop() ?? schema.id;
      schema.label = lastSegment
        .replace(/[_-]/g, " ")
        .replace(/\b\w/g, (ch) => ch.toUpperCase());
    }

    if (schema.parent) {
      validateParentChain(schema.id, schema.parent);
    }

    if (getTypeSchema(schema.id)) {
      throw new MymeError(
        ErrorCode.TYPE_ALREADY_EXISTS,
        `Type "${schema.id}" already exists`,
      );
    }

    const tenantId = c.get("apiKey")?.tenant_id;
    const created = await storage.types.create(schema, tenantId);
    void storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "type.register",
      resource_type: "type",
      resource_id: schema.id,
    });
    return c.json({ type: created }, 201);
  });

  // PUT /types/:id — update a custom type (admin only)
  router.openapi(updateTypeRoute, async (c) => {
    requireAdmin(c);
    const { id } = c.req.valid("param");

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

    const body = c.req.valid("json");
    const result = validateTypeSchema({ ...body, id });
    if (!result.success) {
      throw new MymeError(ErrorCode.INVALID_SCHEMA, "Invalid type schema", {
        errors: result.errors,
      });
    }

    const schema = result.data;

    if (schema.parent) {
      validateParentChain(schema.id, schema.parent);
    }

    // Reject field removal — updates must be backward-compatible
    for (const fieldName of Object.keys(existing.fields)) {
      if (!(fieldName in schema.fields)) {
        throw new MymeError(
          ErrorCode.VALIDATION_ERROR,
          `Cannot remove field "${fieldName}". Type updates must be backward-compatible.`,
        );
      }
    }

    // Auto-increment version if not explicitly bumped
    if (schema.version <= existing.version) {
      schema.version = existing.version + 1;
    }

    const updated = await storage.types.update(id, schema);
    void storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "type.update",
      resource_type: "type",
      resource_id: id,
    });
    return c.json({ type: updated }, 200);
  });

  // DELETE /types/:id — delete a custom type (admin only)
  router.openapi(deleteTypeRoute, async (c) => {
    requireAdmin(c);
    const { id } = c.req.valid("param");

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

    const { force } = c.req.valid("query");
    if (force !== "true") {
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
    void storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "type.delete",
      resource_type: "type",
      resource_id: id,
    });
    return c.json({ ok: true as const }, 200);
  });

  return router;
}
