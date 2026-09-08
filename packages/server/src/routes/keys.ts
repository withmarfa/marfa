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
import type { Context } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import {
  firstUncoveredScope,
  refuseUnclampableExtensions,
  type RequestedReach,
} from "../auth/mint-clamp.js";
import {
  requireSpacePermission,
  requireSpaceAdmin,
  hashApiKey,
  isReservedCredentialSource,
  RESERVED_CREDENTIAL_SOURCE_PREFIXES,
} from "../middleware/auth.js";
import { log } from "../middleware/logger.js";
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
  scope_enforced: z
    .boolean()
    .optional()
    .describe(
      "Read-only. True when the key was minted through a signed-in app rather than from another key: its permission maps decide what it reaches, and its role does not override them. Set by the server at mint time and never settable through this API.",
    ),
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
    "Creates a new API key in the caller's space. The plaintext `key` is returned only in this response and never shown again, so store it securely. The new key's space is always the caller's: a `space_id` in the body is rejected, and a caller that has no space cannot mint `role: \"space_admin\"` (the key would inherit no space, so its authority would not stop at the boundary its role names). Use `POST /admin/spaces/{id}/keys` to mint into a specific space. `role` may not exceed the caller's own role (admin > space_admin > member); asking for a higher one returns 403, and `is_platform` is granted only when the caller is itself a platform credential. A signed-in app must hold `space.keys`, and the key it mints may not reach past what its own grant covers — a request for more is refused naming the scope. Such a key is `scope_enforced`: its permission maps decide what it reaches and its role does not override them. Omitting the maps mints a key matching the session's own reach rather than an empty one. On a fresh server with zero keys, this runs in bootstrap mode (no auth, minted key is always admin); once any key exists, creation requires an admin or space_admin token.",
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
        "Caller is not an admin or space_admin, requested a role above its own, or is a signed-in app that was not granted `space.keys` or asked for reach its grant does not cover. The last two name the missing scope in `details.required_scope`.",
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
  scope_enforced: z
    .boolean()
    .optional()
    .describe(
      "Read-only. True when the key was minted through a signed-in app rather than from another key: its permission maps decide what it reaches, and its role does not override them. Set by the server at mint time and never settable through this API.",
    ),
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
/**
 * The `details` an OAuth-minted key's audit row carries, so a revoked grant
 * leads to the keys it created.
 *
 * **A key outlives the grant that minted it**, and nothing else in the row
 * points back: `key_id` names the synthetic principal, whose id is the access
 * token's, and that token is gone within the hour. So the durable identifiers
 * go in `details` — the client, the user, and the grant projection — mirroring
 * the shape the `auth.grant.*` rows already use, which is what lets an operator
 * revoking an app find the credentials it left behind.
 *
 * Resolved with the same call the bearer middleware makes, and tolerated
 * missing: a null projection is a grant an operator deleted by hand, and losing
 * the client and user ids as well because of it would be the worse answer.
 */
async function resolveGrantItemId(
  storage: Storage,
  c: Context<AppEnv>,
): Promise<string | null> {
  const grant = c.get("oauthGrant");
  if (
    !grant?.authUserId ||
    typeof storage.oauthProvider?.findGrantItemId !== "function"
  ) {
    return null;
  }
  try {
    return await storage.oauthProvider.findGrantItemId({
      spaceId: c.get("apiKey")?.space_id ?? null,
      clientId: grant.clientId,
      authUserId: grant.authUserId,
    });
  } catch (err) {
    // **Resolved before the key is written, and swallowed, for the same
    // reason the audit write itself is `void`ed.** A read that throws must not
    // decide whether a mint succeeds: past the insert the plaintext exists in
    // exactly one place, the response, so a failure raised after it loses the
    // key forever and leaves a live credential in the table. A null costs one
    // hop in the trail; the client and user ids still name the app.
    //
    // Logged because null otherwise means two different things. The audit
    // row's own reading of a null projection is "a grant an operator deleted
    // by hand", and a storage fault arriving as the same value would make the
    // trail quietly wrong rather than visibly incomplete.
    log("warn", "keys: grant projection lookup failed for a key.create row", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function mintDetails(
  c: Context<AppEnv>,
  platformTierMint: boolean,
  grantItemId: string | null,
): Record<string, unknown> | undefined {
  const base = platformTierMint ? { platform_tier: true } : {};
  const grant = c.get("oauthGrant");
  if (!grant) return platformTierMint ? base : undefined;
  return {
    ...base,
    client_id: grant.clientId,
    user_id: grant.authUserId,
    grant_item_id: grantItemId,
  };
}

/**
 * Refuse a session asking to give a key reach its own grant does not cover.
 *
 * Shared by the mint and the update, because a clamp on one alone is not a
 * clamp. The permission maps are writable after the fact, so a request refused
 * at `POST` and accepted at `PATCH` a moment later leaves the ceiling exactly
 * where it was — and `PATCH` reaches every key in the space, not only the ones
 * this session minted.
 */
function refuseSessionReachAboveGrant(
  granted: readonly string[],
  requested: RequestedReach,
): void {
  const unclampable = refuseUnclampableExtensions(requested);
  if (unclampable !== null) {
    throw new MarfaError(ErrorCode.FORBIDDEN, unclampable);
  }
  const uncovered = firstUncoveredScope(granted, requested);
  if (uncovered !== null) {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      `This app was not granted ${uncovered}, so it cannot give a key reach it does not hold itself.`,
      { required_scope: uncovered },
    );
  }
}

// Router
// ---------------------------------------------------------------------------

export function keyRoutes(storage: Storage, salt: string) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(createKeyRoute, async (c) => {
    const isBootstrap = c.get("isBootstrap");
    if (!isBootstrap) {
      requireSpaceAdmin(c);
      // A session may mint, if it was granted the permission to and the key it
      // asks for does not reach past the session's own grant. Role still caps
      // what can be granted; this caps what a granted role may be spent on.
      //
      // The blanket refusal that used to stand here was doing two jobs at once
      // — withholding the permission, and preventing the escalation a mint
      // makes possible. Both are still done, by two things that can be reasoned
      // about separately: `requireSpacePermission` here, and the breadth clamp plus
      // `scope_enforced` below. Removing one without the others is the mistake
      // to avoid; see `auth/mint-clamp.ts`.
      requireSpacePermission(c, "space.keys");
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

    // **The default for a session is a key like the session.** An OAuth caller
    // that names no permission maps gets the ones its own grant projects, which
    // the bearer middleware has already computed and hung on the synthetic key.
    // The alternative default is `{}`, and on a `scope_enforced` key that means
    // a credential that can read nothing — so "mint me a key" would hand back
    // something inert, and the only way to get a working one would be to
    // enumerate by hand what the session already holds.
    //
    // An API-key caller keeps `{}`, exactly as before: its key is not
    // scope-enforced, so its role decides, and inheriting the caller's maps
    // would silently widen the common `role: "member"` mint.
    const callerGrant = c.get("oauthGrant");
    const sessionKey = c.get("apiKey");
    const mintingFromSession = !isBootstrap && c.get("authType") === "oauth";
    const requested = {
      type_permissions: body.type_permissions,
      edge_permissions: body.edge_permissions,
      metadata_permissions: body.metadata_permissions,
      extension_permissions: body.extension_permissions,
    };
    // All four families. The other three are measured by the clamp whether or
    // not the derive path is on, so this fourth term is not what closed the
    // unmeasured-extension hole — `refuseUnclampableExtensions` is. What it
    // does is stop a body naming only `extension_permissions: {}` from taking
    // the derive path, which would be a narrower key than asked for rather
    // than a wider one. Kept because the condition should read all four
    // families or it invites the next reader to add a fifth and forget.
    const namesNoReach =
      requested.type_permissions === undefined &&
      requested.edge_permissions === undefined &&
      requested.metadata_permissions === undefined &&
      requested.extension_permissions === undefined;

    // Checked before the derive below, because the derived case cannot exceed
    // anything: it is a copy of what the session already holds.
    if (mintingFromSession) {
      refuseSessionReachAboveGrant(callerGrant?.scopes ?? [], requested);
    }

    // **A session mints at `member` and no higher, and this is not the same
    // question as `canGrantRole`.** That one asks whether the role travels up
    // the lattice from the caller's own, and a `space_admin` user's app asking
    // for `space_admin` travels sideways, which it permits.
    //
    // The axis it does not measure is the one that matters here. The session's
    // own principal is scope-enforced: its effective authority is its
    // permission maps, not its rank. A key carrying rank is therefore wider
    // than the session that asked for it, because rank gates
    // (`hasSpaceAdminAuthority`) read the role and never consult
    // `scope_enforced` — audit, credentials, connections, space config and the
    // schema doors all open on rank alone. And nothing measures that: no scope
    // expresses a role, so the clamp above has nothing to compare.
    //
    // Transiently the session already reaches those doors, which is why this
    // is about durability rather than breadth. A minted key outlives the grant
    // and survives the app being revoked, with no scope literal on the row to
    // say what it was ever allowed to be. `member` keeps the key inside the
    // permission-map system, which is the only place the clamp can hold it.
    if (mintingFromSession && role !== "member") {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        `A signed-in app can only mint a key with role "member". A higher role carries authority no scope expresses, so the key could not be held to the app's grant once minted.`,
      );
    }

    const derivedFromSession = mintingFromSession && namesNoReach;
    const typePermissions = derivedFromSession
      ? (sessionKey?.type_permissions ?? {})
      : (body.type_permissions ?? {});
    const edgePermissions = derivedFromSession
      ? (sessionKey?.edge_permissions ?? {})
      : body.edge_permissions;
    const metadataPermissions = derivedFromSession
      ? (sessionKey?.metadata_permissions ?? {})
      : body.metadata_permissions;
    // Never derived, because no scope expresses an extension grant: the
    // synthetic key carries `{}` and there is nothing for a session to pass on.
    const extensionPermissions = derivedFromSession
      ? {}
      : body.extension_permissions;

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

    // Resolved ahead of the write, so nothing between the insert and the
    // response can fail and take the plaintext with it.
    const grantItemId = await resolveGrantItemId(storage, c);

    const stored = await storage.keys.create(
      {
        label: body.label.trim(),
        source: body.source.trim(),
        role: role,
        default_tier: body.default_tier,
        is_platform: isPlatform,
        type_permissions: typePermissions,
        extension_permissions: extensionPermissions,
        edge_permissions: edgePermissions,
        metadata_permissions: metadataPermissions,
        // Set from who is minting, never from the body. A key minted through a
        // session is held to the maps above rather than to its role, which is
        // what keeps the clamp meaningful past the moment of minting.
        scope_enforced: mintingFromSession,
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
      details: mintDetails(c, platformTierMint, grantItemId),
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
        scope_enforced: stored.scope_enforced,
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
    requireSpacePermission(c, "space.keys");
    const all = await storage.keys.list();
    const visible = key.space_id
      ? all.filter((k) => k.space_id === key.space_id)
      : all;
    return c.json({ keys: visible }, 200);
  });

  router.openapi(revokeKeyRoute, async (c) => {
    const key = requireSpaceAdmin(c);
    requireSpacePermission(c, "space.keys");
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
    requireSpacePermission(c, "space.keys");
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

    // **The same ceiling as the mint, because this door reaches further.** A
    // clamp applied only at `POST` is not a clamp at all: the permission maps
    // are writable here a moment later, and this route addresses every key in
    // the caller's space rather than only the ones the session minted. So a
    // session refused a wide key at the mint could have widened an existing
    // one instead — including a key it did not create.
    if (c.get("authType") === "oauth") {
      refuseSessionReachAboveGrant(c.get("oauthGrant")?.scopes ?? [], {
        type_permissions: body.type_permissions,
        edge_permissions: body.edge_permissions,
        metadata_permissions: body.metadata_permissions,
        extension_permissions: body.extension_permissions,
      });
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
        scope_enforced: updated.scope_enforced,
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
