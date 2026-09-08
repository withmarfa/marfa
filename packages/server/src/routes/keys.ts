import { randomBytes } from "node:crypto";
import type { ApiKey, SpacePermission } from "@withmarfa/shared";
import { createRoute, z } from "@hono/zod-openapi";
import {
  MarfaError,
  ErrorCode,
  isValidId,
  SPACE_PERMISSIONS,
  isSpacePermission,
} from "@withmarfa/shared";
import type { Context } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import {
  firstUncoveredExtension,
  firstUncoveredScope,
  refuseUnclampableExtensions,
  scopesHeldByMaps,
  type RequestedReach,
} from "../auth/mint-clamp.js";
import {
  requireSpacePermission,
  hasOperatorAuthority,
  requireAuth,
  hashApiKey,
  isReservedCredentialSource,
  RESERVED_CREDENTIAL_SOURCE_PREFIXES,
} from "../middleware/auth.js";
import { log } from "../middleware/logger.js";
import type { Storage } from "../storage/interface.js";
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
  space_permissions: z
    .array(z.enum(SPACE_PERMISSIONS as unknown as [string, ...string[]]))
    .optional()
    .describe(
      "The space permissions this credential holds, as the literals themselves. Omitted on a create request takes the creator's whole set; anything named is honoured and clamped to what the creator holds.",
    ),
  oauth_client_id: z
    .string()
    .optional()
    .describe(
      "The registered client that minted this key, when a signed-in app did. Absent on a key a person or another key created directly.",
    ),
  default_tier: z.enum(["library", "feed"]),
  is_operator: z.boolean(),
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
    "Creates a new API key in the caller's space. The plaintext `key` is returned only in this response and never shown again, so store it securely.\n\nThe new key's space is always the caller's: a `space_id` in the body is rejected. Use `POST /admin/spaces/{id}/keys` to mint into a named space.\n\nA credential is a set of permissions and nothing else. `space_permissions` names the space permissions the key holds; omitting it takes the creator's whole set, and anything named is clamped to what the creator holds, so a mint can narrow and can never widen. The content maps behave the same way, and a signed-in app must hold `space.keys` to reach this route at all.\n\nAn operator key mints another operator key here and nothing else, because the instance tier is the absence of a space binding and an operator caller has no space to hand down. `is_operator` is granted only when the caller is itself an operator key.\n\nOn a fresh server with zero keys this runs in bootstrap mode: no authentication, and the key it mints is the operator key.",

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
            space_permissions: z
              .array(
                z.enum(SPACE_PERMISSIONS as unknown as [string, ...string[]]),
              )
              .optional(),
            default_tier: z.enum(["library", "feed"]).optional(),
            is_operator: z.boolean().optional(),
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
            profile_permissions: z
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
        "Body carried a `space_id`. A key is minted into its creator's space, so the space is never named in the body.",
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
        "Caller does not hold `space.keys`, asked for reach its own credential does not cover, or asked to mint across the instance tier in either direction. A missing permission is named in `details.required_scope`.",
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
    "Returns every API key in the caller's space without plaintext, which is only ever returned at creation time. `last_used_at` is debounced to at most one write per hour, so treat it as a coarse activity signal rather than an audit log. Requires `space.keys`.",
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
    "Revokes the key immediately; the next request bearing it returns `401 unauthorized`. In-flight long-lived connections (SSE) terminate on the next heartbeat. Requires `space.keys`.",
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

/**
 * **The operator key reaches these doors by being the operator key**, and holds
 * no space permission to be checked. Key management is instance-tier work when
 * the operator does it — it mints the credential a space works through, and it
 * is the only caller that can see the keys of every space — so asking a space
 * permission of it would be asking the wrong question, and the only answer it
 * could ever give is no, because running the instance is deliberately not
 * expressible as a permission.
 *
 * Everything else is held to `space.keys`, and the space fence on each door is
 * separate: it keys on the caller's space binding, which is what says *which*
 * space a credential may manage keys in.
 */
function requireSpaceKeysOrOperator(c: Context<AppEnv>): void {
  if (hasOperatorAuthority(requireAuth(c))) return;
  requireSpacePermission(c, "space.keys");
}

// Passthrough — `source` is immutable and rejected explicitly in the handler
// with a readable error instead of a generic "unrecognized keys".
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
  profile_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  space_permissions: z
    .array(z.enum(SPACE_PERMISSIONS as unknown as [string, ...string[]]))
    .optional(),
  source: z.unknown().optional(),
});

const KeyDetailSchema = z.object({
  id: z.string(),
  label: z.string(),
  source: z.string(),
  space_permissions: z
    .array(z.enum(SPACE_PERMISSIONS as unknown as [string, ...string[]]))
    .optional()
    .describe(
      "The space permissions this credential holds, as the literals themselves. Omitted on a create request takes the creator's whole set; anything named is honoured and clamped to what the creator holds.",
    ),
  oauth_client_id: z
    .string()
    .optional()
    .describe(
      "The registered client that minted this key, when a signed-in app did. Absent on a key a person or another key created directly.",
    ),
  default_tier: z.enum(["library", "feed"]),
  is_operator: z.boolean(),
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
    "Updates a key's label, default tier, or permission maps in place. `source` is immutable and rejected with `400 validation_error` if present in the body — revoke and recreate to change it. Requires `space.keys`.",
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

/**
 * Refuse a key-minted key that reaches past the key that minted it.
 *
 * The sibling of `refuseSessionReachAboveGrant`, asking one question of a
 * different carrier: a session holds scopes, a key holds maps, and
 * `scopesHeldByMaps` projects the second into the first so both go through
 * `grantCoversScope`.
 *
 * **The operator key is exempt because it has nothing to be measured against.**
 * Running the instance is fenced outside the permission model, so its maps are
 * empty by construction; measuring against them would refuse every mint it
 * makes. What it may mint is bounded instead by the rule one gate up — through
 * this route it mints another operator key and nothing else.
 *
 * Extensions are compared directly rather than refused. A session cannot be
 * asked about a namespace because no scope names one; a key holds a map of the
 * same shape, so the comparison is a lookup.
 */
function refuseKeyReachAboveCreator(
  creator: ApiKey,
  requested: RequestedReach,
): void {
  if (hasOperatorAuthority(creator)) return;

  const namespace = firstUncoveredExtension(
    creator.extension_permissions,
    requested.extension_permissions,
  );
  if (namespace !== null) {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      `This credential does not hold the ${namespace} extension namespace, so it cannot give a key reach it does not hold itself.`,
    );
  }

  const uncovered = firstUncoveredScope(scopesHeldByMaps(creator), requested);
  if (uncovered !== null) {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      `This credential does not hold ${uncovered}, so it cannot give a key reach it does not hold itself.`,
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
      requireAuth(c);
      // A session may mint, if it was granted the permission to and the key it
      // asks for does not reach past the session's own grant. Holding
      // `space.keys` says a credential may mint; the clamp below says how far
      // what it mints may reach.
      //
      // The blanket refusal that used to stand here was doing two jobs at once
      // — withholding the permission, and preventing the escalation a mint
      // makes possible. Both are still done, by two things that can be reasoned
      // about separately: `requireSpacePermission` here, and the breadth clamp
      // below. Removing one without the other is the mistake to avoid; see
      // `auth/mint-clamp.ts`.
      //
      requireAuth(c);
      requireSpaceKeysOrOperator(c);
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
    // mint. Everyone else falls through to requireOperatorKey and receives 401.
    if (isBootstrap) {
      const claimed = await storage.settings.claim("bootstrapped", "true");
      if (!claimed) {
        throw new MarfaError(ErrorCode.UNAUTHORIZED, "Authentication required");
      }
    }

    assertUnreservedSource(body.source);

    // **The default for a session is a key like the session.** An OAuth caller
    // that names no permission maps gets the ones its own grant projects, which
    // the bearer middleware has already computed and hung on the synthetic key.
    // The alternative default is `{}`, which under one permission model is a
    // credential that can read nothing — so "mint me a key" would hand back
    // something inert, and the only way to get a working one would be to
    // enumerate by hand what the session already holds.
    const callerGrant = c.get("oauthGrant");
    const callerKey = c.get("apiKey");
    const mintingFromSession = !isBootstrap && c.get("authType") === "oauth";

    // **Through this route the operator key mints another operator key and
    // nothing else.** The instance tier is the absence of a space binding, and
    // a credential's space is always its creator's, so an operator caller has
    // no space to hand down: a key it minted here that was not itself an
    // operator key would be space-less and ordinary, which is the one shape
    // the row constraint refuses. Everything space-bound goes through
    // `POST /admin/spaces/{id}/keys`, which names the space in the path.
    const callerIsOperator =
      isBootstrap || c.get("apiKey")?.is_operator === true;
    if (!isBootstrap && callerIsOperator && body.is_operator === false) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "An operator key mints another operator key here, or a space key through POST /admin/spaces/{id}/keys. It has no space of its own to give a key minted from it.",
      );
    }
    if (!isBootstrap && !callerIsOperator && body.is_operator === true) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        "Only an operator key can mint another. Running the instance sits outside the permission model, so nothing in a permission set reaches it.",
      );
    }

    // **The creator is the ceiling, and omitting the list takes the whole of
    // it.** A key gets what its creator holds unless the request names less,
    // and anything it names is honoured whatever the creator holds — which
    // together mean a key can be narrowed at the moment of minting and can
    // never be widened by one.
    //
    // The bootstrap key takes nothing, because it is the operator key: the
    // instance tier is fenced outside the model rather than expressed as a
    // full set inside it.
    const callerHeldSpacePermissions: SpacePermission[] = isBootstrap
      ? []
      : mintingFromSession
        ? (c.get("oauthGrant")?.scopes ?? []).filter(isSpacePermission)
        : (c.get("apiKey")?.space_permissions ?? []);
    const requestedSpacePermissions =
      body.space_permissions?.filter(isSpacePermission);
    if (requestedSpacePermissions !== undefined) {
      const beyond = requestedSpacePermissions.find(
        (permission) => !callerHeldSpacePermissions.includes(permission),
      );
      if (beyond !== undefined) {
        throw new MarfaError(
          ErrorCode.FORBIDDEN,
          `This credential does not hold ${beyond}, so it cannot give a key a permission it does not hold itself.`,
          { required_scope: beyond },
        );
      }
    }
    const spacePermissions =
      requestedSpacePermissions ?? callerHeldSpacePermissions;

    const requested = {
      type_permissions: body.type_permissions,
      edge_permissions: body.edge_permissions,
      metadata_permissions: body.metadata_permissions,
      extension_permissions: body.extension_permissions,
    };
    // **The ceiling is asked of every creator, not only of a session.** A
    // session is measured against its granted scopes; a key is measured against
    // the literals its own maps confer, which is the same question through the
    // same comparison. Bootstrap is the exception the design names: it is a
    // seed, with no creator above it to be bounded by.
    //
    // Checked before the derive below, because the derived case cannot exceed
    // anything: it is a copy of what the creator already holds.
    if (mintingFromSession) {
      refuseSessionReachAboveGrant(callerGrant?.scopes ?? [], requested);
    } else if (!isBootstrap && callerKey) {
      refuseKeyReachAboveCreator(callerKey, requested);
    }

    // **A body naming no reach at all takes the creator's whole set; a body
    // naming any family gets only what it named.** One rule, and the second
    // half of it is deliberate: naming a narrow type map and receiving the
    // creator's edges for free would be a key wider than the request, which is
    // a different failure from a key wider than the creator and just as
    // unwanted. Asking all five families is what makes "named nothing"
    // unambiguous.
    //
    // Deriving is what stops the other shape — a credential holding every
    // permission in a space and unable to read a row of it, which is what an
    // empty default produced and what the space mint was already fixed for.
    // Bootstrap derives from nothing, because the operator key holds nothing
    // to give.
    const namesNoReach =
      body.type_permissions === undefined &&
      body.edge_permissions === undefined &&
      body.metadata_permissions === undefined &&
      body.extension_permissions === undefined &&
      body.profile_permissions === undefined;
    const creator = !isBootstrap && namesNoReach ? callerKey : undefined;
    const typePermissions =
      creator?.type_permissions ?? body.type_permissions ?? {};
    const edgePermissions =
      creator?.edge_permissions ?? body.edge_permissions ?? {};
    const metadataPermissions =
      creator?.metadata_permissions ?? body.metadata_permissions ?? {};
    const profilePermissions =
      creator?.profile_permissions ?? body.profile_permissions ?? {};
    const extensionPermissions =
      creator?.extension_permissions ?? body.extension_permissions ?? {};

    const rawKey = generateRawKey();
    const keyHash = hashApiKey(rawKey, salt);

    // The new key's space is always the caller's, and an operator caller has
    // none to give. The row constraint holds the pair together: space-less
    // when and only when the key is an operator key.
    const newKeySpaceId = c.get("apiKey")?.space_id;

    // Resolved ahead of the write, so nothing between the insert and the
    // response can fail and take the plaintext with it.
    const grantItemId = await resolveGrantItemId(storage, c);

    const stored = await storage.keys.create(
      {
        label: body.label.trim(),
        source: body.source.trim(),
        default_tier: body.default_tier,
        is_operator: callerIsOperator,
        space_permissions: spacePermissions,
        type_permissions: typePermissions,
        extension_permissions: extensionPermissions,
        edge_permissions: edgePermissions,
        metadata_permissions: metadataPermissions,
        profile_permissions: profilePermissions,
        // Set from who is minting, never from the body. A key an app made
        // belongs to that app: the keys page groups it there, and revoking the
        // app offers to revoke it.
        oauth_client_id: mintingFromSession
          ? c.get("oauthGrant")?.clientId
          : undefined,
      },
      keyHash,
      newKeySpaceId,
    );

    // A key with no space is instance tier: the RLS middleware skips its
    // wrapper for it and the storage layer drops its space predicate. Only the
    // operator key is minted that way, and the audit row records the tier so
    // every such credential can be enumerated later. Derived from the stored
    // space alone rather than from how the instance is configured, so the
    // trail stays accurate whatever the deployment shape.
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
        default_tier: stored.default_tier,
        is_operator: stored.is_operator,
        space_permissions: stored.space_permissions,
        oauth_client_id: stored.oauth_client_id,
        type_permissions: stored.type_permissions,
        extension_permissions: stored.extension_permissions,
        edge_permissions: stored.edge_permissions,
        metadata_permissions: stored.metadata_permissions,
        profile_permissions: stored.profile_permissions,
        created_at: stored.created_at,
        last_used_at: stored.last_used_at,
      },
      201,
    );
  });

  router.openapi(listKeysRoute, async (c) => {
    // A space-bound caller sees only its own space's keys; only an unbound
    // credential sees all. The fence keys on the space binding, which is the
    // only thing that says which space a credential belongs to — holding
    // `space.keys` says nothing about where.
    const key = requireAuth(c);
    requireSpaceKeysOrOperator(c);
    const all = await storage.keys.list();
    const visible = key.space_id
      ? all.filter((k) => k.space_id === key.space_id)
      : all;
    return c.json({ keys: visible }, 200);
  });

  router.openapi(revokeKeyRoute, async (c) => {
    const key = requireAuth(c);
    requireSpaceKeysOrOperator(c);
    const { id } = c.req.valid("param");

    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid key ID");
    }

    // 404 not 403 — cross-space probes must not enumerate key ids. Keyed on
    // the space binding, like the listing above.
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
    const key = requireAuth(c);
    requireSpaceKeysOrOperator(c);
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
    //
    // Asked of every editor rather than only of a session, for the reason the
    // mint states: a key holding `space.keys` and read on one type is an
    // ordinary credential now, and nothing about holding the permission to
    // edit says how far what it edits may reach.
    const requestedReach = {
      type_permissions: body.type_permissions,
      edge_permissions: body.edge_permissions,
      metadata_permissions: body.metadata_permissions,
      extension_permissions: body.extension_permissions,
    };
    if (c.get("authType") === "oauth") {
      refuseSessionReachAboveGrant(
        c.get("oauthGrant")?.scopes ?? [],
        requestedReach,
      );
    } else {
      refuseKeyReachAboveCreator(key, requestedReach);
    }

    // **The space permissions are clamped here too, and were not.** They are
    // editable through this door like any other family, so a key holding one
    // permission could have given itself the other ten.
    const requestedSpacePermissions =
      body.space_permissions?.filter(isSpacePermission);
    if (requestedSpacePermissions !== undefined && !hasOperatorAuthority(key)) {
      const held = key.space_permissions ?? [];
      const beyond = requestedSpacePermissions.find(
        (permission) => !held.includes(permission),
      );
      if (beyond !== undefined) {
        throw new MarfaError(
          ErrorCode.FORBIDDEN,
          `This credential does not hold ${beyond}, so it cannot give a key a permission it does not hold itself.`,
          { required_scope: beyond },
        );
      }
    }

    const updated = await storage.keys.update(id, {
      label: body.label,
      default_tier: body.default_tier,
      type_permissions: body.type_permissions,
      extension_permissions: body.extension_permissions,
      edge_permissions: body.edge_permissions,
      metadata_permissions: body.metadata_permissions,
      space_permissions: requestedSpacePermissions,
      profile_permissions: body.profile_permissions,
    });

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "key.update",
      resource_type: "key",
      resource_id: id,
      details: {
        fields: Object.keys(body).filter((k) => k !== "source"),
      },
    });

    return c.json(
      {
        id: updated.id,
        label: updated.label,
        source: updated.source,
        default_tier: updated.default_tier,
        is_operator: updated.is_operator,
        space_permissions: updated.space_permissions,
        oauth_client_id: updated.oauth_client_id,
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
