import type { MetadataPermission, TypePermission } from "./types.js";
import { isValidTypePattern, resolveTypePermission } from "./validation.js";
import {
  GLOBAL_TYPE_WILDCARD,
  subtreeWildcardRoot,
  typeMatchesPattern,
} from "./type-patterns.js";

// ---------------------------------------------------------------------------
// Scope parsing
// ---------------------------------------------------------------------------

/**
 * Parsed representation of a scope string. Six shapes today:
 *   - item-type scope:  "core.note:read"     → kind="type", typePattern="core.note"
 *                       ("*:read" / "*:write" are the global type wildcard)
 *   - metadata scope:   "metadata:write"     → kind="metadata", subresource undefined
 *   - metadata sub:     "metadata.types:write" → kind="metadata", subresource="types"
 *   - edge scope:       "edge.parent-of:write" or "edge.*:write"
 *                       → kind="edge", edgeType="parent-of" or "*"
 *   - capability:       "capability.webhooks"
 *                       → kind="capability", capability=<literal>, no operation suffix
 *   - OIDC literal:     "openid" / "profile" / "email"
 *                       → kind="oidc", oidcScope=<literal>, no operation suffix
 *
 * Per-edge-type scopes surface fine-grained edge permissions through OAuth,
 * mirroring the `<type>:<verb>` shape used for item-type scopes. Metadata
 * sub-resource scopes (e.g. `metadata.types:write`) gate metadata-layer
 * mutations like type registration. OIDC literals carry no operation —
 * they're standard OAuth/OIDC scope strings whose only Marfa-side job is
 * to be recognized as valid so the consent route accepts them. Claim
 * gating happens in the OAuth provider's userinfo / id_token callbacks,
 * which read the grant's own scope list; parsing them here exists so they
 * never project into `type_permissions` / `edge_permissions` /
 * `metadata_permissions`.
 */
export type OidcScope = "openid" | "profile" | "email" | "offline_access";

// ---------------------------------------------------------------------------
// Capability scopes
// ---------------------------------------------------------------------------

/**
 * The reserved root every capability scope lives under. Reserved in
 * `RESERVED_ROOTS`, so `POST /types` refuses to register anything beneath
 * it and no publisher handle can claim the word — a capability literal and
 * an item-type identifier can never name the same thing.
 *
 * Reserving a root that names no type tier is deliberate and is the whole
 * point: the other five roots classify types, this one exists so that
 * nothing ever does.
 */
export const CAPABILITY_ROOT = "capability";

/**
 * Authority over one administrative surface, named and consented to rather
 * than inherited from a role.
 *
 * **Why a family of its own.** The four existing kinds each grant on a
 * resource axis the data plane already fences — an item type, an edge type,
 * a metadata sub-resource — and an administrative surface is none of those.
 * The two namespaces that read as though they would serve both fail for
 * concrete reasons rather than stylistic ones. `admin.*` is not reserved at
 * all — it is not a root, and type registration consults the roots — so a
 * real type could appear under it and a grant there would be ambiguous
 * between the two readings. `system.*` is worse: `system.connection`
 * is a live type with a live scope in the default read bundle, so a
 * capability beside it is indistinguishable from a type grant by inspection.
 *
 * **Why no verb.** A capability is one authority, not a read/write axis over
 * a resource: `capability.item_purge:read` names nothing, and admitting the
 * suffix would mean inventing a rule to refuse the halves that have no
 * meaning. Where a surface genuinely splits, the split is in the surface
 * name — `audit_read` grants reading the audit log and nothing writes it.
 * The consequence to know is that a capability literal carries no colon, so
 * anything deriving a verb by splitting on one sees a capability as
 * verb-less rather than as a read.
 *
 * **One per coherent surface, not one per route.** The list is what a
 * consent screen has to read as sentences — "manage your webhooks", "read
 * your audit log" — so a person can grant an app the one power it needs.
 * A single "administer everything" toggle is the thing this replaces.
 *
 * Six boundaries in the set are decisions rather than groupings, and each
 * exists because the obvious grouping would hand a holder something wider
 * than the name implies.
 *
 * - **`app_grants` is not `keys`.** The routes sit beside each other and the
 *   code calls them the same tier, which is exactly why they are split: a
 *   key is this app's own credential, and a grant is another app's access.
 *   Folding them together would let an app trusted to rotate a key
 *   enumerate and revoke every other app the space has authorized, which is
 *   the escalation this whole model exists to fence.
 * - **`upstream_access` is not `connections`.** The connection proxy spends a
 *   connection's live upstream token against the third-party service, so a
 *   holder reads and writes the person's actual Google or Todoist account
 *   rather than Marfa's record of it. That is a different order of magnitude
 *   from installing and removing a connection, and no sentence covering both
 *   is honest about either.
 * - **`credentials` is not `connections` either.** Registering and removing
 *   the upstream client secrets and API tokens a connection is installed
 *   against is its own authority, and so is starting the OAuth bootstrap
 *   that obtains one: that route takes a caller-supplied scope override
 *   straight into the upstream authorize URL, so it decides how much the
 *   credential it is about to fetch will be able to do. Leased tokens are
 *   deliberately NOT here: one carries no reach of its own beyond the
 *   connection that minted it, so it is part of operating a connection
 *   rather than a credential to hold.
 * - **`schema` is not registration.** Registering a type is already fenced
 *   by `metadata.types:write` and `metadata.edge_types:write`. This covers
 *   only what that grammar does not — changing and removing definitions that
 *   already exist — so the two never describe the same act. A capability
 *   duplicating an existing scope would put two names on one authority and
 *   leave a consent screen unable to tell a reader which one it is showing.
 * - **`space_usage` is not `space_settings`.** Reading how much room is left
 *   is what an app doing ordinary work wants; changing a space's enforcement
 *   policy is not, and one of the things that policy sets is how long the
 *   audit trail survives.
 * - **Outbound and inbound webhooks are not the same word.** `webhooks`
 *   covers the subscriptions that send a space's events out. A connection's
 *   inbound receipt endpoints belong to that connection and sit under
 *   `connections`.
 *
 * **Three things a gate must not infer from this set**, recorded here
 * because each is a boundary that already exists in the routes and would be
 * lost by wiring a capability check onto the shared authority helper:
 *
 * - **Minting an API key stays closed to OAuth callers outright.** The route
 *   refuses an OAuth bearer before any permission question, because a key is
 *   a durable credential that is not held to a token's scopes. Without that
 *   refusal `keys` would be the largest escalation in the set: an app could
 *   mint itself a permanent unscoped credential and no longer need the grant
 *   at all. The capability names who may manage keys, never who may escape
 *   the scope system.
 * - **`item_purge` is one item.** Bulk purge is platform-only today, and a
 *   capability held by a space-scoped app must not reach it.
 * - **The caller resolver is not a surface.** It answers which space a
 *   request acts in, ahead of the four page pairs that are surfaces, so
 *   gating it would gate the question rather than an answer.
 *
 * One site is deliberately uncovered. Listing a space's edge types is a read
 * whose item-type sibling is open to any authenticated caller, so the
 * consistent answer is relaxing that gate rather than inventing an
 * administrative capability to sit in front of a listing.
 */
export type CapabilityScope =
  | "capability.webhooks"
  | "capability.connections"
  | "capability.upstream_access"
  | "capability.credentials"
  | "capability.keys"
  | "capability.app_grants"
  | "capability.space_settings"
  | "capability.space_usage"
  | "capability.schema"
  | "capability.item_purge"
  | "capability.audit_read";

/**
 * Every capability scope, in the order a consent screen should offer them:
 * the surfaces an app plausibly needs first, the ones that hand over the
 * space's own security last. Not alphabetical, and not incidentally
 * ordered — a reader deciding what to grant reads down the list, so the
 * order is part of what the screen says.
 *
 * Exported so that the set has one home before it has a second reader. No
 * route gate consults a capability yet and no bundle offers one, so today
 * the only consumers are this package's own tests; the export exists so the
 * gate and the consent renderer read this array when they arrive rather than
 * each growing a list that can drift from it.
 */
export const CAPABILITY_SCOPES: readonly CapabilityScope[] = [
  "capability.webhooks",
  "capability.connections",
  "capability.schema",
  "capability.space_usage",
  "capability.space_settings",
  "capability.audit_read",
  "capability.item_purge",
  "capability.upstream_access",
  "capability.credentials",
  "capability.keys",
  "capability.app_grants",
];

const CAPABILITY_SET: ReadonlySet<string> = new Set(CAPABILITY_SCOPES);

/** Returns true if the literal names a capability this build recognizes. */
export function isCapabilityScope(scope: string): scope is CapabilityScope {
  return CAPABILITY_SET.has(scope);
}

/**
 * Whether a held scope set carries one specific capability.
 *
 * The only correct way to ask. A capability is granted by naming it and by
 * nothing else: no wildcard reaches one, no breadth of data access implies
 * one, and holding every other member of the set implies nothing about the
 * one being asked about.
 *
 * This exists as its own function rather than as a note telling callers what
 * not to do, because the alternative is what a gate author reaches for.
 * `scopeCovers` is the neighboring helper and it answers about the item-type
 * axis, where `*:write` matches any pattern — so asked about a capability it
 * said yes to a token holding no capability at all. That function now refuses
 * a capability outright, and this one is what replaces it.
 *
 * **Nothing can call this from a route yet, and the missing piece is a
 * carrier rather than a helper.** `ApiKey` has no scope list and the request
 * context carries none: the bearer middleware projects a token's scopes into
 * the three permission maps and keeps nothing else, and a capability
 * deliberately enters none of those. So a gate reaching for this has no
 * `held` to pass, and the change that wires the first gate has to thread the
 * granted scopes onto the request before it can use this at all. Stated here
 * because the shape of the fix is not obvious from the signature, and
 * because the wrong repair is to relax one of the three projections.
 */
export function hasCapability(
  held: readonly string[],
  capability: CapabilityScope,
): boolean {
  for (const scope of held) {
    const parsed = parseScope(scope);
    if (parsed?.kind !== "capability") continue;
    if (parsed.capability === capability) return true;
  }
  return false;
}

export interface ParsedScope {
  typePattern: string;
  /** "read" / "write" for type / edge / metadata scopes; "none" for
   *  capability and OIDC literals (neither of which has read/write
   *  semantics on a Marfa resource). */
  operation: "read" | "write" | "none";
  /**
   * Which family the scope belongs to. Always set, including for the
   * ordinary item-type scope, which reads as `"type"` rather than as the
   * absence of a kind.
   *
   * An absent discriminant made "not one of the families I recognize" the
   * same value as "an item-type grant", so every projection that had to tell
   * them apart was written as a list of kinds to skip. That shape admits
   * whatever nobody has thought of yet, and on the item-type axis being
   * admitted means having a pattern matched against the live type registry.
   */
  kind: "type" | "edge" | "metadata" | "oidc" | "capability";
  /** Present when kind === "edge"; the edge type id or "*". */
  edgeType?: string;
  /** Present when kind === "metadata" and the scope names a sub-resource (e.g. "types"). */
  subresource?: string;
  /** Present when kind === "oidc"; one of the standard OIDC literals. */
  oidcScope?: OidcScope;
  /** Present when kind === "capability"; the administrative surface named. */
  capability?: CapabilityScope;
}

/**
 * Whether a parsed scope grants on the item-type axis, and so belongs in
 * `type_permissions`.
 *
 * Positive identification, deliberately: the caller admits a scope because
 * the parser said it is a type scope, never because it failed to be anything
 * else. Skipping a named list of other kinds reads the same on today's union
 * and behaves in the opposite direction on tomorrow's, because a family
 * nobody has added to the list falls through to "must be an item type" and
 * has its pattern matched against the real registry by `typeMatchesPattern`,
 * where a `*` anywhere in it reaches every registered type.
 *
 * The `never` binding is what keeps that true without anyone rereading this:
 * adding a member to `ParsedScope["kind"]` stops the package compiling until
 * the new family is classified here, and every caller inherits the decision
 * because they all ask this one question.
 */
export function isTypeScope(parsed: ParsedScope): boolean {
  switch (parsed.kind) {
    case "type":
      return true;
    case "edge":
    case "metadata":
    case "oidc":
    case "capability":
      return false;
    default: {
      // Compile-time exhaustiveness check. The runtime arm refuses too, so a
      // value built by hand or arriving from a stale build is not admitted
      // either.
      const _exhaustive: never = parsed.kind;
      void _exhaustive;
      return false;
    }
  }
}

// Splits a type scope into its pattern and verb. The pattern half is only
// shape-checked here — `isValidTypePattern` is the authority, so the scope
// grammar and the type-identifier grammar can never drift apart. The bare `*`
// pattern is the global wildcard: a single grant covering every item type,
// including runtime `user.*` types that never appear in the static scope
// allowlist.
const SCOPE_RE = /^(\*|[a-z][a-z0-9_.*-]*):(read|write)$/;
// `edge.<type>:<verb>` — type can be kebab-case (parent-of, in-thread) or
// namespaced (karakeep.list-member).
const EDGE_SCOPE_RE = /^edge\.([a-z0-9_*][a-z0-9_.\-*]*):(read|write)$/;
// `metadata.<subresource>:<verb>` — sub-resource is a single dot-free
// segment (`types`, future siblings).
const METADATA_SUB_SCOPE_RE = /^metadata\.([a-z][a-z0-9_-]*):(read|write)$/;

/** Standard OIDC literals. Recognized by `parseScope` ahead of the
 *  `<type>:<verb>` matchers so they can't collide with future type names
 *  (which require a colon-separated verb). `offline_access` is the RFC
 *  6749 / OIDC standard literal that signals the RP wants a refresh token;
 *  the OAuth provider plugin requires it to be in the requested scope set
 *  before issuing a refresh token. Without recognition here, the consent
 *  route rejects this scope before it reaches the consent endpoint. */
const OIDC_LITERALS: ReadonlySet<OidcScope> = new Set([
  "openid",
  "profile",
  "email",
  "offline_access",
]);

/** Parses a scope string into its type pattern and operation. Returns null if invalid. */
export function parseScope(scope: string): ParsedScope | null {
  if (OIDC_LITERALS.has(scope as OidcScope)) {
    return {
      typePattern: scope,
      operation: "none",
      kind: "oidc",
      oidcScope: scope as OidcScope,
    };
  }
  // The capability root is claimed whole, not matched shape-first: anything
  // under it that is not a member of the closed set is refused here rather
  // than left to fall through. That matters for one literal in particular.
  // `capability.*:read` satisfies `isValidTypePattern` — the subtree-wildcard
  // branch checks the prefix grammar and not the reserved roots, which is
  // why `core.*:read` is a scope the server issues — so without this claim it
  // would parse as an item-type grant that reads like a capability grant and
  // is neither. Refusing the whole namespace except its members is the only
  // reading with no second interpretation.
  if (scope === CAPABILITY_ROOT || scope.startsWith(`${CAPABILITY_ROOT}.`)) {
    if (!isCapabilityScope(scope)) return null;
    return {
      typePattern: scope,
      operation: "none",
      kind: "capability",
      capability: scope,
    };
  }
  if (scope === "metadata:read" || scope === "metadata:write") {
    return {
      typePattern: "metadata",
      operation: scope.split(":")[1] as "read" | "write",
      kind: "metadata",
    };
  }
  // eslint-disable-next-line @typescript-eslint/prefer-regexp-exec -- .match returns the same captures; the regex has no /g flag
  const metadataSubMatch = scope.match(METADATA_SUB_SCOPE_RE);
  if (metadataSubMatch) {
    const subresource = metadataSubMatch[1] ?? "";
    const operation = metadataSubMatch[2] as "read" | "write";
    return {
      typePattern: `metadata.${subresource}`,
      operation,
      kind: "metadata",
      subresource,
    };
  }
  // eslint-disable-next-line @typescript-eslint/prefer-regexp-exec -- same rationale
  const edgeMatch = scope.match(EDGE_SCOPE_RE);
  if (edgeMatch) {
    const edgeType = edgeMatch[1] ?? "";
    const operation = edgeMatch[2] as "read" | "write";
    return {
      typePattern: `edge.${edgeType}`,
      operation,
      kind: "edge",
      edgeType,
    };
  }
  // eslint-disable-next-line @typescript-eslint/prefer-regexp-exec -- same rationale
  const match = scope.match(SCOPE_RE);
  if (!match) return null;
  const typePattern = match[1] ?? "";
  if (!isValidTypePattern(typePattern)) return null;
  return {
    typePattern,
    operation: match[2] as "read" | "write",
    kind: "type",
  };
}

/** Returns true if the scope string is syntactically valid. */
export function isValidScope(scope: string): boolean {
  return parseScope(scope) !== null;
}

// ---------------------------------------------------------------------------
// Wildcard expansion
// ---------------------------------------------------------------------------

/**
 * Expands subtree-wildcard scopes against a list of known type identifiers, so
 * the consent screen can name what a grant actually covers.
 * "core.media.*:read" → ["core.media:read", "core.media.book:read", ...]
 * Non-wildcard scopes pass through unchanged.
 *
 * Expansion keys on the pattern rather than on the kind, and stays that way:
 * what a wildcard covers is a question about the pattern. A capability needs
 * no arm of its own because the set is closed and holds no wildcard, so every
 * capability literal takes the pass-through branch and reaches consent as
 * itself.
 */
export function expandWildcardScopes(
  requested: string[],
  knownTypes: string[],
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const scope of requested) {
    const parsed = parseScope(scope);
    if (!parsed) continue;

    if (subtreeWildcardRoot(parsed.typePattern) !== null) {
      for (const type of knownTypes) {
        if (typeMatchesPattern(type, parsed.typePattern)) {
          const expanded = `${type}:${parsed.operation}`;
          if (!seen.has(expanded)) {
            seen.add(expanded);
            result.push(expanded);
          }
        }
      }
    } else {
      if (!seen.has(scope)) {
        seen.add(scope);
        result.push(scope);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Scope ↔ TypePermission conversion
// ---------------------------------------------------------------------------

/**
 * Converts a list of granted scopes into the type_permissions map format
 * used by the existing auth middleware. Write implies read.
 *
 * Only scopes `isTypeScope` positively identifies get in. Anything else,
 * including a family this build has never heard of, contributes nothing.
 */
export function scopesToTypePermissions(
  scopes: readonly string[],
): Record<string, TypePermission> {
  const perms: Record<string, TypePermission> = {};

  for (const scope of scopes) {
    const parsed = parseScope(scope);
    if (!parsed) continue;
    if (!isTypeScope(parsed)) continue;

    const current = perms[parsed.typePattern];
    if (parsed.operation === "write" || current === undefined) {
      perms[parsed.typePattern] = parsed.operation;
    }
  }

  return perms;
}

/**
 * Checks whether the held scopes satisfy a required type + operation.
 * Write scopes satisfy read requirements.
 *
 * **This is not the rule the request path applies, and it is one letter away
 * from looking like it is.** It returns on the FIRST held pattern that
 * matches with a sufficient verb. The bearer middleware projects scopes into
 * `type_permissions` and resolves with {@link resolveTypePermission}, which is
 * exact, then the LONGEST matching subtree wildcard, then the global one. The
 * two answer differently whenever a grant pairs a broad pattern with a
 * narrower one at a lower verb: held `*:write core.*:read`, asked about
 * writing `core.note`, this says yes and the middleware says no.
 *
 * So it is right about breadth on one pattern and wrong about precedence
 * across several, which makes it safe for "does any grant here mention this
 * type at this verb" and unsafe for "may this credential do this". Ask
 * {@link grantCoversScope} for the second. That function delegated here at
 * first, on the strength of this being the neighbouring helper with the right
 * shape and a careful docblock, and was fail-open for exactly the grant above
 * until a review caught it.
 */
export function scopeCovers(
  held: readonly string[],
  requiredType: string,
  requiredOp: "read" | "write",
): boolean {
  // A capability is not a point on the item-type axis, so asking this
  // function about one is a category error, and the honest answer to a
  // category error is no.
  //
  // Answering at all was the hazard. `*:read` and `*:write` are the
  // full-access path the consent screen offers under "Customize", and a
  // pattern match admits them against any string shaped like a type — so
  // this returned true for a token that holds no capability, and false for
  // one that holds exactly the capability being asked about. A gate reaching
  // for the nearest helper would have inherited a fail-open one level above
  // the one the capability kind exists to remove. Ask {@link hasCapability}.
  if (
    requiredType === CAPABILITY_ROOT ||
    requiredType.startsWith(`${CAPABILITY_ROOT}.`)
  ) {
    return false;
  }

  for (const scope of held) {
    const parsed = parseScope(scope);
    if (!parsed) continue;

    // Item-type scopes only, through the same predicate
    // `scopesToTypePermissions` asks, so the two can never answer differently
    // about a scope. This is load-bearing rather than tidiness: `edge` and
    // `metadata` are claimable publisher handles, so `edge.foo` is a
    // registrable item type, and `edge.*:write` is a scope the server both
    // advertises and issues. Without the guard a pattern match would let an
    // edge grant satisfy an item-type requirement.
    //
    // The exact string comparison this replaced happened to contain that,
    // because `edge.*` never equalled `edge.foo`. A pattern match does not,
    // so the guard has to be explicit.
    if (!isTypeScope(parsed)) continue;

    // `typeMatchesPattern`, not `!==`. The held scope carries a *pattern*
    // (`core.*`, `*`) and the requirement carries a concrete type, so string
    // inequality reported every wildcard grant as covering nothing: failing
    // closed, but wrongly, and silently.
    //
    // Note the neighbour: `matchesTypePattern` takes a list of patterns and
    // `typeMatchesPattern` takes one. Type first, pattern second.
    if (!typeMatchesPattern(requiredType, parsed.typePattern)) continue;
    if (parsed.operation === "write") return true;
    if (requiredOp === "read") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Edge-scope helpers
// ---------------------------------------------------------------------------

/** Projects edge-typed scopes into the edge_permissions map stored on keys. */
export function scopesToEdgePermissions(
  scopes: readonly string[],
): Record<string, "read" | "write"> {
  const perms: Record<string, "read" | "write"> = {};
  for (const scope of scopes) {
    const parsed = parseScope(scope);
    if (parsed?.kind !== "edge") continue;
    if (!parsed.edgeType) continue;
    // Edge parser path only emits "read" / "write" — the verb-less families
    // (OIDC literals, capabilities) are caught by the kind guard above.
    if (parsed.operation === "none") continue;
    const current = perms[parsed.edgeType];
    if (parsed.operation === "write" || current === undefined) {
      perms[parsed.edgeType] = parsed.operation;
    }
  }
  return perms;
}

// ---------------------------------------------------------------------------
// Metadata-scope helpers
// ---------------------------------------------------------------------------

/**
 * Projects metadata-sub-resource scopes (`metadata.<subresource>:<verb>`)
 * into the `metadata_permissions` map stored on keys / synthesized on
 * OAuth-derived `ApiKey` records. The bare `metadata:<verb>` form (no
 * sub-resource) acts as a wildcard — it sets `*: <verb>`. Write trumps
 * read, never downgrade.
 */
export function scopesToMetadataPermissions(
  scopes: readonly string[],
): Record<string, MetadataPermission> {
  const perms: Record<string, MetadataPermission> = {};
  for (const scope of scopes) {
    const parsed = parseScope(scope);
    if (parsed?.kind !== "metadata") continue;
    // Metadata parser path only emits "read" / "write" — the verb-less
    // families (OIDC literals, capabilities) are caught by the kind guard
    // above.
    if (parsed.operation === "none") continue;
    const key = parsed.subresource ?? "*";
    const current = perms[key];
    if (parsed.operation === "write" || current === undefined) {
      perms[key] = parsed.operation;
    }
  }
  return perms;
}

/**
 * Checks whether a metadata_permissions map covers the required verb on
 * a specific sub-resource. The wildcard `*` (granted by a bare
 * `metadata:<verb>` scope or a credential created with `*` explicitly)
 * matches any sub-resource. `write` implies `read`. Used by route guards
 * such as the `POST /types` admission check.
 */
export function metadataPermissionCovers(
  perms: Record<string, MetadataPermission> | undefined,
  subresource: string,
  requiredOp: "read" | "write",
): boolean {
  if (!perms) return false;
  const specific = perms[subresource];
  if (specific === "write" || (specific === "read" && requiredOp === "read")) {
    return true;
  }
  const wildcard = perms["*"];
  if (wildcard === "write" || (wildcard === "read" && requiredOp === "read")) {
    return true;
  }
  return false;
}

/**
 * Resolves the effective permission for an edge type against an
 * `edge_permissions` map, by the same precedence `resolveTypePermission`
 * applies to item types: an exact identifier outranks every pattern, then
 * the longest matching namespace wildcard, then the global `*`.
 *
 * Namespace wildcards matter here for a reason that does not arise on the
 * item side. A custom edge type is registered per space at runtime, so it
 * cannot be named in any list built before the request — `edge.user.*` is
 * the only expression that reaches a space's own relation edges short of
 * the global wildcard, which grants every edge type on the instance.
 * Resolving exact ids alone meant such a grant was issued and reported and
 * then matched nothing, so the narrow ask failed where the total ask
 * worked.
 */
function resolveEdgePermission(
  perms: Record<string, "read" | "write">,
  edgeType: string,
): "read" | "write" | undefined {
  const exact = perms[edgeType];
  if (exact !== undefined) return exact;

  let best: "read" | "write" | undefined;
  let bestLength = 0;
  for (const [pattern, permission] of Object.entries(perms)) {
    if (pattern === "*") {
      if (bestLength === 0) best = permission;
      continue;
    }
    const root = subtreeWildcardRoot(pattern);
    if (root === null) continue;
    // Parent-inclusive, as everywhere else a `.*` pattern is resolved:
    // `user.*` covers `user` itself as well as `user.blocks`.
    if (edgeType !== root && !edgeType.startsWith(`${root}.`)) continue;
    if (root.length > bestLength) {
      best = permission;
      bestLength = root.length;
    }
  }
  return best;
}

/**
 * Checks whether an edge_permissions map covers the required verb on a
 * specific edge type. Wildcard (`*`) matches any edge type, and a namespace
 * wildcard (`user.*`) matches that namespace. `write` implies `read`.
 * Called from the auth middleware at edge-route entry.
 */
export function edgePermissionCovers(
  perms: Record<string, "read" | "write"> | undefined,
  edgeType: string,
  requiredOp: "read" | "write",
): boolean {
  if (!perms) return false;
  const resolved = resolveEdgePermission(perms, edgeType);
  if (resolved === "write") return true;
  return resolved === "read" && requiredOp === "read";
}

// ---------------------------------------------------------------------------
// Grant coverage
// ---------------------------------------------------------------------------

/**
 * Whether a held grant covers a required scope literal, on whichever axis
 * that literal belongs to.
 *
 * The question every consent comparison actually asks, and the one none of
 * them asked. A grant of `core.*:read` genuinely covers `core.note:read`, so
 * a stored set holding the first is not short of the second — but a string
 * comparison reports it as missing, which asks a person who has already said
 * yes to say it again, and reports the reverse pairing as a *narrowing*,
 * which revokes the client's live tokens. Both readings are wrong and the
 * second is wrong destructively.
 *
 * The three axes with a verb are answered the way the bearer middleware
 * answers them: project the held scopes into the permission map a credential
 * is stored with, then resolve against that map with the resolver the request
 * path uses — {@link resolveTypePermission}, {@link edgePermissionCovers},
 * {@link metadataPermissionCovers}. So the breadth rule here is the breadth
 * rule enforced at the point of use, rather than a second one written to
 * match.
 *
 * **It is not the whole of what the middleware refuses, and should not be
 * mistaken for it.** The reserved-namespace gate turns down every `system.*`
 * and `marfa.*` write from an OAuth token before any permission map is
 * consulted, so a grant can cover `system.connection:write` here and be
 * refused there. That direction is harmless — a screen skipped for access
 * that then does not work — but it is the direction to check before adding an
 * arm. The two verb-less families have no middleware counterpart at all: no
 * route gates on a capability yet, and OIDC literals are read by the id_token
 * and userinfo callbacks rather than by the request principal.
 *
 * **That is a stricter requirement than "reuse a helper that looks right",
 * and the difference is not cosmetic.** {@link scopeCovers} sits beside this
 * function, refuses capabilities, is well tested, and answers a genuinely
 * different question: first match wins rather than longest match wins. This
 * delegated to it and was fail-open for one shape of grant until a review
 * found it. The test is not whether a helper is correct, it is whether it is
 * the one the request path runs.
 *
 * **A capability is covered by naming it and by nothing else, and that is the
 * property to break first when testing this.** The capability kind exists
 * because a wildcard must not reach an administrative surface; a coverage
 * helper answering otherwise would reinstate the fail-open one level above
 * the one that kind was added to remove. {@link scopeCovers} refuses to
 * answer about a capability at all, and this function never asks it — the
 * capability arm is the membership test at the top and nothing further.
 *
 * OIDC literals land in the same arm by different reasoning: they carry no
 * pattern and no verb, so exact membership is the only test that means
 * anything for them.
 *
 * A `held` entry this build cannot parse contributes nothing on any axis. A
 * `required` this build cannot parse is refused — an unrecognized literal
 * must not be waved through a consent skip — but only after the membership
 * test, so a grant naming it verbatim still covers it, and a scope the server
 * has stopped understanding does not read as a narrowing while both sides
 * carry it.
 *
 * Deliberately singular. A plural `missingScopes` reads well and had no
 * caller that needed the list, and an export with no production caller is
 * exactly how {@link scopeCovers} came to sit unused while five comparisons
 * beside it compared text.
 */
export function grantCoversScope(
  held: readonly string[],
  required: string,
): boolean {
  const need = parseScope(required);

  // A literal this build cannot read is covered by naming it and by nothing
  // else. Both sides carrying a scope the grammar has stopped understanding
  // is not a narrowing, and reading it as one would revoke live tokens over a
  // grammar change.
  if (!need) return held.includes(required);

  // The two families with no breadth. A capability names an administrative
  // surface and is reached by naming it; an OIDC literal carries no pattern
  // and no verb. Membership is the whole test for both, and letting either
  // fall through to a pattern matcher is the hazard the capability kind
  // exists to remove.
  if (need.kind === "oidc" || need.kind === "capability") {
    return held.includes(required);
  }

  // Everything remaining carries a real verb: "none" is emitted only by the
  // two parser paths just refused. Refused rather than asserted, so a value
  // built by hand or arriving from a stale build cannot reach a matcher with
  // no operation to match on.
  if (need.operation === "none") return false;

  // Note what is deliberately NOT here: a `held.includes(required)`
  // short-circuit ahead of the axis logic. It was, and it was unsound on
  // every verb-carrying axis. A grant of `*:write core.*:read` contains the
  // literal `*:write`, so a request for `*:write` matched verbatim and read
  // as covered — while the grant it was measured against cannot write
  // `core.note`, because the narrower entry outranks the wildcard. Naming a
  // pattern is not the same as holding what the pattern claims, once a
  // sibling can hold it down.
  switch (need.kind) {
    case "type": {
      const perms = scopesToTypePermissions(held);
      return grantCoversPattern(
        need.typePattern,
        need.operation,
        Object.keys(perms),
        (key) => resolveTypePermission(key, perms),
      );
    }
    case "edge": {
      if (!need.edgeType) return false;
      const perms = scopesToEdgePermissions(held);
      return grantCoversPattern(
        need.edgeType,
        need.operation,
        Object.keys(perms),
        (key) => effectiveLevel((op) => edgePermissionCovers(perms, key, op)),
      );
    }
    case "metadata": {
      // A bare `metadata:<verb>` requirement names no sub-resource and asks
      // about the whole namespace. Sub-resources are a single dot-free
      // segment by grammar, so the namespace form is the only breadth this
      // axis has.
      const perms = scopesToMetadataPermissions(held);
      return grantCoversPattern(
        need.subresource ?? GLOBAL_TYPE_WILDCARD,
        need.operation,
        Object.keys(perms),
        (key) =>
          effectiveLevel((op) => metadataPermissionCovers(perms, key, op)),
      );
    }
    default: {
      // Compile-time exhaustiveness, on the same reasoning as `isTypeScope`:
      // a kind added to the union stops the package compiling until someone
      // decides how breadth works on it, rather than inheriting whichever
      // arm happens to sit last.
      const _exhaustive: never = need.kind;
      void _exhaustive;
      return false;
    }
  }
}

/** Turns an axis's boolean `covers(op)` into the level it resolves to, so one
 *  breadth rule can be written over every axis without a second resolver. */
function effectiveLevel(
  covers: (op: "read" | "write") => boolean,
): "read" | "write" | "none" {
  if (covers("write")) return "write";
  return covers("read") ? "read" : "none";
}

/**
 * Whether a grant reaches everything a required pattern claims, at a verb.
 *
 * **A concrete requirement is a point question and a wildcard requirement is
 * not, and answering the second as though it were the first is fail-open.**
 * Every resolver on every axis here takes a concrete identifier and consults
 * the entries at or above it — exact, then the longest matching subtree
 * wildcard, then the global one. Handed a pattern instead, it therefore never
 * sees a single held entry BENEATH that pattern, and an entry beneath it is
 * exactly what narrows a grant. Held `*:write core.note:read`, asked whether
 * `core.*:write` is covered: the resolver finds the global `write` above
 * `core` and answers yes, having skipped the `core.note` that is the reason
 * the answer is no. A skipped consent screen, and a minted token whose exact
 * `core.*:write` then outranks the entry that had been holding it down.
 *
 * So a wildcard requirement is two questions. The subtree root has to be
 * covered, which is the resolver's own question and delegates to it. And
 * nothing inside the subtree may sit lower than what is being asked for,
 * which no resolver can answer because none of them look downward.
 *
 * `resolve` is the axis's own resolver, so the point question is answered by
 * whatever the request path runs and this adds a rule rather than replacing
 * one.
 */
function grantCoversPattern(
  pattern: string,
  op: "read" | "write",
  heldKeys: readonly string[],
  resolve: (key: string) => "read" | "write" | "none" | undefined,
): boolean {
  const enough = (level: "read" | "write" | "none" | undefined): boolean =>
    level === "write" || (level === "read" && op === "read");

  // `null` here means one of two things and the next line tells them apart:
  // a concrete identifier, or the global wildcard, which has no root string.
  const root = subtreeWildcardRoot(pattern);

  // A concrete requirement is a point, and the axis's own resolver is the
  // whole answer.
  if (root === null && pattern !== GLOBAL_TYPE_WILDCARD) {
    return enough(resolve(pattern));
  }

  // Upward: is the subtree granted at all. `core.*` is parent-inclusive, so
  // `core` is a fair representative of it. For the global wildcard there is
  // no root above, and asking a resolver about `*` returns the global entry
  // alone on every axis here — which is exactly the ceiling in question.
  if (!enough(resolve(root ?? GLOBAL_TYPE_WILDCARD))) return false;

  // Downward, which is the half no resolver can do. A key at or above the
  // requested root was already answered above; only a key strictly inside the
  // subtree can narrow it.
  for (const key of heldKeys) {
    if (key === GLOBAL_TYPE_WILDCARD) continue;
    const keyRoot = subtreeWildcardRoot(key) ?? key;
    const inside =
      root === null || (keyRoot !== root && keyRoot.startsWith(`${root}.`));
    if (!inside) continue;
    if (!enough(resolve(key))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Permission bundles
// ---------------------------------------------------------------------------

/**
 * A named, human-facing grouping of scopes rendered on the consent screen as
 * a single toggle group ("Read your content", "Write your content", …).
 * Bundles are defined in server config and advertised on the discovery
 * document so clients can request them without hard-coding the scope grammar.
 * They are a presentation + request convenience: the issued token still
 * carries the concrete scopes a bundle expands to, enforced through the usual
 * permission maps. The shipped defaults enumerate concrete per-type scopes —
 * a consent grant can only narrow to scopes literally requested, so per-type
 * unticking requires naming each type up front. A wildcard scope inside a
 * bundle (e.g. `user.*:read`) narrows as a unit rather than per type.
 */
export interface PermissionBundle {
  /** Stable identifier, e.g. "read", "write", "profile", "connected". */
  id: string;
  /** Plain-language label for the consent toggle, e.g. "Read your content". */
  label: string;
  /** One-line description of what granting the bundle allows. */
  description: string;
  /** The concrete scope strings the bundle expands to. */
  scopes: string[];
  /** Whether the bundle is pre-ticked (granted) by default on consent. */
  default_on: boolean;
}

/**
 * Expands a set of permission bundles into a de-duplicated, sorted scope list.
 * Clients use it to turn a bundle selection into an authorize-request scope
 * string; the server uses it to resolve a consent submission back to scopes.
 */
export function expandBundlesToScopes(bundles: PermissionBundle[]): string[] {
  const out = new Set<string>();
  for (const bundle of bundles) {
    for (const scope of bundle.scopes) out.add(scope);
  }
  return Array.from(out).sort();
}

/**
 * Scopes that only an off-by-default bundle offers.
 *
 * `default_on: false` means the toggle starts unticked, and the whole of
 * what it grants is that a person ticked it. A surface with no per-scope
 * toggle therefore cannot grant one of these at all: there is no tick to
 * make, so "leaving it alone grants nothing" has nothing to attach to. The
 * device flow is that surface, and this is what it refuses.
 *
 * Claimed by at least one bundle and reached by no on-by-default one, so a
 * scope the user already gets by default is not withheld, and a scope no
 * bundle mentions is untouched. Only a bundle can declare this, so only a
 * bundle can withhold it.
 *
 * "Reached" rather than "named", because a bundle may hold a wildcard. An
 * on-by-default bundle offering `core.*:read` gives the user `core.note:read`
 * without anybody ticking anything, so withholding `core.note:read` because
 * an off-by-default bundle also names it withholds nothing real and refuses
 * the device flow over a scope the consent screen would tick.
 */
export function scopesOfferedOffByDefaultOnly(
  bundles: readonly PermissionBundle[],
): Set<string> {
  const offered = new Set<string>();
  const onByDefault = new Set<string>();
  for (const bundle of bundles) {
    for (const scope of bundle.scopes) {
      offered.add(scope);
      if (bundle.default_on) onByDefault.add(scope);
    }
  }
  // Two passes rather than one, and the literal pass is not redundant.
  // Coverage is computed over the whole on-by-default union, and a union is
  // not monotone: a narrower entry outranks a wildcard, so
  // `grantCoversScope(["*:write", "core.*:read"], "*:write")` is false even
  // though a bundle named `*:write` outright. Asking coverage alone would
  // therefore start withholding scopes an on-by-default bundle plainly
  // offers, which is a refusal in the direction nobody would look for.
  for (const scope of onByDefault) offered.delete(scope);
  const held = [...onByDefault];
  for (const scope of [...offered]) {
    if (grantCoversScope(held, scope)) offered.delete(scope);
  }
  // The hidden mechanisms are exempt, matching the consent screen, which
  // submits them without a visible toggle for the same reason: a person
  // cannot decline a control they cannot see, so `default_on` never governed
  // them on either surface.
  //
  // Without this the exemption asymmetry is not cosmetic. `offline_access`
  // is what a client names to get a refresh token, every SDK device flow
  // requests it, and an operator who put it in an off-by-default bundle
  // would have every one of them refused outright at initiation. A bundle
  // withholds a mechanism by not requesting it.
  for (const mechanism of HIDDEN_MECHANISM_SCOPES) offered.delete(mechanism);
  return offered;
}

/**
 * OAuth mechanisms rather than data permissions: `openid` is the identity
 * base a sign-out needs and `offline_access` is the refresh token a client
 * needs to keep working. Both ride along without a visible toggle, so no
 * per-scope consent decision applies to either.
 */
export const HIDDEN_MECHANISM_SCOPES: readonly OidcScope[] = [
  "openid",
  "offline_access",
];
