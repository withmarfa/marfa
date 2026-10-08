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
  isDirectAuthority,
  holdsPermission,
  requirePermission,
  requireRecentOwnerAuthentication,
  standingRule,
  authorityId,
} from "../middleware/auth.js";
import { log } from "../middleware/logger.js";
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

const keySecurity: Record<string, string[]>[] = [
  { bearerAuth: [] },
  { ownerSession: [] },
];

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
    "Sources the key may also write under, besides its own `source`. Several keys may claim one source, so their writes share natural keys. You can grant only your own `source` and the sources you claim; the owner or local command can grant any.",
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

const mintDoor = standingPermission("keys.mint");
const keyDoors = standingRule("keys.manage or keys.mint", (c) => {
  requirePermission(
    c,
    holdsPermission(c, "keys.manage") ? "keys.manage" : "keys.mint",
  );
});

const KEYS_MINT_REFUSAL =
  "- `forbidden`: this operation requires its explicit permission or direct owner or local authority. `details.required_scope` names it.";

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
  security: keySecurity,
  middleware: mintDoor,
  request: {
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
        "Returns the new key with its plaintext `key`. When the owner or local command creates an ordinary key from a body naming no permission, map or `sources`, the key holds every permission and `*: write` on every map, and claims no source.",
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
        "- `forbidden`: you don't hold `keys.mint` and aren't the owner or local command; the body names a permission, map entry or source you don't hold, or a `source` another key claims that you can't grant. `details.required_scope` or `details.source` names what you lack.",
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
    "Returns key metadata without plaintext. `keys.manage` and direct owner or local authority list all keys; `keys.mint` lists keys within the caller's current reach. Requires `keys.mint`, `keys.manage`, or direct owner or local authority.",
  security: keySecurity,
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
    "Revokes an API key at once: Marfa stops accepting it, ends its open event streams and stops its queued bulk actions. `keys.manage` and direct owner or local authority can revoke any key. A caller with only `keys.mint` can revoke keys within its current reach. Requires `keys.mint`, `keys.manage`, or direct owner or local authority.",
  security: keySecurity,
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
      description: `${KEY_NOT_FOUND} The owner or local command's message says when the key was already revoked.`,
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
    "Updates a key's label, default tier, permissions, maps, claimed `sources` or enforcement levers, and returns it. Each field you send replaces its old value, and a field you leave out stays. Requires `keys.mint`, `keys.manage`, or direct owner or local authority.",
  security: keySecurity,
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
          schema: makeErrorResponseSchema([
            "missing_required_field",
            "validation_error",
          ]),
        },
      },
      description:
        "- `missing_required_field`: a lever in `enforcement_override` lacks `types` or `sources`.\n- `validation_error`: `id` isn't a valid key ID, the body carries `source`, or a field is invalid, such as a claimed source that starts with `oauth:`.",
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
        "- `forbidden`: you don't hold `keys.mint` and aren't the owner or local command; the body gives the key a permission, map entry or source you don't hold; or it widens a key an app created, which only narrows. `details.required_scope` or `details.source` names what's missing.",
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
    log("warn", "keys: grant projection lookup failed for a key.create row", {
      error: errorMessage(err),
    });
    return null;
  }
}

function mintDetails(
  c: Context<AppEnv>,
  grantItemId: string | null,
): Record<string, unknown> {
  const grant = c.get("oauthGrant");
  return {
    actor: authorityId(c),
    ...(grant
      ? {
          client_id: grant.clientId,
          user_id: grant.authUserId,
          grant_item_id: grantItemId,
        }
      : {}),
    ...(c.get("apiKey")?.oauth_client_id
      ? { client_id: c.get("apiKey")?.oauth_client_id }
      : {}),
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

function refuseKeyReachAboveCreator(
  creator: ApiKey,
  requested: RequestedReach,
): void {
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

function refuseSourcesAboveCaller(
  caller: ApiKey | undefined,
  requested: readonly string[] | undefined,
): void {
  if (caller === undefined) return;
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
 * claimants first either; the owner or local command can. This is also the request a
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
  if (caller === undefined) return;
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
 * **Absolute, with no exemption for the owner or local command.** Every other ceiling
 * here measures a caller against what the caller holds, so the owner or local command
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
function refuseWideningKey(
  existing: ApiKey,
  requested: RequestedReach,
  requestedPermissions: Permission[] | undefined,
  requestedSources: readonly string[] | undefined,
): void {
  const fixed = "This key may only be narrowed by this operation.";

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
    const body = c.req.valid("json");
    assertUnreservedSource(body.source);
    const requestedSources =
      body.sources === undefined ? undefined : [...new Set(body.sources)];
    assertUnreservedSources(requestedSources);
    const rawKey = generateRawKey();
    const keyHash = hashApiKey(rawKey, salt);
    const grantItemId = await resolveGrantItemId(storage, c);
    const stored = await runAuditedTransaction(
      storage,
      async () => {
        // Resolve ceilings under the same writer lock as the new key.
        requirePermission(c, "keys.mint");
        if (body.enforcement_override !== undefined)
          requirePermission(c, "config.manage");
        const direct = isDirectAuthority(c);
        if (direct) requireRecentOwnerAuthentication(c);
        const callerKey = direct ? undefined : requireAuth(c);
        const callerGrant = c.get("oauthGrant");
        const fromApp = c.get("authType") === "oauth";
        const held = fromApp
          ? (callerGrant?.scopes ?? []).filter(isPermission)
          : (callerKey?.permissions ?? []);
        const requestedPermissions = body.permissions?.filter(isPermission);
        const requested = {
          type_permissions: body.type_permissions,
          edge_permissions: body.edge_permissions,
          metadata_permissions: body.metadata_permissions,
          extension_permissions: body.extension_permissions,
          profile_permissions: body.profile_permissions,
        };
        if (!direct) {
          if (fromApp)
            refuseSessionReachAboveGrant(callerGrant?.scopes ?? [], requested);
          else refuseKeyReachAboveCreator(requireAuth(c), requested);
          const beyond = requestedPermissions?.find(
            (permission) => !held.includes(permission),
          );
          if (beyond)
            throw new MarfaError(
              ErrorCode.FORBIDDEN,
              `This credential does not hold ${beyond}`,
              { required_scope: beyond },
            );
          refuseSourcesAboveCaller(callerKey, requestedSources);
          await refuseOwnSourceClaimedElsewhere(
            storage,
            callerKey,
            body.source,
          );
        }
        const namesNoFamily =
          body.permissions === undefined &&
          Object.values(requested).every((value) => value === undefined) &&
          requestedSources === undefined;
        const creator = namesNoFamily ? callerKey : undefined;
        const seed = direct && namesNoFamily ? EVERY_TYPE : undefined;
        return storage.keys.create(
          {
            label: body.label.trim(),
            source: body.source,
            sources: creator?.sources ?? requestedSources ?? [],
            default_tier: body.default_tier,
            permissions:
              requestedPermissions ??
              (namesNoFamily ? (direct ? [...PERMISSIONS] : held) : []),
            type_permissions:
              seed ?? creator?.type_permissions ?? body.type_permissions ?? {},
            edge_permissions:
              seed ?? creator?.edge_permissions ?? body.edge_permissions ?? {},
            metadata_permissions:
              seed ??
              creator?.metadata_permissions ??
              body.metadata_permissions ??
              {},
            profile_permissions:
              seed ??
              creator?.profile_permissions ??
              body.profile_permissions ??
              {},
            extension_permissions:
              seed ??
              creator?.extension_permissions ??
              body.extension_permissions ??
              {},
            enforcement_override: body.enforcement_override,
            oauth_client_id: fromApp
              ? callerGrant?.clientId
              : callerKey?.oauth_client_id,
          },
          keyHash,
        );
      },
      (key) => ({
        client_ip: c.get("clientIp") ?? null,
        key_id: authorityId(c),
        action: "key.create",
        resource_type: "key",
        resource_id: key.id,
        details: mintDetails(c, grantItemId),
      }),
    );
    return c.json(KeyResponseSchema.parse({ ...stored, key: rawKey }), 201);
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
        key_id: authorityId(c),
        action: "key.revoke",
        resource_type: "key",
        resource_id: id,
      },
    );

    return c.json({ ok: true as const }, 200);
  });

  router.openapi(updateKeyRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    if (!isValidId(id))
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid key ID");
    if ("source" in body)
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Source is immutable; revoke and issue a new key instead",
      );
    const sources =
      body.sources === undefined ? undefined : [...new Set(body.sources)];
    assertUnreservedSources(sources);
    const updated = await runAuditedTransaction(
      storage,
      () =>
        keysInReach(storage, c).change(id, (existing) => {
          if (body.enforcement_override !== undefined)
            requirePermission(c, "config.manage");
          const direct = isDirectAuthority(c);
          if (direct) requireRecentOwnerAuthentication(c);
          const manager = !direct && holdsPermission(c, "keys.manage");
          const requested = {
            type_permissions: body.type_permissions,
            edge_permissions: body.edge_permissions,
            metadata_permissions: body.metadata_permissions,
            extension_permissions: body.extension_permissions,
            profile_permissions: body.profile_permissions,
          };
          const permissions = body.permissions?.filter(isPermission);
          if (existing.oauth_client_id !== undefined || manager)
            refuseWideningKey(existing, requested, permissions, sources);
          if (manager) requirePermission(c, "keys.manage");
          else if (!direct) {
            const key = requireAuth(c);
            requirePermission(c, "keys.mint");
            if (c.get("authType") === "oauth")
              refuseSessionReachAboveGrant(
                c.get("oauthGrant")?.scopes ?? [],
                requested,
              );
            else refuseKeyReachAboveCreator(key, requested);
            refuseSourcesAboveCaller(key, sources);
            const held =
              c.get("authType") === "oauth"
                ? (c.get("oauthGrant")?.scopes ?? [])
                : (key.permissions ?? []);
            const beyond = permissions?.find((p) => !held.includes(p));
            if (beyond)
              throw new MarfaError(
                ErrorCode.FORBIDDEN,
                `This credential does not hold ${beyond}`,
                { required_scope: beyond },
              );
          }
          return {
            label: body.label,
            default_tier: body.default_tier,
            sources,
            ...requested,
            permissions,
            enforcement_override: body.enforcement_override,
          };
        }),
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: authorityId(c),
        action: "key.update",
        resource_type: "key",
        resource_id: id,
        details: { fields: Object.keys(body) },
      },
    );
    return c.json(updated, 200);
  });

  return router;
}
