import { randomBytes } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import {
  MarfaError,
  ErrorCode,
  isValidId,
  canGrantRole,
  parseMarfaRole,
} from "@withmarfa/shared";
import type { MarfaRole } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireSpaceAdmin,
  hashApiKey,
  isReservedCredentialSource,
  RESERVED_CREDENTIAL_SOURCE_PREFIXES,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { RoleRequestSchema, RoleResponseSchema } from "./role-schema.js";
import { KeyResponseSchema } from "./_schemas.js";
import {
  createOpenAPIRouter,
  OkResponseSchema,
  makeErrorResponseSchema,
} from "../openapi.js";

const KEY_PREFIX = "marfa_k1_";

function generateRawKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("hex");
}

/**
 * Refuse a caller-supplied `source` that claims an integration shape.
 *
 * `source` is otherwise free text, but three prefixes are read elsewhere
 * as proof that a credential IS a particular connection's integration —
 * see `RESERVED_CREDENTIAL_SOURCE_PREFIXES`. Genuine runtime credentials
 * are minted at the storage layer by the per-dispatch mint, never
 * through an HTTP mint route, so nothing legitimate is turned away
 * here.
 *
 * Shared by `POST /keys` and `POST /admin/spaces/{id}/keys`: both write
 * `source` straight from the body, so a check on only one of them is no
 * check at all.
 */
export function assertUnreservedSource(source: string): void {
  if (!isReservedCredentialSource(source)) return;
  throw new MarfaError(
    ErrorCode.VALIDATION_ERROR,
    `\`source\` may not start with ${RESERVED_CREDENTIAL_SOURCE_PREFIXES.map((p) => `"${p}"`).join(", ")} — those prefixes identify a connection's own integration credential and are issued by the runtime, not by this route.`,
  );
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const EdgePermissionsSchema = z
  .record(z.string(), z.enum(["read", "write"]))
  .optional();

const KeyListItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  source: z.string(),
  role: z.string(),
  default_tier: z.enum(["library", "feed"]),
  is_platform: z.boolean(),
  type_permissions: z.record(z.string(), z.enum(["read", "write", "none"])),
  extension_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  edge_permissions: EdgePermissionsSchema,
  metadata_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  created_at: z.string(),
  expires_at: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Hard lifetime bound. NULL for human-minted keys, which never expire. Runtime credentials are always stamped; a key past this instant is refused exactly like a revoked one.",
    ),
  last_used_at: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const createKeyRoute = createRoute({
  operationId: "createKey",
  method: "post",
  path: "/",
  tags: ["Keys"],
  summary: "Create an API key",
  description:
    "Creates a new API key in the caller's space. The plaintext `key` is returned only in this response and never shown again, so store it securely. The new key's space is always the caller's: a `space_id` in the body is rejected, and a caller that has no space cannot mint `role: \"space_admin\"` (the key would inherit no space, so its authority would not stop at the boundary its role names). Use `POST /admin/spaces/{id}/keys` to mint into a specific space. `role` may not exceed the caller's own role (admin > space_admin > member); asking for a higher one returns 403, and `is_platform` is granted only when the caller is itself a platform credential. On a fresh server with zero keys, this runs in bootstrap mode (no auth, minted key is always admin); once any key exists, creation requires an admin or space_admin token.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            label: z.string().min(1, "label is required"),
            source: z
              .string()
              .min(1, "source display name is required")
              .max(200),
            role: RoleRequestSchema.optional(),
            default_tier: z.enum(["library", "feed"]).optional(),
            is_platform: z.boolean().optional(),
            // Passthrough so the handler can reject it explicitly. The
            // new key's space is always the caller's; accepting the
            // field and stripping it left callers believing they had
            // minted into the space they named.
            space_id: z
              .unknown()
              .optional()
              .describe(
                "Rejected with 400. The key is always minted into the caller's space; use POST /admin/spaces/{id}/keys to target another space.",
              ),
            type_permissions: z
              .record(z.string(), z.enum(["read", "write", "none"]))
              .optional(),
            extension_permissions: z
              .record(z.string(), z.enum(["read", "write"]))
              .optional(),
            edge_permissions: z
              .record(z.string(), z.enum(["read", "write"]))
              .optional(),
            metadata_permissions: z
              .record(z.string(), z.enum(["read", "write"]))
              .optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: KeyResponseSchema,
        },
      },
      description: "API key created",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description:
        "Body carried a `space_id`, or the mint would produce a `space_admin` key with no space",
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
        "Caller is not an admin or space_admin, is an OAuth access token, or requested a role above its own.",
    },
  },
});

const listKeysRoute = createRoute({
  operationId: "listKeys",
  method: "get",
  path: "/",
  tags: ["Keys"],
  summary: "List API keys",
  description:
    "Returns every API key in the caller's space without plaintext, which is only ever returned at creation time. `last_used_at` is debounced to at most one write per hour, so treat it as a coarse activity signal rather than an audit log. Admin or space_admin only.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            keys: z.array(KeyListItemSchema),
          }),
        },
      },
      description: "List of API keys",
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

const revokeKeyRoute = createRoute({
  operationId: "revokeKey",
  method: "delete",
  path: "/{id}",
  tags: ["Keys"],
  summary: "Revoke an API key",
  description:
    "Revokes the key immediately; the next request bearing it returns `401 unauthorized`. In-flight long-lived connections (SSE) terminate on the next heartbeat. Admin or space_admin only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("ID of the API key to revoke"),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: OkResponseSchema,
        },
      },
      description: "Key revoked",
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

// Passthrough — immutable fields (source, role) are rejected explicitly in the
// handler with a readable error instead of a generic "unrecognized keys".
const UpdateKeyBodySchema = z.object({
  label: z.string().min(1).optional(),
  default_tier: z.enum(["library", "feed"]).optional(),
  type_permissions: z
    .record(z.string(), z.enum(["read", "write", "none"]))
    .optional(),
  extension_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  edge_permissions: z.record(z.string(), z.enum(["read", "write"])).optional(),
  metadata_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  source: z.unknown().optional(),
  role: z.unknown().optional(),
});

const KeyDetailSchema = z.object({
  id: z.string(),
  label: z.string(),
  source: z.string(),
  role: RoleResponseSchema,
  default_tier: z.enum(["library", "feed"]),
  is_platform: z.boolean(),
  type_permissions: z.record(z.string(), z.enum(["read", "write", "none"])),
  extension_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  edge_permissions: EdgePermissionsSchema,
  metadata_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  created_at: z.string(),
  expires_at: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Hard lifetime bound. NULL for human-minted keys, which never expire. Runtime credentials are always stamped; a key past this instant is refused exactly like a revoked one.",
    ),
  last_used_at: z.string().nullable(),
});

const updateKeyRoute = createRoute({
  operationId: "updateKey",
  method: "patch",
  path: "/{id}",
  tags: ["Keys"],
  summary: "Update an API key",
  description:
    "Updates a key's label, default tier, or permission maps in place. `source` and `role` are immutable and rejected with `400 validation_error` if present in the body — revoke and recreate to change them. Admin or space_admin only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("ID of the API key to update"),
    }),
    body: {
      content: {
        "application/json": {
          schema: UpdateKeyBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: KeyDetailSchema } },
      description: "Key updated",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
          ]),
        },
      },
      description: "Invalid update (e.g. attempt to mutate an immutable field)",
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
      description: "Admin only",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["api_key_not_found"]),
        },
      },
      description: "Key not found",
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function keyRoutes(storage: Storage, salt: string) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(createKeyRoute, async (c) => {
    const isBootstrap = c.get("isBootstrap");
    if (!isBootstrap) {
      requireSpaceAdmin(c);
      // OAuth principals carry the user's projected role but are scope-limited
      // grants, not the user acting directly. Minting an API key produces a
      // durable credential that bypasses the permission maps the OAuth token is
      // held to — so an app granted a narrow scope could escalate it into full
      // space access. Block key creation for OAuth callers; they keep
      // read/manage reach via the role projection but cannot forge a
      // non-scope-enforced key. (`authType` is set by the bearer middleware.)
      if (c.get("authType") === "oauth") {
        throw new MarfaError(
          ErrorCode.FORBIDDEN,
          "OAuth access tokens cannot create API keys; authenticate with an API key to mint one.",
        );
      }
    }

    const body = c.req.valid("json");

    // The new key always inherits the caller's space. Naming a different
    // one used to be accepted and dropped, so an operator aiming a key at
    // one space got a key scoped somewhere else with no signal that it
    // had happened. Space-scoped minting lives on its own route.
    //
    // Checked ahead of the bootstrap claim below: that claim is one-shot
    // and irreversible, so a request that can never mint must not consume
    // it. A stray field would otherwise lock a fresh instance out of
    // bootstrap for good.
    if ("space_id" in body) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "`space_id` is not accepted here. A key minted through this route is always bound to the caller's space; use `POST /admin/spaces/{id}/keys` to mint into a specific space.",
      );
    }

    // Under bootstrap, atomically claim the sentinel BEFORE minting. Two
    // concurrent unauthenticated POST /keys against a fresh DB both pass
    // the middleware gate (which reads the sentinel non-atomically); only
    // the caller whose INSERT-ON-CONFLICT-DO-NOTHING returns a row gets to
    // mint. Everyone else falls through to requireAdmin and receives 401.
    if (isBootstrap) {
      const claimed = await storage.settings.claim("bootstrapped", "true");
      if (!claimed) {
        throw new MarfaError(ErrorCode.UNAUTHORIZED, "Authentication required");
      }
    }

    // Role is a privilege axis, so a mint may travel sideways or downwards
    // from the caller's own rank but never upwards — otherwise any principal
    // allowed to mint at all could manufacture a credential outranking the
    // one it presented, and the role gates guarding every other route would
    // be decorative. Bootstrap is exempted: it seeds the first admin on a
    // server that has no credential to compare against.
    // `parseMarfaRole` rather than the raw body value: the request schema
    // still accepts the word this rename is retiring, and nothing past this
    // line should ever see it.
    const role: MarfaRole = isBootstrap
      ? "instance_admin"
      : parseMarfaRole(body.role, "member");
    if (!isBootstrap) {
      const callerRole = c.get("apiKey")?.role;
      if (!callerRole || !canGrantRole(callerRole, role)) {
        throw new MarfaError(
          ErrorCode.FORBIDDEN,
          `A ${callerRole ?? "unknown"} credential cannot create a key with role "${role}".`,
        );
      }
    }

    assertUnreservedSource(body.source);

    const typePermissions = body.type_permissions ?? {};

    const rawKey = generateRawKey();
    const keyHash = hashApiKey(rawKey, salt);

    // is_platform escalation requires the caller to already be platform.
    // Bootstrap is exempted — the seed key is implicitly platform.
    const callerIsPlatform = c.get("apiKey")?.is_platform === true;
    let isPlatform: boolean;
    if (isBootstrap) {
      isPlatform = body.is_platform ?? true;
    } else {
      isPlatform = callerIsPlatform && body.is_platform === true;
    }

    const newKeySpaceId = c.get("apiKey")?.space_id;

    // `space_admin` means "admin inside a space", but the new key inherits
    // the caller's space and a space-less caller hands it none. NULL space
    // is the platform-tier signal everywhere below: the RLS middleware skips
    // its role-switch wrapper and the storage layer drops its
    // `WHERE space_id = ?` predicate, while the role itself bypasses the
    // permission maps. The result reads and writes across every space behind
    // a label that promises a boundary, so the mint refuses.
    //
    // Unconditional rather than scoped to multi-space deployments. Gating on
    // the auth mode would put a security rule behind an env var that fails
    // open when unset or misspelled, and there is no independent signal to
    // lean on: the hosted-only wiring (`storage.users`) is built from that
    // same variable, and asking whether space rows exist costs an unbounded
    // scan on the mint path. Refusing outright needs no signal and buys an
    // invariant worth stating plainly: every `space_admin` key has a space.
    //
    // `member` is deliberately not caught, despite inheriting the same NULL
    // space. It is this route's default role and the only shape expressing
    // "platform reach, narrowed by `type_permissions`" (`admin` ignores those
    // outright), and a caller refused it can ask for `role: "instance_admin"` here
    // instead, for strictly more authority. Blocking it would move callers to
    // a wider credential, not a narrower one; the audit row below marks the
    // tier instead.
    //
    // Safe under bootstrap only because `role` is hard-forced to
    // "instance_admin"
    // above. Were bootstrap ever to honor `body.role`, the first
    // unauthenticated request to a fresh instance could ask for
    // `space_admin`, and this check would be all that stood in front of it.
    if (!newKeySpaceId && role === "space_admin") {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        'Cannot mint a `space_admin` key from a credential that has no space: the new key would inherit no space either, so its authority would not stop at the boundary its role names. Use `POST /admin/spaces/{id}/keys` to bind the key to a specific space, or ask for `role: "instance_admin"` if a platform-tier key is what you want.',
      );
    }

    const stored = await storage.keys.create(
      {
        label: body.label.trim(),
        source: body.source.trim(),
        role: role,
        default_tier: body.default_tier,
        is_platform: isPlatform,
        type_permissions: typePermissions,
        extension_permissions: body.extension_permissions,
        edge_permissions: body.edge_permissions,
        metadata_permissions: body.metadata_permissions,
      },
      keyHash,
      newKeySpaceId,
    );

    // A key with no space is platform tier: the RLS middleware skips its
    // wrapper for it and the storage layer drops its space predicate. That
    // is a legitimate thing to mint, but it is not what `role: "member"`
    // looks like at a glance, so the audit row records the tier and an
    // operator can enumerate every such credential later. Derived from the
    // stored space alone rather than from how the instance is configured,
    // so the trail stays accurate whatever the deployment shape.
    const platformTierMint = !newKeySpaceId;

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: isBootstrap ? "key.bootstrap" : "key.create",
      resource_type: "key",
      resource_id: stored.id,
      details: platformTierMint ? { platform_tier: true } : undefined,
    });

    return c.json(
      {
        id: stored.id,
        key: rawKey,
        label: stored.label,
        source: stored.source,
        role: stored.role,
        default_tier: stored.default_tier,
        is_platform: stored.is_platform,
        type_permissions: stored.type_permissions,
        extension_permissions: stored.extension_permissions,
        edge_permissions: stored.edge_permissions,
        metadata_permissions: stored.metadata_permissions,
        created_at: stored.created_at,
        last_used_at: stored.last_used_at,
      },
      201,
    );
  });

  router.openapi(listKeysRoute, async (c) => {
    // A space-bound caller sees only its own space's keys; only an
    // unbound credential sees all. The fence keys on the space binding,
    // not on the role: `POST /admin/spaces/{id}/keys` mints a
    // space-bound `admin`, and a role-keyed fence would hand that
    // credential every other space's key inventory.
    const key = requireSpaceAdmin(c);
    const all = await storage.keys.list();
    const visible = key.space_id
      ? all.filter((k) => k.space_id === key.space_id)
      : all;
    return c.json({ keys: visible }, 200);
  });

  router.openapi(revokeKeyRoute, async (c) => {
    const key = requireSpaceAdmin(c);
    const { id } = c.req.valid("param");

    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid key ID");
    }

    // 404 not 403 — cross-space probes must not enumerate key ids.
    // Keyed on the space binding rather than the role, so a space-bound
    // `admin` is fenced to its own space exactly like a space_admin.
    if (key.space_id) {
      const target = await storage.keys.get(id);
      if (target?.space_id !== key.space_id) {
        throw new MarfaError(
          ErrorCode.API_KEY_NOT_FOUND,
          `Key ${id} not found`,
        );
      }
    }

    await storage.keys.revoke(id);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "key.revoke",
      resource_type: "key",
      resource_id: id,
    });

    return c.json({ ok: true as const }, 200);
  });

  router.openapi(updateKeyRoute, async (c) => {
    const key = requireSpaceAdmin(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid key ID");
    }

    if ("source" in body) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "`source` is immutable after creation — it is baked into item provenance. Revoke and issue a new key instead.",
      );
    }
    if ("role" in body) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "`role` is immutable after creation for security reasons. Revoke and issue a new key instead.",
      );
    }

    const existing = await storage.keys.get(id);
    if (!existing) {
      throw new MarfaError(ErrorCode.API_KEY_NOT_FOUND, `Key ${id} not found`);
    }
    // Same space-binding fence as `revokeKeyRoute` — a bound credential
    // of any rank may only address keys inside its own space.
    if (key.space_id && existing.space_id !== key.space_id) {
      throw new MarfaError(ErrorCode.API_KEY_NOT_FOUND, `Key ${id} not found`);
    }

    const updated = await storage.keys.update(id, {
      label: body.label,
      default_tier: body.default_tier,
      type_permissions: body.type_permissions,
      extension_permissions: body.extension_permissions,
      edge_permissions: body.edge_permissions,
      metadata_permissions: body.metadata_permissions,
    });

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "key.update",
      resource_type: "key",
      resource_id: id,
      details: {
        fields: Object.keys(body).filter((k) => k !== "source" && k !== "role"),
      },
    });

    return c.json(
      {
        id: updated.id,
        label: updated.label,
        source: updated.source,
        role: updated.role,
        default_tier: updated.default_tier,
        is_platform: updated.is_platform,
        type_permissions: updated.type_permissions,
        extension_permissions: updated.extension_permissions,
        edge_permissions: updated.edge_permissions,
        metadata_permissions: updated.metadata_permissions,
        created_at: updated.created_at,
        // Sent because it can be. Unlike the create routes, where the field
        // was declared and no key a door mints could ever carry one, any key
        // is patchable — a runtime credential included, and those always
        // carry a hard lifetime bound. A caller updating a credential's
        // permissions asked for the key, and when it stops working is part of
        // the key, so the honest fix was to make the handler match the
        // declaration rather than the other way round.
        expires_at: updated.expires_at,
        last_used_at: updated.last_used_at,
      },
      200,
    );
  });

  return router;
}
