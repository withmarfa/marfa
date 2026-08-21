import { createRoute, z } from "@hono/zod-openapi";
import {
  MarfaError,
  ErrorCode,
  getTypeSchema,
  listTypes,
  TYPE_REGISTRY,
  validateTypeSchema,
  isValidTypeIdentifier,
  classifyNamespace,
  diffTypeSchemas,
  isValidVersionBump,
} from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  requireSpaceAdmin,
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

/**
 * Whether an identifier names a type this instance treats as locked.
 *
 * Reads the live registry rather than a set compiled from the shipped arrays,
 * because the platform vocabulary is seeded data now: an instance can hold a
 * type the running build never shipped, and locking has to follow what the
 * instance actually has. `TYPE_REGISTRY` is the platform map — a space's own
 * registrations live in the per-space overlay and never appear in it — so
 * membership is exactly the "shipped, not yours to edit" question.
 *
 * The lock spans core, integration and system alike. An integration type is
 * no more mutable than a core one.
 */
function isLockedPlatformType(id: string): boolean {
  return TYPE_REGISTRY.has(id);
}

const MAX_INHERITANCE_DEPTH = 10;

/** Validate parent chain: parent must exist, no circular references, depth
 *  capped. Parents resolve within the caller's space so a custom type may
 *  inherit from another of the space's custom types (or from a core type). */
function validateParentChain(
  typeId: string,
  parentId: string,
  spaceId?: string,
): void {
  let current = parentId;
  let depth = 0;
  while (current) {
    depth++;
    if (depth > MAX_INHERITANCE_DEPTH) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Inheritance chain exceeds maximum depth of ${String(MAX_INHERITANCE_DEPTH)}`,
      );
    }
    if (current === typeId) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Circular inheritance detected",
      );
    }
    const parentSchema = getTypeSchema(current, spaceId);
    if (!parentSchema) {
      throw new MarfaError(
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
  // Clients resolve a sibling type's read-as relationship from this field,
  // so it must reach the generated spec — an omission here strips it from
  // every generated client even though the runtime body carries it.
  compatible_with: z.array(z.string()).optional(),
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
  operationId: "listTypes",
  method: "get",
  path: "/",
  tags: ["Types"],
  summary: "List types",
  description:
    "Returns every type registered in the space — the core type catalog plus any custom types registered via `POST /types`. Use as the schema manifest a type-aware client reads at startup.",
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
  operationId: "getType",
  method: "get",
  path: "/{id}",
  tags: ["Types"],
  summary: "Get a type",
  description:
    "Returns the full schema for a single type, resolving inheritance so the response reflects the effective fields and policies. Works for both core and space-registered custom types.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("Type identifier."),
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
  operationId: "registerType",
  method: "post",
  path: "/",
  tags: ["Types"],
  summary: "Register a custom type",
  description:
    "Registers a custom type at runtime under the `app.*`, `user.*`, or `<publisher>.*` namespaces; reserved roots, ancestor-field redefinitions, and property names shadowing first-class `Item` fields all reject with `400`. Admin keys bypass; non-admin credentials need the `metadata.types:write` scope, which is off by default.",
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
      description:
        "Missing metadata.types:write permission, a reserved namespace, or a publisher namespace whose handle the caller's user has not claimed",
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
  operationId: "updateType",
  method: "put",
  path: "/{id}",
  tags: ["Types"],
  summary: "Update a custom type",
  description:
    "Replaces a custom type's schema, re-running the registration-time correctness rails. Admin-only — core types are immutable and return 403; the structural diff between versions sets the required version bump, and a mismatch rejects with `422 version_bump_mismatch`.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("Type identifier."),
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
  operationId: "deleteType",
  method: "delete",
  path: "/{id}",
  tags: ["Types"],
  summary: "Delete a custom type",
  description:
    "Removes a custom type registration. Admin-only — core types are immutable. Deletion is rejected if any item of the type still exists, unless `?force=true` orphans those rows (they persist, but new writes against the type return `400 invalid_type`).",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("Type identifier."),
    }),
    query: z.object({
      force: z
        .enum(["true", "false"])
        .optional()
        .describe("Delete and orphan existing items when `true`."),
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

export function typeRoutes(storage: Storage, authMode: "keys" | "hosted") {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(listTypesRoute, (c) => {
    requireAuth(c);
    // Core/system types are global; custom types resolve only within the
    // caller's space. `listTypes(spaceId)` returns core/system plus this
    // space's own custom types — never another space's.
    const spaceId = c.get("apiKey")?.space_id;
    return c.json(listTypes(spaceId), 200);
  });

  router.openapi(getTypeRoute, (c) => {
    requireAuth(c);
    const { id } = c.req.valid("param");
    // Resolve through the space-scoped lookup so a probe for another space's
    // custom type id resolves to nothing here and 404s.
    const spaceId = c.get("apiKey")?.space_id;
    const schema = resolveTypeSchema(id, (typeId) =>
      getTypeSchema(typeId, spaceId),
    );
    if (!schema) {
      throw new MarfaError(ErrorCode.TYPE_NOT_FOUND, `Type "${id}" not found`);
    }
    return c.json(schema, 200);
  });

  router.openapi(registerTypeRoute, async (c) => {
    requireMetadataPermission(c, "types", "write");
    const body = c.req.valid("json");
    // The registration is scoped to the caller's space: every inheritance,
    // compatible-with, parent-chain, and existence check below resolves within
    // this space's overlay, so a custom type is isolated to it from creation.
    const spaceId = c.get("apiKey")?.space_id;

    if (typeof body.id === "string" && !isValidTypeIdentifier(body.id)) {
      throw new MarfaError(
        ErrorCode.INVALID_TYPE,
        "Invalid type identifier. Must follow the five-tier namespace grammar: core.<type>, system.<type>, app.<app-name>.<type>, user.<type>, or <publisher>.<type>. Forward slashes and reserved-root collisions are rejected.",
      );
    }
    // Reserved namespaces are a property of the build, not of the request.
    // `core.*`, `system.*` and `marfa.*` are authored as JSON in the type
    // package and compiled into the registry; nothing legitimate mints one
    // over HTTP, and the route's own published description already says so.
    //
    // This used to admit a platform credential, which made registration and
    // restore disagree: an archive carrying a reserved-namespace type is
    // refused whatever credential restores it, precisely because a file is
    // something an attacker can hand you. A registration is no more
    // trustworthy for arriving over a socket. The asymmetry also let one
    // credentialed mistake put a row in a space's exports that its own
    // restore would then refuse, taking the whole archive down with it.
    if (typeof body.id === "string") {
      const tier = classifyNamespace(body.id);
      if (tier === "core" || tier === "system" || tier === "marfa") {
        throw new MarfaError(
          ErrorCode.FORBIDDEN,
          `Reserved namespace: ${tier}.* types are platform-shipped and cannot be registered at runtime`,
          { namespace: tier },
        );
      }
      // Publishing under a handle means owning it: the publisher tier is
      // the only tier whose first segment is a claimable handle, so
      // registration there requires the caller's user to hold that exact
      // handle. The rule binds only in hosted mode — keys mode has no
      // user accounts, so there is no handle system to check against and
      // the only party a refusal could stop is the deployment's own
      // operator. Platform credentials are exempt so seeding and operator
      // tooling keep working across spaces.
      if (
        tier === "publisher" &&
        authMode === "hosted" &&
        c.get("apiKey")?.is_platform !== true
      ) {
        const publisher = body.id.split(".")[0] ?? "";
        const user =
          spaceId && storage.users
            ? await storage.users.getBySpaceId(spaceId)
            : null;
        const handle = user?.handle ?? null;
        if (handle !== publisher) {
          throw new MarfaError(
            ErrorCode.FORBIDDEN,
            handle
              ? `Publisher namespace: registering "${publisher}.*" requires the handle "${publisher}"; this credential's user holds "${handle}"`
              : `Publisher namespace: registering "${publisher}.*" requires claiming the handle "${publisher}" first`,
            { namespace: publisher, handle_held: handle },
          );
        }
      }
    }
    if (body.fields === undefined || body.fields === null) {
      throw new MarfaError(
        ErrorCode.MISSING_REQUIRED_FIELD,
        "fields is required",
      );
    }

    const result = validateTypeSchema(body, spaceId);
    if (!result.success) {
      // Surface specific error codes so clients can disambiguate from generic schema failures.
      const hasPropertyShadowsField = result.errors.some(
        (e) => e.code === "property_shadows_field",
      );
      const hasInheritanceViolation = result.errors.some(
        (e) => e.code === "inheritance_violation",
      );
      const hasCompatibleWithViolation = result.errors.some(
        (e) => e.code === "compatible_with_violation",
      );
      let code: ErrorCode;
      let message: string;
      if (hasPropertyShadowsField) {
        code = ErrorCode.PROPERTY_SHADOWS_FIELD;
        message =
          "Type schema declares a property whose name shadows a first-class Item field";
      } else if (hasInheritanceViolation) {
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
      throw new MarfaError(code, message, { errors: result.errors });
    }

    const schema = result.data;

    if (!schema.label) {
      const lastSegment = schema.id.split(".").pop() ?? schema.id;
      schema.label = lastSegment
        .replace(/[_-]/g, " ")
        .replace(/\b\w/g, (ch) => ch.toUpperCase());
    }

    if (schema.parent) {
      validateParentChain(schema.id, schema.parent, spaceId);
    }

    if (getTypeSchema(schema.id, spaceId)) {
      throw new MarfaError(
        ErrorCode.TYPE_ALREADY_EXISTS,
        `Type "${schema.id}" already exists`,
      );
    }

    const created = await storage.types.create(schema, spaceId);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "type.register",
      resource_type: "type",
      resource_id: schema.id,
    });
    return c.json({ type: created }, 201);
  });

  router.openapi(updateTypeRoute, async (c) => {
    requireSpaceAdmin(c);
    const { id } = c.req.valid("param");
    // Scope to the caller's space: a space_admin sees and mutates only its
    // own custom types. A probe for another space's id resolves to nothing
    // and 404s.
    const spaceId = c.get("apiKey")?.space_id;

    if (!isValidTypeIdentifier(id)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid type identifier",
      );
    }

    if (isLockedPlatformType(id)) {
      throw new MarfaError(
        ErrorCode.CORE_TYPE_IMMUTABLE,
        `Cannot modify platform-shipped types`,
      );
    }

    const existing = getTypeSchema(id, spaceId);
    if (!existing) {
      throw new MarfaError(ErrorCode.TYPE_NOT_FOUND, `Type "${id}" not found`);
    }

    const body = c.req.valid("json");
    const result = validateTypeSchema({ ...body, id }, spaceId);
    if (!result.success) {
      throw new MarfaError(ErrorCode.INVALID_SCHEMA, "Invalid type schema", {
        errors: result.errors,
      });
    }

    const schema = result.data;

    if (schema.parent) {
      validateParentChain(schema.id, schema.parent, spaceId);
    }

    // Server-side semver diff via a structural classifier: no-op
    // submissions are rejected, descriptive-only changes accept the existing
    // version, additive and breaking changes require an explicit bump. The
    // classifier returns the diff class for telemetry / SDK error messages.
    const diff = diffTypeSchemas(existing, schema);
    if (diff === "noop") {
      throw new MarfaError(
        ErrorCode.VERSION_BUMP_MISMATCH,
        "No structural or descriptive changes — re-submitting an identical schema is rejected",
        { diff },
      );
    }
    // A major diff (field removal) is permitted; the version-bump check below enforces
    // that the caller explicitly incremented the version, and the diff class surfaces
    // in audit so SDK telemetry can warn consumers.
    if (!isValidVersionBump(diff, existing.version, schema.version)) {
      throw new MarfaError(
        ErrorCode.VERSION_BUMP_MISMATCH,
        diff === "patch"
          ? "Descriptive-only change accepts the existing version or higher"
          : `${diff[0]?.toUpperCase() ?? ""}${diff.slice(1)} change requires version > ${String(existing.version)}`,
        { diff, existing_version: existing.version },
      );
    }

    const updated = await storage.types.update(id, schema, spaceId);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "type.update",
      resource_type: "type",
      resource_id: id,
    });
    return c.json({ type: updated }, 200);
  });

  router.openapi(deleteTypeRoute, async (c) => {
    requireSpaceAdmin(c);
    const { id } = c.req.valid("param");
    // Scope to the caller's space: a space_admin can only delete its own
    // custom types; another space's id resolves as not-found.
    const spaceId = c.get("apiKey")?.space_id;

    if (isLockedPlatformType(id)) {
      throw new MarfaError(
        ErrorCode.CORE_TYPE_IMMUTABLE,
        `Cannot delete platform-shipped types`,
      );
    }

    const existing = getTypeSchema(id, spaceId);
    if (!existing) {
      throw new MarfaError(ErrorCode.TYPE_NOT_FOUND, `Type "${id}" not found`);
    }

    const { force } = c.req.valid("query");
    if (force !== "true") {
      const items = await storage.items.list({
        spaceId,
        type: id,
        limit: 1,
      });
      if (items.data.length > 0) {
        throw new MarfaError(
          ErrorCode.TYPE_IN_USE,
          `Type "${id}" has existing items. Use ?force=true to delete anyway.`,
        );
      }
    }

    await storage.types.delete(id, spaceId);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "type.delete",
      resource_type: "type",
      resource_id: id,
    });
    return c.json({ ok: true as const }, 200);
  });

  return router;
}
