import { maxStringLength } from "@withmarfa/shared";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
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
  firstUngrantableSource,
  refuseUnclampableExtensions,
  type RequestedReach,
} from "../auth/mint-clamp.js";
import { keysInReach } from "../auth/key-reach.js";
import {
  hashApiKey,
  isReservedCredentialSource,
  requireAuth,
  RESERVED_CREDENTIAL_SOURCE_PREFIXES,
  standingPermission,
  keysOnly,
} from "../middleware/auth.js";
import { log } from "../middleware/logger.js";
import {
  BOOTSTRAP_SECRET_KEY,
  bootstrapSecretMatches,
  consumeBootstrapSecret,
} from "../auth/bootstrap-secret.js";
import type { Storage, StoredApiKey } from "../storage/interface.js";
import {
  EnforcementOverrideSchema,
  KEY_FIELD_TEXT,
  KeyResponseSchema,
  nullableRef,
  PermissionEnum,
  PermissionLevelEnum,
  TierEnum,
  TypePermissionLevelEnum,
  wholeListOf,
} from "./_schemas.js";
import {
  createOpenAPIRouter,
  OkResponseSchema,
  makeErrorResponseSchema,
} from "../openapi.js";
import { errorMessage } from "../error-text.js";

const KEY_PREFIX = "marfa_k1_";

function generateRawKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("hex");
}

/**
 * Refuse a caller-supplied `source` under a reserved prefix.
 *
 * `source` is otherwise free text, but a reserved prefix is read elsewhere as
 * proof of an identity a caller cannot earn by naming it: see
 * `RESERVED_CREDENTIAL_SOURCE_PREFIXES`. Nothing legitimate is turned away
 * here, because no credential this route mints holds that shape.
 *
 * `POST /keys` writes `source` straight from the body.
 */
export function assertUnreservedSource(source: string): void {
  if (!isReservedCredentialSource(source)) return;
  throw new MarfaError(
    ErrorCode.VALIDATION_ERROR,
    `\`source\` may not start with ${RESERVED_CREDENTIAL_SOURCE_PREFIXES.map((p) => `"${p}"`).join(", ")} — a reserved prefix names an identity a credential cannot claim for itself.`,
  );
}

/**
 * Refuse a claim under a prefix no key may hold, for the reason
 * `assertUnreservedSource` refuses one as a key's own: a claimed source is
 * stamped on rows exactly as an own one is, so the reservation has to cover
 * both.
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

/** Every write naming a source and every read of the key walks the list. */
const MAX_CLAIMED_SOURCES = 1000;

/**
 * The sources a key claims besides its own, as the two writing doors take
 * them. Trimmed and bounded as `source` is, so a claim can be anything a
 * key's own source could be and a write names both the same way.
 */
const SourcesSchema = z
  .array(
    maxStringLength(
      z.string().trim().min(1, "a claimed source is not empty"),
      200,
    ),
  )
  .max(
    MAX_CLAIMED_SOURCES,
    `a key claims at most ${String(MAX_CLAIMED_SOURCES)} sources`,
  )
  .describe(
    "Sources the key may also write under, besides its own `source`. Several keys may claim one source, so their writes share natural keys. You can grant only your own `source` and the sources you claim; the operator key can grant any.",
  );

/** A stored key as every door that returns one returns it, plaintext aside. */
const ApiKeySchema = z
  .object({
    id: z.string().describe(KEY_FIELD_TEXT.id),
    label: z.string().describe(KEY_FIELD_TEXT.label),
    source: z.string().describe(KEY_FIELD_TEXT.source),
    sources: z.array(z.string()).describe(KEY_FIELD_TEXT.sources),
    permissions: z.array(PermissionEnum).describe(KEY_FIELD_TEXT.permissions),
    oauth_client_id: z
      .string()
      .optional()
      .describe(KEY_FIELD_TEXT.oauth_client_id),
    default_tier: TierEnum.describe(KEY_FIELD_TEXT.default_tier),
    is_operator: z.boolean().describe(KEY_FIELD_TEXT.is_operator),
    type_permissions: z
      .record(z.string(), TypePermissionLevelEnum)
      .describe(KEY_FIELD_TEXT.type_permissions),
    extension_permissions: z
      .record(z.string(), PermissionLevelEnum)
      .describe(KEY_FIELD_TEXT.extension_permissions),
    edge_permissions: z
      .record(z.string(), PermissionLevelEnum)
      .describe(KEY_FIELD_TEXT.edge_permissions),
    metadata_permissions: z
      .record(z.string(), PermissionLevelEnum)
      .describe(KEY_FIELD_TEXT.metadata_permissions),
    // Declared because the handler sends them: a listing returns stored rows
    // whole, so a field a row can carry and the declaration omits is a field
    // a generated client cannot read.
    profile_permissions: z
      .record(z.string(), PermissionLevelEnum)
      .describe(KEY_FIELD_TEXT.profile_permissions),
    enforcement_override: EnforcementOverrideSchema.describe(
      KEY_FIELD_TEXT.enforcement_override,
    ).optional(),
    created_at: z.string().describe(KEY_FIELD_TEXT.created_at),
    expires_at: z
      .string()
      .nullable()
      .describe(
        "When the key stops working, in UTC, or `null` if it doesn't expire. A key created through the API never expires.",
      ),
    last_used_at: z.string().nullable().describe(KEY_FIELD_TEXT.last_used_at),
  })
  .describe(
    "An API key, without its plaintext: what it may reach and when it was used.",
  )
  .openapi("ApiKey");

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

/**
 * **The operator key reaches these doors by being the operator key**, and holds
 * no permission to be checked. Key management is instance-tier work when
 * the operator does it — it mints the credential an instance works through —
 * so asking a permission of it would be asking the wrong question, and
 * the only answer it could ever give is no, because running the instance is
 * deliberately not expressible as a permission.
 *
 * Everything else is held to `keys.mint`. A session may mint too, if it was
 * granted the permission to, and the key it asks for does not reach past the
 * session's own grant: holding `keys.mint` says a credential may mint, and the
 * clamp in the mint says how far what it mints may reach. The two are separate
 * on purpose, and removing one without the other opens an escalation; see
 * `auth/mint-clamp.ts`.
 */
const keyDoors = standingPermission("keys.mint", { operatorToo: true });

const KEYS_MINT_REFUSAL =
  "- `forbidden`: you don't hold `keys.mint` and aren't the operator key. `details.required_scope` names it.";

const KEY_NOT_FOUND =
  "- `api_key_not_found`: no key you could have created has this ID, or the key is revoked or past its `expires_at`.";

const createKeyRoute = createRoute({
  operationId: "createKey",
  method: "post",
  path: "/",
  tags: ["Access"],
  summary: "Create an API key",
  description:
    "Creates an API key and returns it with its plaintext `key`, shown only here. If the body names none of `permissions`, the five permission maps and `sources`, the key gets everything you hold; if it names any, the key holds only what it names.",
  security: [{ bearerAuth: [] }],
  middleware: keyDoors,
  request: {
    // Strict, and that is load-bearing rather than tidiness. A field this
    // body does not declare is stripped by an ordinary object, and a body
    // naming no family does not mean "none": it means the creator's whole
    // set, or every permission when the operator seeds. So a caller spelling
    // the one field it names wrong asks to narrow and is answered with a
    // credential wider than the one it asked for, which on a mint hands on
    // the power to mint again.
    body: {
      content: {
        "application/json": {
          schema: z.strictObject({
            label: z
              .string()
              .min(1, "label is required")
              .describe(KEY_FIELD_TEXT.label),
            // Trimmed before it is measured, so a source of spaces is refused
            // here rather than stored empty, where the natural-key lookup
            // reads it as no source at all and a repeated create collides.
            source: maxStringLength(
              z.string().trim().min(1, "source is required"),
              200,
            ).describe(
              "The key's own source, stamped on the rows it writes unless a write names a source it claims. No other unrevoked key may have it as its own, and it can't change later.",
            ),
            sources: SourcesSchema.optional(),
            permissions: z
              .array(PermissionEnum)
              .optional()
              .describe(
                "The permissions to give the key, such as `audit.read`.",
              ),
            default_tier: TierEnum.optional().describe(
              `${KEY_FIELD_TEXT.default_tier} Leave it out for \`library\`.`,
            ),
            is_operator: z
              .boolean()
              .optional()
              .describe(
                "`true` to create another operator key, which holds no permissions, maps or claimed sources. Only the operator key can create one.",
              ),
            type_permissions: z
              .record(z.string(), TypePermissionLevelEnum)
              .optional()
              .describe(KEY_FIELD_TEXT.type_permissions),
            extension_permissions: z
              .record(z.string(), PermissionLevelEnum)
              .optional()
              .describe(KEY_FIELD_TEXT.extension_permissions),
            edge_permissions: z
              .record(z.string(), PermissionLevelEnum)
              .optional()
              .describe(KEY_FIELD_TEXT.edge_permissions),
            metadata_permissions: z
              .record(z.string(), PermissionLevelEnum)
              .optional()
              .describe(KEY_FIELD_TEXT.metadata_permissions),
            profile_permissions: z
              .record(z.string(), PermissionLevelEnum)
              .optional()
              .describe(KEY_FIELD_TEXT.profile_permissions),
            enforcement_override: EnforcementOverrideSchema.describe(
              "Enforcement levers for this key alone. Leave it out for none, so the key follows the instance's.",
            ).optional(),
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
      description:
        "Returns the new key with its plaintext `key`. When the operator key creates an ordinary key from a body naming no permission, map or `sources`, the key holds every permission and `*: write` on every map, and claims no source. On a new instance, the first request sends the one-time secret from the server's startup log as its bearer token, and returns the operator key, which reads no items.",
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
        "- `missing_required_field`: `label` or `source` is missing, or a lever in `enforcement_override` lacks `types` or `sources`.\n- `validation_error`: a field is invalid, such as a permission level that doesn't exist or more than 1,000 `sources`, or `source` or a claimed source starts with `oauth:`.",
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
        "- `forbidden`: you don't hold `keys.mint` and aren't the operator key; the body names a permission, map entry or source you don't hold, or a `source` another key claims that you can't grant; it gives an operator key any reach; or it asks for an operator key and you aren't one. `details.required_scope` or `details.source` names what you lack.",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["conflict"]),
        },
      },
      description:
        "- `conflict`: another unrevoked key already has this `source` as its own. `details.source` names it. To let two keys write under one source, claim it in `sources` instead.",
    },
  },
});

const listKeysRoute = createRoute({
  operationId: "listKeys",
  method: "get",
  path: "/",
  tags: ["Access"],
  summary: "List API keys",
  description:
    "Returns the API keys you could have created, your own included, without their plaintext. The operator key gets every key. Requires `keys.mint` or the operator key.",
  security: [{ bearerAuth: [] }],
  middleware: keyDoors,
  responses: {
    200: {
      content: {
        "application/json": {
          schema: wholeListOf(ApiKeySchema, "ApiKeyPage", "key you can reach"),
        },
      },
      description:
        "Returns the keys, in one page. A revoked key, or one past its `expires_at`, isn't listed.",
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
      description: KEYS_MINT_REFUSAL,
    },
  },
});

const currentKeyRoute = createRoute({
  operationId: "getCurrentKey",
  method: "get",
  path: "/current",
  tags: ["Access"],
  summary: "Get the current key",
  description:
    "Returns the key that sends the request, without its plaintext. Any key can read itself, whatever it holds, so a process can check what it was given.",
  security: [{ bearerAuth: [] }],
  middleware: keysOnly,
  responses: {
    200: {
      content: { "application/json": { schema: ApiKeySchema } },
      description: "Returns your key.",
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
        "- `forbidden`: your credential is a signed-in app's token, not a key.",
    },
  },
});

const revokeKeyRoute = createRoute({
  operationId: "revokeKey",
  method: "delete",
  path: "/{id}",
  tags: ["Access"],
  summary: "Revoke an API key",
  description:
    "Revokes an API key at once: Marfa stops accepting it, ends its open event streams and stops its queued bulk actions. You can revoke any key you could have created, your own included. Requires `keys.mint` or the operator key.",
  security: [{ bearerAuth: [] }],
  middleware: keyDoors,
  request: {
    params: z.object({
      id: z.string().describe("The ID of the key."),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: OkResponseSchema,
        },
      },
      description: "Returns `ok: true`.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "- `validation_error`: `id` isn't a valid key ID.",
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
      description: KEYS_MINT_REFUSAL,
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["api_key_not_found"]),
        },
      },
      description: `${KEY_NOT_FOUND} The operator key's message says when the key was already revoked.`,
    },
  },
});

// `source` is declared, and immutable. It is listed here rather than left
// out so the handler refuses a body naming it with a readable error rather
// than the strict object's generic "unrecognized keys"; a caller is told
// which field it may not change.
const UpdateKeyBodySchema = z.strictObject({
  label: z.string().min(1).optional().describe(KEY_FIELD_TEXT.label),
  default_tier: TierEnum.optional().describe(KEY_FIELD_TEXT.default_tier),
  sources: SourcesSchema.optional(),
  type_permissions: z
    .record(z.string(), TypePermissionLevelEnum)
    .optional()
    .describe(KEY_FIELD_TEXT.type_permissions),
  extension_permissions: z
    .record(z.string(), PermissionLevelEnum)
    .optional()
    .describe(KEY_FIELD_TEXT.extension_permissions),
  edge_permissions: z
    .record(z.string(), PermissionLevelEnum)
    .optional()
    .describe(KEY_FIELD_TEXT.edge_permissions),
  metadata_permissions: z
    .record(z.string(), PermissionLevelEnum)
    .optional()
    .describe(KEY_FIELD_TEXT.metadata_permissions),
  profile_permissions: z
    .record(z.string(), PermissionLevelEnum)
    .optional()
    .describe(KEY_FIELD_TEXT.profile_permissions),
  permissions: z
    .array(PermissionEnum)
    .optional()
    .describe("The permissions the key holds, such as `audit.read`."),
  enforcement_override: nullableRef(EnforcementOverrideSchema)
    .optional()
    .describe(
      "Replaces the key's enforcement levers whole. `null` clears them.",
    ),
  source: z
    .string()
    .optional()
    .describe(
      "Can't change. To give a key another source, create a new key and revoke this one.",
    ),
});

const updateKeyRoute = createRoute({
  operationId: "updateKey",
  method: "patch",
  path: "/{id}",
  tags: ["Access"],
  summary: "Update an API key",
  description:
    "Updates a key's label, default tier, permissions, maps, claimed `sources` or enforcement levers, and returns it. Each field you send replaces its old value, and a field you leave out stays. Requires `keys.mint` or the operator key.",
  security: [{ bearerAuth: [] }],
  middleware: keyDoors,
  request: {
    params: z.object({
      id: z.string().describe("The ID of the key."),
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
      description: "Returns the updated key.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description:
        "- `validation_error`: `id` isn't a valid key ID, the body carries `source`, or a field is invalid, such as a lever in `enforcement_override` without `types` or `sources`, or a claimed source that starts with `oauth:`.",
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
        "- `forbidden`: you don't hold `keys.mint` and aren't the operator key; the body gives the key a permission, map entry or source you don't hold; it gives an operator key any reach; or it widens a key an app created, which only narrows. `details.required_scope` or `details.source` names what's missing.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["api_key_not_found"]),
        },
      },
      description: KEY_NOT_FOUND,
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
      error: errorMessage(err),
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
 * where it was — and `PATCH` reaches every key within the grant, not only
 * the ones this session minted.
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
 * A claimant is beyond this caller's reach for the same reason, since it
 * claims a source the caller could not grant, so the caller cannot clear the
 * claimants first either; the operator key can. This is also the request a
 * device enrolled with its folder's source as its own would make by mistake.
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
  const claimed = (await storage.keys.list()).some((key) =>
    key.sources.includes(source),
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

/** Everything, in the wildcard form, on one content family. */
const EVERY_TYPE = { "*": "write" } as const;

// Router
// ---------------------------------------------------------------------------

export function keyRoutes(storage: Storage, salt: string) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(createKeyRoute, async (c) => {
    const isBootstrap = c.get("isBootstrap");

    const body = c.req.valid("json");

    // **The one unauthenticated write in the product is bound to the host.**
    // A fresh instance prints a one-time secret to its own boot log, and this
    // mint has to present it as a bearer token. Reading that log is proof of
    // running the instance, which is the only claim available before any
    // credential exists — and without it the door stands open to whoever
    // reaches the port first during the window between `up` and the operator's
    // first call.
    //
    // Check before preparing the mint. The claim is later committed together
    // with the key, consumed secret and audit, or all four roll back.
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

    // **The creator is the ceiling.** A body naming no family takes the whole
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
    // it is refused as on any other rather than dropped. This validation
    // precedes the claim, so the secret remains usable after refusal.
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
    // **A body naming no family at all takes the creator's whole set; a body
    // naming any family gets only what it named, holding nothing in the
    // families it left out.** One rule, and the second half of it is
    // deliberate: naming a narrow type map and receiving the creator's edges
    // or its `keys.mint` for free, or naming `audit.read` and receiving the
    // creator's maps, would be a key wider than the request, which is a
    // different failure from a key wider than the creator and just as
    // unwanted. The families are `permissions`, the five maps and the claims,
    // and asking all of them is what makes "named nothing" unambiguous.
    //
    // Deriving is what stops the other shape — a credential holding every
    // permission and unable to read a row, which is what an empty default
    // produced. The operator key holds nothing to derive from, so a working
    // key it mints with a body naming nothing takes everything instead.
    const namesNoFamily =
      body.permissions === undefined &&
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
        (!namesNoFamily
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

    const creator = !isBootstrap && namesNoFamily ? callerKey : undefined;
    const seed = seedsFromOperator && namesNoFamily ? EVERY_TYPE : undefined;
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

    const minted = await runAuditedTransaction(
      storage,
      async () => {
        // Claim, credential, secret consumption and audit are one unit. A
        // refusal rolls them all back; an uncertain commit never reopens minting.
        if (
          isBootstrap &&
          !(await storage.settings.claim("bootstrapped", "true"))
        ) {
          throw new MarfaError(
            ErrorCode.UNAUTHORIZED,
            "Authentication required",
          );
        }
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

        if (isBootstrap) await consumeBootstrapSecret(storage);
        return {
          stored,
          response: c.json(
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
          ),
        };
      },
      ({ stored }) => ({
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: isBootstrap ? "key.bootstrap" : "key.create",
        resource_type: "key",
        resource_id: stored.id,
        details: mintDetails(c, stored.is_operator, grantItemId),
      }),
    );
    return minted.response;
  });

  router.openapi(listKeysRoute, async (c) => {
    const keys = await keysInReach(storage, c).list();
    return c.json({ data: keys, next_cursor: null }, 200);
  });

  router.openapi(currentKeyRoute, (c) => {
    const key = requireAuth(c);
    // The row the bearer check read, which carries no hash and no
    // revocation. It is read before this request's use is stamped, so its
    // `last_used_at` can trail the listing's by that one stamp. With the
    // signed-in app refused above, the principal is that stored row, which
    // the context's type cannot say.
    return c.json(key as StoredApiKey, 200);
  });

  router.openapi(revokeKeyRoute, async (c) => {
    const { id } = c.req.valid("param");

    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid key ID");
    }

    // **The answer is what happened, not what was asked for.** A door told ok
    // whatever the store did would answer a revoke of the wrong id as a
    // success, and the key meant would stay live with nothing saying so.
    await runAuditedTransaction(
      storage,
      () => keysInReach(storage, c).revoke(id),
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: "key.revoke",
        resource_type: "key",
        resource_id: id,
      },
    );

    return c.json({ ok: true as const }, 200);
  });

  router.openapi(updateKeyRoute, async (c) => {
    const key = requireAuth(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid key ID");
    }

    if ("source" in body) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "`source` is immutable after creation; it is baked into item provenance. Revoke and issue a new key instead.",
      );
    }

    const requestedSources =
      body.sources === undefined ? undefined : [...new Set(body.sources)];
    assertUnreservedSources(requestedSources);

    // Measured, decided and written under one lock, so the reach and the
    // refusals below see the row the write lands on.
    const updated = await runAuditedTransaction(
      storage,
      () =>
        keysInReach(storage, c).change(id, (existing) => {
          // **The same ceiling as the mint, because this door reaches further.** A
          // clamp applied only at `POST` is not a clamp at all: the permission maps
          // are writable here a moment later, and this route addresses every key
          // within the caller's reach rather than only the ones it minted. So a
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

          return {
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
          };
        }),
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: "key.update",
        resource_type: "key",
        resource_id: id,
        details: {
          fields: Object.keys(body).filter((k) => k !== "source"),
        },
      },
    );

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
