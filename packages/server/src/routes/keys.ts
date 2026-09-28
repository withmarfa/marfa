import { randomBytes } from "node:crypto";
import type { ApiKey, Permission } from "@withmarfa/shared";
import { createRoute, z } from "@hono/zod-openapi";
import {
  MarfaError,
  ErrorCode,
  isValidId,
  PERMISSIONS,
  isPermission,
} from "@withmarfa/shared";
import type { Context } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import {
  firstReachBeyondCredential,
  firstUncoveredExtension,
  firstUncoveredScope,
  refuseUnclampableExtensions,
  type RequestedReach,
} from "../auth/mint-clamp.js";
import {
  requirePermission,
  requireAuth,
  hashApiKey,
  isReservedCredentialSource,
  RESERVED_CREDENTIAL_SOURCE_PREFIXES,
} from "../middleware/auth.js";
import { log } from "../middleware/logger.js";
import {
  BOOTSTRAP_SECRET_KEY,
  bootstrapSecretMatches,
  consumeBootstrapSecret,
} from "../auth/bootstrap-secret.js";
import type { Storage } from "../storage/interface.js";
import {
  EnforcementOverrideSchema,
  KeyResponseSchema,
  nullableRef,
  pageOf,
  PermissionEnum,
  PermissionLevelEnum,
  TierEnum,
  TypePermissionLevelEnum,
} from "./_schemas.js";
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
 * Refuse a caller-supplied `source` that claims a connector shape.
 *
 * `source` is otherwise free text, but two prefixes are read elsewhere as
 * proof of an identity a caller cannot earn by naming it: see
 * `RESERVED_CREDENTIAL_SOURCE_PREFIXES`. Nothing legitimate is turned away
 * here, because no credential this route mints holds either shape.
 *
 * `POST /keys` writes `source` straight from the body.
 */
export function assertUnreservedSource(source: string): void {
  if (!isReservedCredentialSource(source)) return;
  throw new MarfaError(
    ErrorCode.VALIDATION_ERROR,
    `\`source\` may not start with ${RESERVED_CREDENTIAL_SOURCE_PREFIXES.map((p) => `"${p}"`).join(", ")} — those prefixes name an identity a credential cannot claim for itself.`,
  );
}

/**
 * Refuse a claim under a prefix no key may hold, for the reason
 * `assertUnreservedSource` refuses one as a key's own: a claimed source is
 * stamped on rows exactly as an own one is, so the reservation that keeps a
 * connector's mark off hand-written rows has to cover both.
 *
 * Asked of every caller, the operator key included. The operator may grant
 * any source a key can hold, and these are the ones no key can.
 */
function assertUnreservedSources(sources: readonly string[] | undefined): void {
  const reserved = sources?.find(isReservedCredentialSource);
  if (reserved === undefined) return;
  throw new MarfaError(
    ErrorCode.VALIDATION_ERROR,
    `\`sources\` may not claim "${reserved}": a source starting with ${RESERVED_CREDENTIAL_SOURCE_PREFIXES.map((p) => `"${p}"`).join(", ")} names an identity no key can hold.`,
    { source: reserved },
  );
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * The sources a key claims besides its own, as the two writing doors take
 * them. Trimmed and bounded as `source` is, so a claim can be anything a
 * key's own source could be and a write names both the same way.
 */
const SourcesSchema = z
  .array(z.string().trim().min(1, "a claimed source is not empty").max(200))
  .describe(
    "The sources a write by this key may name besides its own `source`, so its rows are keyed by the named source. Two keys may claim one source, which is how two devices present one natural key; a key's own `source` stays unique. Held to the rules the permission maps keep: omitted on a create that names no map either, it takes the creator's claims; named, it is only what it names; a working key may grant only its own `source` and what it claims itself, and the operator key may grant any. A source starting `oauth:` or `connector:` is refused.",
  );

const EdgePermissionsSchema = z
  .record(z.string(), PermissionLevelEnum)
  .optional();

/** A stored key as every door that returns one returns it, plaintext aside. */
const ApiKeySchema = z
  .object({
    id: z.string(),
    label: z.string(),
    source: z.string(),
    sources: z
      .array(z.string())
      .optional()
      .describe(
        "The sources a write by this key may name besides its own `source`. Empty on a key that claims nothing.",
      ),
    permissions: z
      .array(PermissionEnum)
      .optional()
      .describe(
        "The permissions this credential holds, as the literals themselves. Omitted on a create request that names no map and no claimed source, it takes the creator's whole set; omitted beside a map or a claimed source, the key holds none. Anything named beyond what the creator holds is refused.",
      ),
    oauth_client_id: z
      .string()
      .optional()
      .describe(
        "The registered client that minted this key, when a signed-in app did. Absent on a key a person or another key created directly.",
      ),
    default_tier: TierEnum,
    is_operator: z.boolean(),
    type_permissions: z.record(z.string(), TypePermissionLevelEnum),
    extension_permissions: z.record(z.string(), PermissionLevelEnum).optional(),
    edge_permissions: EdgePermissionsSchema,
    metadata_permissions: z.record(z.string(), PermissionLevelEnum).optional(),
    // Declared because the handler sends them: a listing returns stored rows
    // whole, so a field a row can carry and the declaration omits is a field
    // a generated client cannot read.
    profile_permissions: z.record(z.string(), PermissionLevelEnum).optional(),
    enforcement_override: EnforcementOverrideSchema.optional(),
    created_at: z.string(),
    expires_at: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Hard lifetime bound, and NULL on every key a door mints. A key past this instant is refused at the bearer gate exactly like a revoked one.",
      ),
    last_used_at: z.string().nullable(),
  })
  .openapi("ApiKey");

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
    "Creates a new API key. The plaintext `key` is returned only in this response and never shown again, so store it securely.\n\nA credential is a set of permissions and nothing else. `permissions` names the permissions the key holds, and anything named beyond what the creator holds is refused, so a mint can narrow and can never widen. A body naming no map and no claimed source takes the creator's whole set, permissions and maps alike; a body naming any of them holds only what it names, so a key minted with a type map and no `permissions` holds no permission. A map entry beyond the creator's is refused the same way, and a signed-in app must hold `keys.mint` to reach this route at all.\n\n`source` is the key's own, and no other unrevoked key may hold it as its own, though keys claiming it write under it too. `sources` names the sources the key claims besides it, which a write may name so its rows are keyed by the claimed source; a working key may grant only its own `source` and what it claims itself.\n\nThe operator key holds no permissions, because running the instance sits outside the permission model, so it is not a ceiling: a working key it mints holds what the body names, or the whole set when the body names nothing. With `is_operator: true` it mints a second operator key instead, which holds nothing, so a body naming any map entry, permission or claimed source on one is refused. `is_operator` is granted only when the caller is itself an operator key.\n\nOn a fresh server with zero keys this runs in bootstrap mode: the key it mints is the operator key, and the request must present the one-time secret the server printed to its log at startup, as a bearer token. That secret works once — the mint consumes it — and a body naming `sources` there is refused as on any operator key, with the secret left to mint again. The operator key is not a working key, so the next call is this route again with it, minting the key to configure a client with.",

  security: [{ bearerAuth: [] }],
  request: {
    // Strict, and that is load-bearing rather than tidiness. A field this
    // body does not declare is stripped by an ordinary object, and on a body
    // naming no map `permissions` omitted does not mean "none": it means the
    // creator's whole set, or every permission when the operator seeds. So a caller
    // spelling the field wrong asks to narrow and is answered with a
    // credential wider than the one it asked for, which on a mint hands on
    // the power to mint again.
    body: {
      content: {
        "application/json": {
          schema: z.strictObject({
            label: z.string().min(1, "label is required"),
            // Trimmed before it is measured, so a source of spaces is refused
            // here rather than stored empty, where the natural-key lookup
            // reads it as no source at all and a repeated create collides.
            source: z.string().trim().min(1, "source is required").max(200),
            sources: SourcesSchema.optional(),
            permissions: z.array(PermissionEnum).optional(),
            default_tier: TierEnum.optional(),
            is_operator: z.boolean().optional(),
            type_permissions: z
              .record(z.string(), TypePermissionLevelEnum)
              .optional(),
            extension_permissions: z
              .record(z.string(), PermissionLevelEnum)
              .optional(),
            edge_permissions: z
              .record(z.string(), PermissionLevelEnum)
              .optional(),
            metadata_permissions: z
              .record(z.string(), PermissionLevelEnum)
              .optional(),
            profile_permissions: z
              .record(z.string(), PermissionLevelEnum)
              .optional(),
            enforcement_override: EnforcementOverrideSchema.optional(),
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
          schema: makeErrorResponseSchema([
            "missing_required_field",
            "validation_error",
          ]),
        },
      },
      description:
        "`missing_required_field` for a body without `label` or `source`. `validation_error` when the body named a reserved `source` or claimed one in `sources`, or the bootstrap secret was refused.",
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
        "Caller does not hold `keys.mint`, asked for reach its own credential does not cover, asked to give reach to an operator key, or asked to mint an operator key without being one. A missing permission is named in `details.required_scope`, and a claimed source the caller may not grant in `details.source`.",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["conflict"]),
        },
      },
      description:
        "The `source` is already another unrevoked key's own, named in `details.source`: no two unrevoked keys hold one source as their own. Keys that claim it in `sources` write under it too, so a row's source does not name the key that wrote it, and two keys share a natural key by both claiming a source in `sources`.",
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
    "Returns every API key without plaintext, which is only ever returned at creation time. `last_used_at` is debounced to at most one write per hour, so treat it as a coarse activity signal rather than an audit log. Requires `keys.mint`, or the operator key, which reaches these doors by being the operator key rather than by holding a permission.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: pageOf(ApiKeySchema, "ApiKeyPage"),
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
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Caller does not hold `keys.mint`",
    },
  },
});

const currentKeyRoute = createRoute({
  operationId: "getCurrentKey",
  method: "get",
  path: "/current",
  tags: ["Keys"],
  summary: "Read the calling key",
  description:
    "Returns the key the request bears, without plaintext: its permissions, its maps, its claimed sources and its tier. Any key may read itself, whatever it holds, so a process handed a key can check it holds what it should and no more; every other key stays behind `keys.mint`. A signed-in app's token is not a key, and is refused.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: ApiKeySchema } },
      description: "The calling key",
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
      description: "The credential is a signed-in app's token, not a key",
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
    "Revokes the key immediately; the next request bearing it returns `401 unauthorized`. In-flight long-lived connections (SSE) terminate on the next heartbeat. Requires `keys.mint`, or the operator key, which reaches these doors by being the operator key rather than by holding a permission. A revoke that changes no row answers `404 api_key_not_found` rather than success, for every caller: an unknown id and a key already revoked are both refused, and the message says which it was.",
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
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "Malformed key ID",
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
        "`keys.mint` required, unless the caller is the operator key",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["api_key_not_found"]),
        },
      },
      description: "No key was revoked: unknown or already revoked",
    },
  },
});

/**
 * **The operator key reaches these doors by being the operator key**, and holds
 * no permission to be checked. Key management is instance-tier work when
 * the operator does it — it mints the credential an instance works through —
 * so asking a permission of it would be asking the wrong question, and
 * the only answer it could ever give is no, because running the instance is
 * deliberately not expressible as a permission.
 *
 * Everything else is held to `keys.mint`.
 */
function requireKeysMintOrOperator(c: Context<AppEnv>): void {
  if (requireAuth(c).is_operator) return;
  requirePermission(c, "keys.mint");
}

// `source` is declared, and immutable. It is listed here rather than left
// out so the handler refuses a body naming it with a readable error rather
// than the strict object's generic "unrecognized keys"; a caller is told
// which field it may not change.
const UpdateKeyBodySchema = z.strictObject({
  label: z.string().min(1).optional(),
  default_tier: TierEnum.optional(),
  sources: SourcesSchema.optional(),
  type_permissions: z.record(z.string(), TypePermissionLevelEnum).optional(),
  extension_permissions: z.record(z.string(), PermissionLevelEnum).optional(),
  edge_permissions: z.record(z.string(), PermissionLevelEnum).optional(),
  metadata_permissions: z.record(z.string(), PermissionLevelEnum).optional(),
  profile_permissions: z.record(z.string(), PermissionLevelEnum).optional(),
  permissions: z.array(PermissionEnum).optional(),
  enforcement_override: nullableRef(EnforcementOverrideSchema)
    .optional()
    .describe("`null` clears the override; an object replaces it whole."),
  source: z
    .string()
    .optional()
    .describe(
      "A key's source is immutable: a body carrying this field is refused `400 validation_error`. Revoke the key and mint another to change it.",
    ),
});

const updateKeyRoute = createRoute({
  operationId: "updateKey",
  method: "patch",
  path: "/{id}",
  tags: ["Keys"],
  summary: "Update an API key",
  description:
    "Updates a key's label, default tier, claimed `sources` or permission maps in place. `source` is immutable and rejected with `400 validation_error` if present in the body — revoke and recreate to change it. Requires `keys.mint`. A permission map may not be widened past what the calling credential itself holds, and `sources` may name only the caller's own `source` and what it claims. The operator key is excepted, since running the instance sits outside the permission model, but an operator key holds nothing at all, so no map on one may be widened by any caller. A key created by an app is never widened at all, by any caller including the operator key: it holds what that app held, and may only be narrowed.",
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
      content: { "application/json": { schema: ApiKeySchema } },
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
      description:
        "`keys.mint` required, unless the caller is the operator key; or the edit reaches past what the caller holds, or past what a key an app made already holds. A missing permission is named in `details.required_scope`, and a claimed source that may not be granted in `details.source`.",
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
  operatorTierMint: boolean,
  grantItemId: string | null,
): Record<string, unknown> | undefined {
  const base = operatorTierMint ? { operator_tier: true } : {};
  const grant = c.get("oauthGrant");
  if (!grant) return operatorTierMint ? base : undefined;
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
 * where it was — and `PATCH` reaches every key, not only the ones this
 * session minted.
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
 * The first thing a request names that an operator key may not hold, with
 * the detail its refusal carries, or `null` if it names nothing at all.
 *
 * A `none` entry is a denial rather than a request, so it names nothing and
 * is skipped, exactly as the creator ceiling skips it.
 *
 * Each refusal carries what its sibling refusals on this route carry:
 * `required_scope` for a permission and `source` for a claim. A map entry
 * names no scope literal, so it carries neither.
 */
function firstReachOnAnOperatorKey(
  requested: RequestedReach,
  permissions: Permission[] | undefined,
  sources: readonly string[] | undefined,
): { named: string; details?: Record<string, unknown> } | null {
  const maps = [
    ["type", requested.type_permissions],
    ["edge", requested.edge_permissions],
    ["metadata", requested.metadata_permissions],
    ["extension", requested.extension_permissions],
    ["profile", requested.profile_permissions],
  ] as const;
  for (const [axis, map] of maps) {
    for (const [name, level] of Object.entries(map ?? {})) {
      if (level === "none") continue;
      return { named: `${axis} ${name}: ${level}` };
    }
  }
  const permission = permissions?.[0];
  if (permission !== undefined) {
    return { named: permission, details: { required_scope: permission } };
  }
  const source = sources?.[0];
  if (source !== undefined) {
    return { named: `the source "${source}"`, details: { source } };
  }
  return null;
}

/**
 * Refuse an operator key that would hold something.
 *
 * **Running the instance is not a permission, so the tier that runs it
 * carries none.** The row constraint `api_keys_operator_holds_nothing` holds
 * it at the store; this is the route's own answer, ahead of the database
 * refusal.
 *
 * **Two doors could write it and both are here.** The creator ceiling exempts
 * the operator key, because measuring it against its own empty maps would
 * refuse every mint it makes, and that exemption is right for the working key
 * it seeds. It is wrong for a second operator key, which `POST /keys` produces
 * for an operator caller naming `is_operator: true`. `PATCH /keys/{id}` is the
 * same door a moment later, addressing an operator row.
 *
 * Bootstrap asks it of the claims alone, and forces the permission families
 * empty instead, having no creator to derive them from.
 */
function refuseReachOnAnOperatorKey(
  requested: RequestedReach,
  permissions: Permission[] | undefined,
  sources: readonly string[] | undefined,
): void {
  const first = firstReachOnAnOperatorKey(requested, permissions, sources);
  if (first === null) return;
  throw new MarfaError(
    ErrorCode.FORBIDDEN,
    `An operator key holds nothing, so it cannot be given ${first.named}. Mint a working key with POST /keys and grant it there.`,
    first.details,
  );
}

/**
 * The reach an edit writes to a credential that holds nothing: empty where the
 * body named a family, untouched where it did not.
 *
 * **The guard above refuses everything a `none` entry is not, and a `none`
 * entry is the hole.** It is a denial rather than a request, so it names
 * nothing and is skipped, exactly as the creator ceiling skips it. What
 * reaches the store is then a non-empty map bound for a row the constraint
 * says holds `{}`, and the caller reads a database refusal where a route
 * answer belongs. The mint forces the same families empty for the same reason,
 * and `PATCH` is that door a moment later.
 *
 * A family the body did not name stays `undefined`, which the stores read as
 * "leave it alone". Rewriting one the request never mentioned would be a write
 * the audit trail's field list does not account for.
 */
function nothingWhereNamed(requested: RequestedReach): RequestedReach {
  return {
    type_permissions: requested.type_permissions === undefined ? undefined : {},
    edge_permissions: requested.edge_permissions === undefined ? undefined : {},
    metadata_permissions:
      requested.metadata_permissions === undefined ? undefined : {},
    extension_permissions:
      requested.extension_permissions === undefined ? undefined : {},
    profile_permissions:
      requested.profile_permissions === undefined ? undefined : {},
  };
}

/**
 * Refuse a key-minted key that reaches past the key that minted it.
 *
 * The sibling of `refuseSessionReachAboveGrant`, asking one question of a
 * different carrier: a session holds scopes and a key holds maps, and the two
 * are compared by the rule that fits each — see `mint-clamp.ts`, where turning
 * the second into the first is recorded as the unsound move it is.
 *
 * **The operator key is exempt because it has nothing to be measured against.**
 * Running the instance is fenced outside the permission model, so its maps are
 * empty by construction; measuring against them would refuse every mint it
 * makes. What it may mint is bounded instead by what the minted key is: a
 * working key is a seed rather than a ceiling, and a second operator key may
 * hold nothing at all, which `refuseReachOnAnOperatorKey` above is what says
 * so.
 *
 * Extensions are compared directly rather than refused. A session cannot be
 * asked about a namespace because no scope names one; a key holds a map of the
 * same shape, so the comparison is a lookup.
 */
function refuseKeyReachAboveCreator(
  creator: ApiKey,
  requested: RequestedReach,
): void {
  if (creator.is_operator) return;

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

  const uncovered = firstReachBeyondCredential(creator, requested);
  if (uncovered !== null) {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      `This credential does not hold ${uncovered}, so it cannot give a key reach it does not hold itself.`,
      { required_scope: uncovered },
    );
  }
}

/**
 * The first source in `requested` that `holder` may not grant: neither its
 * own source nor one it claims. `null` when it may grant every one.
 *
 * Asked in the order the request names them, so a refusal names the first
 * source past the ceiling rather than the first the caller happens to hold.
 */
function firstUngrantableSource(
  holder: ApiKey,
  requested: readonly string[] | undefined,
): string | null {
  for (const source of requested ?? []) {
    if (source === holder.source) continue;
    if (holder.sources?.includes(source) === true) continue;
    return source;
  }
  return null;
}

/**
 * Refuse a key naming a claim its caller does not hold, on a mint and on an
 * edit alike.
 *
 * **A claim is reach, and it is clamped the way the maps are.** A source a
 * key claims is one its writes may be keyed by, and a create keyed by a
 * source lands on the row another key wrote under the same natural key:
 * handing a claim out is handing out every natural key under that source.
 * So a working key may pass on only what it could write under itself, its
 * own source and its own claims.
 *
 * **The operator key is exempt, and for a reason the map ceiling does not
 * share.** It claims nothing and writes nothing, so measured against itself
 * it could grant no claim at all, and a claim has to start somewhere: the
 * operator granting one is how two devices come to share a folder's source.
 * A signed-in app is measured like any key, against what its token claims,
 * which is nothing beyond its own source, and that one is reserved.
 */
function refuseSourcesAboveCaller(
  caller: ApiKey | undefined,
  requested: readonly string[] | undefined,
): void {
  if (caller === undefined || caller.is_operator) return;
  const beyond = firstUngrantableSource(caller, requested);
  if (beyond === null) return;
  throw new MarfaError(
    ErrorCode.FORBIDDEN,
    `This credential does not claim the source "${beyond}", so it cannot give a key a source it may not write under itself.`,
    { source: beyond },
  );
}

/**
 * Refuse a key whose own source other keys claim, where the caller could not
 * grant that claim.
 *
 * A key writes under its own source as surely as under a claim, so naming
 * as a new key's own a source another key claims hands it every natural key
 * under that source, and leaves it able to grant the source onward as its
 * own. Held to the claim ceiling for that reason, or a caller refused a
 * claim could take it in the same request by naming it as the source
 * instead.
 *
 * **It bounds one mint, not a caller holding `keys.mint`.** That permission
 * edits and revokes any key, so its holder can narrow or revoke the
 * claimants first and mint afterwards, as it can give a revoked key's own
 * source to a new key. What this refuses is the single request that would do
 * it silently, which is also the one a device enrolled with its folder's
 * source as its own would make by mistake.
 *
 * Asked only where the caller could not grant the source, so an ordinary
 * mint costs no read. The listing is the live keys, because a revoked or
 * expired key's claim writes nothing.
 */
async function refuseOwnSourceClaimedElsewhere(
  storage: Storage,
  caller: ApiKey | undefined,
  source: string,
): Promise<void> {
  if (caller === undefined || caller.is_operator) return;
  if (firstUngrantableSource(caller, [source]) === null) return;
  const claimed = (await storage.keys.list()).some(
    (key) => key.sources?.includes(source) === true,
  );
  if (!claimed) return;
  throw new MarfaError(
    ErrorCode.FORBIDDEN,
    `Another key claims the source "${source}" and this credential does not, so it cannot mint a key that writes under it as its own.`,
    { source },
  );
}

/**
 * Refuse an edit that widens a key an app made.
 *
 * A key minted through a sign-in carries the app that minted it, and the
 * consent screen's promise about that key is that it holds what the app held
 * and never more. The mint clamp is only half of keeping that promise: the
 * permission maps are writable through `PATCH` a moment later, and the person
 * who signed in can reach that door with their own credential. Without this,
 * "an app cannot make a key wider than itself" means "an app cannot make a
 * key wider than itself in one step".
 *
 * **Absolute, with no exemption for the operator key.** Every other ceiling
 * here measures a caller against what the caller holds, so the operator key
 * falls outside it by having nothing to measure. This one is a property of
 * the key rather than of whoever is editing it: the guarantee is worth
 * something to a person reading the consent screen only if there is no
 * credential anywhere that can quietly lift it. Narrowing stays open to
 * everyone, because the promise is a ceiling and not a fixed shape.
 *
 * The key's own current set is the ceiling, so the comparison is the one the
 * mint already makes, with `existing` in the creator's place — which is only
 * true because that comparison is a map against a map. Measuring the ceiling
 * by the literals it confers loses every `none` entry, and a `none` on the
 * holding side is a denial rather than an absence; `mint-clamp.ts` carries
 * the reasoning.
 */
function refuseWideningAnAppsKey(
  existing: ApiKey,
  requested: RequestedReach,
  requestedPermissions: Permission[] | undefined,
  requestedSources: readonly string[] | undefined,
): void {
  if (existing.oauth_client_id === undefined) return;

  const fixed =
    "This key was created by an app, so it holds what that app held and is never widened afterwards.";

  const namespace = firstUncoveredExtension(
    existing.extension_permissions,
    requested.extension_permissions,
  );
  if (namespace !== null) {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      `${fixed} It does not hold the ${namespace} extension namespace. Narrow it, or create a key of your own.`,
    );
  }

  const uncovered = firstReachBeyondCredential(existing, requested);
  if (uncovered !== null) {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      `${fixed} It does not hold ${uncovered}. Narrow it, or create a key of your own.`,
      { required_scope: uncovered },
    );
  }

  const held = existing.permissions ?? [];
  const beyond = requestedPermissions?.find((p) => !held.includes(p));
  if (beyond !== undefined) {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      `${fixed} It does not hold ${beyond}. Narrow it, or create a key of your own.`,
      { required_scope: beyond },
    );
  }

  const unclaimed = firstUngrantableSource(existing, requestedSources);
  if (unclaimed !== null) {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      `${fixed} It does not claim the source "${unclaimed}". Narrow it, or create a key of your own.`,
      { source: unclaimed },
    );
  }
}

/**
 * Run the bootstrap mint, and give the sentinel back only if nothing was
 * minted.
 *
 * `settings.claim` is atomic and one-shot, which is what keeps two concurrent
 * unauthenticated mints from both succeeding. It is also the only thing
 * telling `authMiddleware` to stop admitting an unauthenticated `POST /keys`,
 * and nothing else clears it, so a claim followed by a failure left standing
 * would be an instance with no credential and no route that could make one.
 *
 * **The release is conditional, and the condition is the whole safety of it.**
 * Releasing on any failure would reopen unauthenticated minting on an
 * instance that already has an operator key — a stranger who won the reopened
 * window would hold one, and an operator key mints a working key through
 * `POST /keys`, which is deliberately unclamped and hands out the whole
 * instance. That is a takeover, where the problem being solved was only a
 * lockout. So the window reopens exactly when there is no
 * credential to protect, which is the state the middleware's own gate is
 * about.
 *
 * The check is a read of the key table rather than a flag, because a throw
 * carries no reliable account of what committed before it.
 *
 * A failure to release is swallowed. It leaves the claim standing, which is
 * where a failure with no release would leave it, and replacing the caller's
 * error with a cleanup's would hide what actually went wrong.
 *
 * A non-bootstrap call passes straight through, because there is no claim to
 * give back.
 */
async function withBootstrapRelease<T>(
  isBootstrap: boolean,
  storage: Storage,
  mint: () => Promise<T>,
): Promise<T> {
  if (!isBootstrap) return await mint();
  try {
    return await mint();
  } catch (error) {
    try {
      const minted = await storage.keys.list();
      if (minted.length === 0) {
        await storage.settings.release("bootstrapped");
      }
    } catch (releaseFailure) {
      log("error", "bootstrap claim could not be released", {
        error:
          releaseFailure instanceof Error
            ? releaseFailure.message
            : String(releaseFailure),
      });
    }
    throw error;
  }
}

/** Everything, in the wildcard form, on one content family. */
const EVERY_TYPE = { "*": "write" } as const;

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
      // `keys.mint` says a credential may mint; the clamp below says how far
      // what it mints may reach. The two are separate on purpose, and
      // removing one without the other opens an escalation; see
      // `auth/mint-clamp.ts`.
      requireKeysMintOrOperator(c);
    }

    const body = c.req.valid("json");

    // **The one unauthenticated write in the product is bound to the host.**
    // A fresh instance prints a one-time secret to its own boot log, and this
    // mint has to present it as a bearer token. Reading that log is proof of
    // running the instance, which is the only claim available before any
    // credential exists — and without it the door stands open to whoever
    // reaches the port first during the window between `up` and the operator's
    // first call.
    //
    // **Checked before the claim**: the claim is one-shot and irreversible, so
    // a request that can never mint must not consume it. A wrong secret would
    // otherwise lock a fresh instance out of bootstrap for good.
    //
    // The middleware reads no `Authorization` header on this path, so the
    // whole header is available here and the secret arrives the way every
    // later credential will.
    if (isBootstrap) {
      const presented = (c.req.header("authorization") ?? "").replace(
        /^Bearer\s+/i,
        "",
      );
      const stored = await storage.settings.get(BOOTSTRAP_SECRET_KEY);
      if (!bootstrapSecretMatches(stored, presented)) {
        throw new MarfaError(
          ErrorCode.UNAUTHORIZED,
          "The first key is minted with the one-time secret this server printed to its log at startup. Present it as a bearer token.",
        );
      }
    }

    // Under bootstrap, atomically claim the sentinel BEFORE minting. Two
    // concurrent unauthenticated POST /keys against a fresh DB both pass
    // the middleware gate (which reads the sentinel non-atomically); only
    // the caller whose INSERT-ON-CONFLICT-DO-NOTHING returns a row gets to
    // mint. Everyone else is refused 401 here.
    if (isBootstrap) {
      const claimed = await storage.settings.claim("bootstrapped", "true");
      if (!claimed) {
        throw new MarfaError(ErrorCode.UNAUTHORIZED, "Authentication required");
      }
    }

    // **Everything after the claim runs where a failure can be given back.**
    // The claim has to come first or two concurrent callers both mint, but it
    // is also what tells the middleware to stop admitting an unauthenticated
    // mint. A throw between the two — a failed insert, a provisioning error,
    // a dropped connection — would otherwise leave a sentinel with no operator
    // key behind it, which is an instance nobody can reach and no route can
    // repair. Releasing on the way out makes the attempt retryable, so a
    // transient failure costs a retry rather than the instance.
    //
    // **The secret is spent inside that window, not before it.** Spending it
    // beside the claim would survive the release and take the retry with it:
    // the sentinel would be back, and the secret the caller has to present is
    // gone, so the instance is no more reachable than before. Spent after the
    // key exists, the two agree — either both stand, or neither has moved.
    return await withBootstrapRelease(isBootstrap, storage, async () => {
      assertUnreservedSource(body.source);
      // Once, so a claim named twice is stored once and every ceiling below
      // reads the list the row will hold.
      const requestedSources =
        body.sources === undefined ? undefined : [...new Set(body.sources)];
      assertUnreservedSources(requestedSources);

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

      // **The operator key seeds working keys and mints its own kind.** It
      // holds nothing itself, so nothing about it can be a ceiling: a working
      // key it mints holds what the body names, or the whole set when the
      // body names nothing, because an operator's first credential having
      // to be narrowed upward is the wrong default. A body naming
      // `is_operator: true` produces a second operator key, which holds
      // nothing, so naming any reach on one is refused below.
      const callerIsOperator =
        isBootstrap || c.get("apiKey")?.is_operator === true;
      if (!callerIsOperator && body.is_operator === true) {
        throw new MarfaError(
          ErrorCode.FORBIDDEN,
          "Only an operator key can mint another. Running the instance sits outside the permission model, so nothing in a permission set reaches it.",
        );
      }
      const mintsOperatorKey = isBootstrap || body.is_operator === true;
      const seedsFromOperator =
        !isBootstrap && callerIsOperator && !mintsOperatorKey;

      // **The creator is the ceiling.** A body naming no reach takes the whole
      // of it, and anything named beyond it is refused — which together mean
      // a key can be narrowed at the moment of minting and can never be
      // widened by one.
      //
      // The bootstrap key takes nothing, because it is the operator key: the
      // instance tier is fenced outside the model rather than expressed as a
      // full set inside it.
      // One declaration of what the body asks for, read by all three
      // ceilings below. A sixth permission family added to only one of them
      // would fail open in whichever was missed.
      const requested = {
        type_permissions: body.type_permissions,
        edge_permissions: body.edge_permissions,
        metadata_permissions: body.metadata_permissions,
        extension_permissions: body.extension_permissions,
        profile_permissions: body.profile_permissions,
      };
      const callerHeldPermissions: Permission[] = isBootstrap
        ? []
        : mintingFromSession
          ? (c.get("oauthGrant")?.scopes ?? []).filter(isPermission)
          : (c.get("apiKey")?.permissions ?? []);
      const requestedPermissions = body.permissions?.filter(isPermission);

      // **An operator key holds nothing**, so a body naming reach for one is
      // refused. Asked ahead of the two ceilings below because it is the more
      // specific answer. Either would refuse a named permission first, with a
      // message implying that a creator holding it could pass it on, which
      // for this tier is exactly what is not true.
      if (!isBootstrap && mintsOperatorKey) {
        refuseReachOnAnOperatorKey(
          requested,
          requestedPermissions,
          requestedSources,
        );
      }
      // The key bootstrap mints is an operator key too, and a claim named on
      // it is refused as on any other rather than dropped. Inside the claim's
      // window, so the refusal gives the claim back and the secret still
      // mints.
      if (isBootstrap) {
        refuseReachOnAnOperatorKey({}, undefined, requestedSources);
      }

      // The operator key is not clamped, because its own set is empty and it
      // is the seed rather than the ceiling.
      if (requestedPermissions !== undefined && !callerIsOperator) {
        const beyond = requestedPermissions.find(
          (permission) => !callerHeldPermissions.includes(permission),
        );
        if (beyond !== undefined) {
          throw new MarfaError(
            ErrorCode.FORBIDDEN,
            `This credential does not hold ${beyond}, so it cannot give a key a permission it does not hold itself.`,
            { required_scope: beyond },
          );
        }
      }
      // **A body naming no reach at all takes the creator's whole set; a body
      // naming any family gets only what it named, holding no permission it did not name.** One
      // rule, and the second half of it is deliberate: naming a narrow type map
      // and receiving the creator's edges or its `keys.mint` for free would be a key wider than the request, which is
      // a different failure from a key wider than the creator and just as
      // unwanted. Asking all five families and the claims is what makes
      // "named nothing" unambiguous.
      //
      // Deriving is what stops the other shape — a credential holding every
      // permission and unable to read a row, which is what an empty default
      // produced. The operator key holds nothing to derive from, so a working
      // key it mints with a body naming nothing takes everything instead.
      const namesNoReach =
        body.type_permissions === undefined &&
        body.edge_permissions === undefined &&
        body.metadata_permissions === undefined &&
        body.extension_permissions === undefined &&
        body.profile_permissions === undefined &&
        requestedSources === undefined;
      // Forced empty for an operator mint: an operator key holds nothing on
      // any axis, which `api_keys_operator_holds_nothing` enforces on the
      // row, and the guard above measures only what the request named, so a
      // body naming nothing, which takes a creator's whole set, would
      // otherwise derive permissions the row may not hold.
      const permissions = mintsOperatorKey
        ? []
        : (requestedPermissions ??
          (!namesNoReach
            ? []
            : seedsFromOperator
              ? [...PERMISSIONS]
              : callerHeldPermissions));

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
      // A session reaches here with its synthetic key as `callerKey`, so it
      // is held to the same question as a key, against what its token
      // claims. Both ceilings exempt the operator key themselves, and a
      // missing `callerKey`, which is bootstrap, so every mint asks them.
      refuseSourcesAboveCaller(callerKey, requestedSources);
      await refuseOwnSourceClaimedElsewhere(storage, callerKey, body.source);

      const creator = !isBootstrap && namesNoReach ? callerKey : undefined;
      const seed = seedsFromOperator && namesNoReach ? EVERY_TYPE : undefined;
      // **An operator mint takes nothing on any axis, the content maps
      // included.** The permissions are already forced empty above;
      // leaving the five maps to the body would let an unauthenticated first
      // caller name `*: write` on every family and get an operator credential
      // holding it. There is no ceiling to clamp it against either, because
      // bootstrap has no creator.
      const holdsNothing = mintsOperatorKey;
      const typePermissions = holdsNothing
        ? {}
        : (seed ?? creator?.type_permissions ?? body.type_permissions ?? {});
      const edgePermissions = holdsNothing
        ? {}
        : (seed ?? creator?.edge_permissions ?? body.edge_permissions ?? {});
      const metadataPermissions = holdsNothing
        ? {}
        : (seed ??
          creator?.metadata_permissions ??
          body.metadata_permissions ??
          {});
      const profilePermissions = holdsNothing
        ? {}
        : (seed ??
          creator?.profile_permissions ??
          body.profile_permissions ??
          {});
      const extensionPermissions = holdsNothing
        ? {}
        : (seed ??
          creator?.extension_permissions ??
          body.extension_permissions ??
          {});
      // No seed here: the operator claims nothing and there is no wildcard
      // source, so a working key it mints naming nothing claims nothing
      // either, and a claim is always one somebody named.
      const sources = holdsNothing
        ? []
        : (creator?.sources ?? requestedSources ?? []);

      const rawKey = generateRawKey();
      const keyHash = hashApiKey(rawKey, salt);

      // Resolved ahead of the write, so nothing between the insert and the
      // response can fail and take the plaintext with it.
      const grantItemId = await resolveGrantItemId(storage, c);

      const stored = await storage.keys.create(
        {
          label: body.label.trim(),
          source: body.source,
          sources,
          default_tier: body.default_tier,
          is_operator: mintsOperatorKey,
          permissions,
          type_permissions: typePermissions,
          extension_permissions: extensionPermissions,
          edge_permissions: edgePermissions,
          metadata_permissions: metadataPermissions,
          profile_permissions: profilePermissions,
          // Documented as the credential's own levers, and taken as sent: a
          // lever set here wins over the instance config for this key.
          enforcement_override: body.enforcement_override,
          // Set from who is minting, never from the body. A key an app made
          // belongs to that app: the keys page groups it there, and revoking the
          // app offers to revoke it.
          oauth_client_id: mintingFromSession
            ? c.get("oauthGrant")?.clientId
            : undefined,
        },
        keyHash,
      );

      // The audit row records the tier so every operator credential can be
      // enumerated later. Derived from the stored row rather than from the
      // request, so the trail stays accurate whatever the deployment shape.
      const operatorTierMint = stored.is_operator;

      void storage.audit.log({
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: isBootstrap ? "key.bootstrap" : "key.create",
        resource_type: "key",
        resource_id: stored.id,
        details: mintDetails(c, operatorTierMint, grantItemId),
      });

      // The key row exists, so the secret has done its job and is spent.
      // Ordered here rather than beside the claim because a failure before
      // this point releases the claim, and a released claim with a spent
      // secret is not a retry — it is the same lockout with an extra step.
      if (isBootstrap) {
        await consumeBootstrapSecret(storage);
      }

      return c.json(
        {
          id: stored.id,
          key: rawKey,
          label: stored.label,
          source: stored.source,
          sources: stored.sources,
          default_tier: stored.default_tier,
          is_operator: stored.is_operator,
          permissions: stored.permissions,
          oauth_client_id: stored.oauth_client_id,
          type_permissions: stored.type_permissions,
          extension_permissions: stored.extension_permissions,
          edge_permissions: stored.edge_permissions,
          metadata_permissions: stored.metadata_permissions,
          profile_permissions: stored.profile_permissions,
          enforcement_override: stored.enforcement_override,
          created_at: stored.created_at,
          last_used_at: stored.last_used_at,
        },
        201,
      );
    });
  });

  router.openapi(listKeysRoute, async (c) => {
    requireAuth(c);
    requireKeysMintOrOperator(c);
    const keys = await storage.keys.list();
    return c.json({ data: keys, next_cursor: null }, 200);
  });

  router.openapi(currentKeyRoute, (c) => {
    const key = requireAuth(c);
    if (c.get("authType") === "oauth") {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        "This credential is a signed-in app's token, not a key; its reach is its grant.",
      );
    }
    // The row the bearer check read, which carries no hash and no
    // revocation. It is read before this request's use is stamped, so its
    // `last_used_at` can trail the listing's by that one stamp.
    return c.json(key, 200);
  });

  router.openapi(revokeKeyRoute, async (c) => {
    requireAuth(c);
    requireKeysMintOrOperator(c);
    const { id } = c.req.valid("param");

    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid key ID");
    }

    // **The answer is what happened, not what was asked for.** A door told ok
    // whatever the store did would answer a revoke of the wrong id as a
    // success, and the key meant would stay live with nothing saying so.
    const outcome = await storage.keys.revoke(id);
    if (outcome !== "revoked") {
      throw new MarfaError(
        ErrorCode.API_KEY_NOT_FOUND,
        outcome === "already_revoked"
          ? `Key ${id} was already revoked`
          : `Key ${id} not found`,
      );
    }

    // Under the refusal, so the log records revocations rather than
    // attempts. An attempt that changed nothing is not an event in this
    // key's life, and a row saying otherwise is the same false report the
    // 200 was.
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: c.get("apiKey")?.id,
      action: "key.revoke",
      resource_type: "key",
      resource_id: id,
    });

    return c.json({ ok: true as const }, 200);
  });

  router.openapi(updateKeyRoute, async (c) => {
    const key = requireAuth(c);
    requireKeysMintOrOperator(c);
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

    const requestedSources =
      body.sources === undefined ? undefined : [...new Set(body.sources)];
    assertUnreservedSources(requestedSources);

    const existing = await storage.keys.get(id);
    if (!existing) {
      throw new MarfaError(ErrorCode.API_KEY_NOT_FOUND, `Key ${id} not found`);
    }

    // **The same ceiling as the mint, because this door reaches further.** A
    // clamp applied only at `POST` is not a clamp at all: the permission maps
    // are writable here a moment later, and this route addresses every key
    // rather than only the ones the session minted. So a
    // session refused a wide key at the mint could have widened an existing
    // one instead — including a key it did not create.
    //
    // Asked of every editor rather than only of a session, for the reason the
    // mint states: a key holding `keys.mint` and read on one type is an
    // ordinary credential, and nothing about holding the permission to
    // edit says how far what it edits may reach.
    const requestedReach = {
      type_permissions: body.type_permissions,
      edge_permissions: body.edge_permissions,
      metadata_permissions: body.metadata_permissions,
      extension_permissions: body.extension_permissions,
      profile_permissions: body.profile_permissions,
    };
    const requestedPermissions = body.permissions?.filter(isPermission);

    // Before the caller's own ceiling, because it is the more specific answer:
    // a caller who both lacks the reach and is editing an app's key is better
    // told that this key can never hold more than told what it does not hold.
    refuseWideningAnAppsKey(
      existing,
      requestedReach,
      requestedPermissions,
      requestedSources,
    );

    if (c.get("authType") === "oauth") {
      refuseSessionReachAboveGrant(
        c.get("oauthGrant")?.scopes ?? [],
        requestedReach,
      );
    } else {
      refuseKeyReachAboveCreator(key, requestedReach);
    }
    refuseSourcesAboveCaller(key, requestedSources);

    // An operator row holds nothing, its own row included, which is the
    // shortest path there is from the instance tier to reach over everything.
    //
    // Refused where the body asks for something, and written empty where it
    // asks for nothing in a non-empty way: `nothingWhereNamed` carries which
    // bodies take the second path and why the row constraint is not the right
    // place to find out.
    const targetHoldsNothing = existing.is_operator;
    if (targetHoldsNothing) {
      refuseReachOnAnOperatorKey(
        requestedReach,
        requestedPermissions,
        requestedSources,
      );
    }
    const writtenReach = targetHoldsNothing
      ? nothingWhereNamed(requestedReach)
      : requestedReach;

    // **The permissions are clamped here too.** They are editable through
    // this door like any other family, so without it a key holding one
    // permission could give itself every other one in the set.
    if (requestedPermissions !== undefined && !key.is_operator) {
      const held = key.permissions ?? [];
      const beyond = requestedPermissions.find(
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
      // Needs no forcing on an operator row, for the reason the permissions
      // below need none: a claim is never a denial, so the guard above has
      // already refused any list but the empty one.
      sources: requestedSources,
      type_permissions: writtenReach.type_permissions,
      extension_permissions: writtenReach.extension_permissions,
      edge_permissions: writtenReach.edge_permissions,
      metadata_permissions: writtenReach.metadata_permissions,
      // The permissions need no forcing: the guard above refuses a
      // non-empty list outright, because no entry in one is a denial the way a
      // `none` map entry is, so the only list that reaches an operator row is
      // already the empty one.
      permissions: requestedPermissions,
      profile_permissions: writtenReach.profile_permissions,
      enforcement_override: body.enforcement_override,
    });

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
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
        sources: updated.sources,
        default_tier: updated.default_tier,
        is_operator: updated.is_operator,
        permissions: updated.permissions,
        oauth_client_id: updated.oauth_client_id,
        type_permissions: updated.type_permissions,
        extension_permissions: updated.extension_permissions,
        edge_permissions: updated.edge_permissions,
        metadata_permissions: updated.metadata_permissions,
        profile_permissions: updated.profile_permissions,
        enforcement_override: updated.enforcement_override,
        created_at: updated.created_at,
        // Sent here and not by the mint, because no key a door mints carries
        // one while any key is patchable, a stamped row included. A caller
        // updating a credential asked for the key, and when it stops working
        // is part of the key.
        expires_at: updated.expires_at,
        last_used_at: updated.last_used_at,
      },
      200,
    );
  });

  return router;
}
