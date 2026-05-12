import { createRoute, z } from "@hono/zod-openapi";
import {
  MymeError,
  ErrorCode,
  getTypeSchema,
  TYPE_REGISTRY,
  ALL_TYPES,
  validateTypeSchema,
  isValidTypeIdentifier,
  classifyNamespace,
  diffTypeSchemas,
  isValidVersionBump,
} from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  requireAdmin,
  requireMetadataPermission,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { resolveTypeSchema } from "../storage/policy.js";
import {
  createOpenAPIRouter,
  OkResponseSchema,
  makeErrorResponseSchema,
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
  summary: "List types",
  description:
    "Returns every type registered in the tenant — the core type catalogue plus any custom types registered via `POST /types`. Each entry carries the type identifier, parent (for inheriting types), fields, optional `display_hints`, `merge_policy`, and `version_policy`. Use as the manifest a custom-type-aware client reads at startup. See [Types](/concepts/types).",
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
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
  },
});

const getTypeRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Types"],
  summary: "Get a type",
  description:
    "Returns the full schema for a single type — fields, parent, `display_hints`, `merge_policy`, `version_policy`. Resolves both core and tenant-registered custom types by identifier.",
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
          schema: makeErrorResponseSchema(["type_not_found"]),
        },
      },
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
    "Registers a custom type at runtime. Identifier must namespace under one of `app.<app-name>.<type>`, `user.<type>`, or `<publisher>.<type>` — reserved roots (`core`, `system`, `myme`) reject with `400 reserved_namespace`. Bodies are validated; mismatched semver bumps (additive change submitted as major, etc.) reject with `400 version_bump_mismatch`. Child types may not redefine ancestor fields — `400 inheritance_violation`.\n\nAdmin keys bypass; non-admin credentials need the `metadata.types:write` scope, default-off for new keys. See [Authoring types](/concepts/authoring-types) for the rubric and error catalogue.",
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
      description: "Missing metadata.types:write permission",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["type_already_exists"]),
        },
      },
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
    "Replaces a custom type's schema. Admin-only — core types are immutable and return 400. Re-runs the registration-time correctness rails (semver diff, inheritance check, field-name validation). The diff between the prior and new version sets the required version bump; mismatched bumps reject with `400 version_bump_mismatch`. See [Authoring types — semver diff](/concepts/authoring-types#server-side-semver-diff).",
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
          schema: makeErrorResponseSchema(["type_not_found"]),
        },
      },
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
    "Removes a custom type registration. Admin-only — core types are immutable. By default, deletion is rejected if any item of the type still exists. Pass `?force=true` to delete the type and orphan existing rows (rows persist with the type identifier intact, but new writes against that type return `400 invalid_type`).",
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
          schema: makeErrorResponseSchema(["type_not_found"]),
        },
      },
      description: "Type not found",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["type_in_use"]),
        },
      },
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

  // POST /types — register a custom type. Admins bypass the check;
  // non-admin credentials (member keys, OAuth tokens) need the
  // `metadata.types:write` scope explicitly granted. Default-off for
  // new keys per the workstream-1 brief: type registration is a
  // privileged capability that has to be deliberately granted.
  router.openapi(registerTypeRoute, async (c) => {
    requireMetadataPermission(c, "types", "write");
    const body = c.req.valid("json");

    // Pre-validation for specific error codes
    if (typeof body.id === "string" && !isValidTypeIdentifier(body.id)) {
      throw new MymeError(
        ErrorCode.INVALID_TYPE,
        "Invalid type identifier. Must follow the five-tier namespace grammar: core.<type>, system.<type>, app.<app-name>.<type>, user.<type>, or <publisher>.<type>. Forward slashes and reserved-root collisions are rejected.",
      );
    }
    // TSC42 §3/§4 platform-credential gate. Only credentials marked as
    // platform may register `core.*`, `system.*`, or `myme.*` types — these
    // tiers are platform-shipped/operational, not authored at runtime by
    // ordinary tenant admins.
    if (typeof body.id === "string") {
      const tier = classifyNamespace(body.id);
      const isPlatformCaller = c.get("apiKey")?.is_platform === true;
      if (
        (tier === "core" || tier === "system" || tier === "myme") &&
        !isPlatformCaller
      ) {
        throw new MymeError(
          ErrorCode.FORBIDDEN,
          `Reserved namespace: only platform credentials may register ${tier}.* types`,
          { namespace: tier },
        );
      }
    }
    if (body.fields === undefined || body.fields === null) {
      throw new MymeError(
        ErrorCode.MISSING_REQUIRED_FIELD,
        "fields is required",
      );
    }

    const result = validateTypeSchema(body);
    if (!result.success) {
      // Surface specific discriminators so clients (e.g. conformance
      // conformance) can disambiguate from generic schema-shape failures.
      const hasInheritanceViolation = result.errors.some(
        (e) => e.code === "inheritance_violation",
      );
      const hasCompatibleWithViolation = result.errors.some(
        (e) => e.code === "compatible_with_violation",
      );
      let code: ErrorCode;
      let message: string;
      if (hasInheritanceViolation) {
        code = ErrorCode.INHERITANCE_VIOLATION;
        message = "Child type redefines a field declared by an ancestor";
      } else if (hasCompatibleWithViolation) {
        code = ErrorCode.COMPATIBLE_WITH_VIOLATION;
        message =
          "Type does not satisfy the structural-superset of its compatible_with target";
      } else {
        code = ErrorCode.INVALID_SCHEMA;
        message = "Invalid type schema";
      }
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
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
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

    // TSC42 §7: server-side semver diff. Replaces the historical
    // auto-increment with a structural classifier — no-op submissions are
    // rejected, descriptive-only changes accept the existing version,
    // additive and breaking changes require an explicit bump. The classifier
    // returns the diff class for telemetry / SDK error messages.
    const diff = diffTypeSchemas(existing, schema);
    if (diff === "noop") {
      throw new MymeError(
        ErrorCode.VERSION_BUMP_MISMATCH,
        "No structural or descriptive changes — re-submitting an identical schema is rejected",
        { diff },
      );
    }
    if (diff === "major") {
      // Field removal is a breaking diff; with integer versions we accept
      // breaking changes when the version bumps. Wire-shape consumers see
      // the diff class in the rejection / acceptance audit so SDK telemetry
      // can warn appropriately.
    }
    if (!isValidVersionBump(diff, existing.version, schema.version)) {
      throw new MymeError(
        ErrorCode.VERSION_BUMP_MISMATCH,
        diff === "patch"
          ? "Descriptive-only change accepts the existing version or higher"
          : `${diff[0]?.toUpperCase() ?? ""}${diff.slice(1)} change requires version > ${String(existing.version)}`,
        { diff, existing_version: existing.version },
      );
    }

    const updated = await storage.types.update(id, schema);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
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
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "type.delete",
      resource_type: "type",
      resource_id: id,
    });
    return c.json({ ok: true as const }, 200);
  });

  return router;
}
