import type { MetadataPermission, TypePermission } from "./types.js";
import { isValidTypePattern, resolveTypePermission } from "./validation.js";
import { CAPABILITY_ROOT, CONTENT_ROOT } from "./scope-roots.js";
import { SYSTEM_TYPE_IDS } from "./type-registry.js";
import {
  GLOBAL_TYPE_WILDCARD,
  subtreeWildcardRoot,
  typeMatchesPattern,
} from "./type-patterns.js";

// ---------------------------------------------------------------------------
// Scope parsing
// ---------------------------------------------------------------------------

/**
 * Parsed representation of a scope string. Seven shapes today:
 *   - item-type scope:  "core.note:read"     → kind="type", typePattern="core.note"
 *                       ("*:read" / "*:write" are the global type wildcard)
 *   - content category: "content:read" / "content:write"
 *                       → kind="content", typePattern="content"
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
export { CAPABILITY_ROOT } from "./scope-roots.js";

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

// ---------------------------------------------------------------------------
// Content-category scopes
// ---------------------------------------------------------------------------

/**
 * The reserved root the content-category scopes live under. Reserved in
 * `RESERVED_ROOTS`, so `POST /types` refuses to register anything beneath
 * it and no publisher handle can claim the word.
 *
 * Claimed WHOLE, exactly as {@link CAPABILITY_ROOT} is, and for the same
 * reason rather than for symmetry. The claim does two things and the second
 * is the one worth writing down.
 *
 * It is what makes the two members parse at all. `content` is a single
 * segment and the concrete branch of `isValidTypePattern` requires two, so
 * `content:read` clears the scope regex and is then refused by the pattern
 * check — without the claim it is not a scope, rather than a scope meaning
 * something else.
 *
 * And it is what refuses `content.*:read`, which is the shape that genuinely
 * carries two readings. The subtree-wildcard branch of `isValidTypePattern`
 * checks the prefix grammar and never consults the reserved roots, which is
 * why `core.*:read` is a scope the server issues — so without the claim
 * `content.*:read` parses as an ordinary item-type grant over a wildcard
 * sitting under the category root, and reads on a consent screen as the
 * category grant it is not. Refusing the whole namespace except its two
 * members is the only reading with no second interpretation.
 */
export { CONTENT_ROOT } from "./scope-roots.js";

/**
 * A grant over the whole content category: every type a person would call
 * theirs, including whatever is registered after the grant was made.
 *
 * **Why a kind of its own rather than a namespace wildcard.** The vendored
 * OAuth provider re-validates what the consent hook hands back with
 * `new Set(client.scopes).has(scope)` — exact, with no pattern matching — so
 * a concrete literal admitted on the grounds that a wildcard covers it is
 * refused a moment later as `invalid_scope` on the WHOLE request, riding a
 * redirect the application may never render. Breadth belongs in what gets
 * written, not in what gets compared: this is a literal the provider matches
 * exactly, and the breadth lives in what {@link scopesToTypePermissions}
 * projects it into.
 *
 * **Why not `*:read`.** The global wildcard also reaches stored credentials,
 * devices, webhooks and other applications' private state. The category is
 * defined as everything whose stored family is not `system`, which is
 * exactly the set a person would call theirs.
 *
 * **Ordered levels, not independent flags.** `content:write` covers
 * `content:read`; neither is reached by any wildcard, and holding every
 * concrete type literal in the space does not add up to either.
 */
export type ContentScope = "content:read" | "content:write";

/** Both content-category literals, weakest first. */
export const CONTENT_SCOPES: readonly ContentScope[] = [
  "content:read",
  "content:write",
];

/** Returns true if the literal is one of the two content-category scopes. */
export function isContentScope(scope: string): scope is ContentScope {
  return scope === "content:read" || scope === "content:write";
}

/**
 * The level a scope set holds on the content category, or undefined for a
 * set holding neither literal.
 *
 * The levels are ordered, so a set naming both resolves to `write`. Nothing
 * else in the set contributes: a wildcard does not reach the category and
 * neither does naming every type in it, which is what makes an existing
 * grant a row grant rather than a silently promoted parent one.
 */
function heldContentLevel(
  scopes: readonly string[],
): "read" | "write" | undefined {
  let level: "read" | "write" | undefined;
  for (const scope of scopes) {
    const parsed = parseScope(scope);
    if (parsed?.kind !== "content") continue;
    if (parsed.operation === "write") return "write";
    if (parsed.operation === "read") level = "read";
  }
  return level;
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
  kind: "type" | "edge" | "metadata" | "oidc" | "capability" | "content";
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
    case "content":
      // No, despite the content category being a statement about item types.
      // This predicate answers a narrower question than its name suggests:
      // whether a scope belongs in `type_permissions` UNDER ITS OWN PATTERN
      // as the key. A content scope's pattern is `content`, which is not a
      // type pattern and never matches a registered type, so admitting one
      // here would mint an entry that resolves nothing while reading as a
      // grant. {@link scopesToTypePermissions} projects the category through
      // an arm of its own, ahead of the loop this gate stands in.
      return false;
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
//
// **This class still admits a second wildcard, and that is the remaining half
// of the edge-grammar work rather than an oversight.** `edge.*.*` parses here
// where `isValidTypePattern` refuses `core.*.*`, because the type axis routes
// a wildcard's root through `TYPE_ID_PREFIX` and this has no equivalent.
// Narrowing it is a one-line change and its consequences are not: the merge
// and intersect paths reason about STORED grants, so a literal that stops
// parsing stops being reasoned about, and eleven cases in
// `device-scope-merge.test.ts` pin what happens to a malformed key today.
// Closing it means deciding what those paths owe a key a validator can refuse
// but a stored grant may already carry, which is a separate piece of work
// from the registration door below.
const EDGE_SCOPE_RE = /^edge\.([a-z0-9_*][a-z0-9_.\-*]*):(read|write)$/;
// `metadata.<subresource>:<verb>` — sub-resource is a single dot-free
// segment (`types`, future siblings).
//
// **The metadata axis does not have the edge axis's second-wildcard hole**,
// asked and answered rather than assumed: the sub-resource class carries
// neither a dot nor an asterisk, so `metadata.*.*:write` is refused here and
// falls through to no other matcher that would take it.
//
// It has a neighbouring one worth naming, because it is not this regex's to
// fix. `metadata.*:read` falls past this matcher to `SCOPE_RE`, clears
// `isValidTypePattern` because the root `metadata` satisfies
// `TYPE_ID_PREFIX`, and parses as `kind: "type"` — an item-type grant over a
// namespace, wearing a literal that reads as a metadata grant. Reserving
// `metadata` as a root is what stops a type ever occupying that namespace;
// the literal still parses on the type axis.
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
  // The content root is claimed whole, on the same reasoning as the
  // capability root above: `content.*:read` clears `isValidTypePattern` for
  // exactly the reason `capability.*:read` does, and would otherwise parse
  // as an item-type grant that reads like the category grant and is neither.
  // The claim is also what admits the two members, since `content` is one
  // segment and the concrete-identifier branch requires two.
  //
  // The head is taken before the colon so one test covers `content:read`,
  // the bare root and everything under `content.`, and so a root merely
  // starting with the same letters is not swallowed —
  // `contented.note:read` is an ordinary publisher type and falls through.
  const contentHead = scope.split(":", 1)[0] ?? "";
  if (
    contentHead === CONTENT_ROOT ||
    contentHead.startsWith(`${CONTENT_ROOT}.`)
  ) {
    if (!isContentScope(scope)) return null;
    return {
      typePattern: CONTENT_ROOT,
      operation: scope === "content:write" ? "write" : "read",
      kind: "content",
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
 * The content category as a permission map: everything whose stored family
 * is not `system`, expressed as a complement rather than an enumeration.
 *
 * **Nothing here is enumerated, and that is the answer to the first question
 * a reviewer asks.** The category is "everything except the system family",
 * so the map names the global wildcard and then subtracts. There is no list
 * of a space's types to build, therefore nothing that could carry one
 * space's vocabulary into another's grant. Which types the wildcard actually
 * reaches is decided per request by {@link resolveTypePermission} against
 * the caller's own space, exactly as it is for `*:read` today.
 *
 * Four deliberate entries:
 *
 * - **`SYSTEM_TYPE_IDS` is the authority for the exclusion, and it is
 *   family-backed.** Boot reads the stored `family` column off every
 *   `origin = 'platform'` row and refills the set from it, pinning a row
 *   this build cannot read to `system`. So it answers correctly for a type
 *   the build has retired and after a rollback, neither of which a name test
 *   can do.
 * - **`system.*` is a BELT, not the authority.** It catches nothing today:
 *   registration under a reserved root is refused for every credential, so a
 *   `system.` type that is not in `SYSTEM_TYPE_IDS` cannot exist. It costs
 *   one entry and it is here for the build that somehow ships one. Deleting
 *   `SYSTEM_TYPE_IDS` and keeping this string is the change to refuse: every
 *   system type ships under `system.` today, so the swap looks equivalent
 *   and stops being so the moment a system-family type is named anything
 *   else.
 * - **`marfa.*` reads but does not write.** Those types are family
 *   `integration`, so they are squarely in the category and their reads are
 *   unrestricted. But the middleware refuses every `marfa.*` write from a
 *   credential that is not `is_platform` or a manifest-granted runtime
 *   credential, and an OAuth token is neither. **A parent must never claim
 *   what a hard gate will refuse**: a grant that reads as covering a write
 *   nothing will ever permit is a consent screen telling a person something
 *   untrue, and a permission model that misdescribes itself where it could
 *   instead have refused out loud.
 * - **The global entry carries the level itself**, so `resolveTypePermission`
 *   does the rest unchanged: exact beats the longest subtree wildcard beats
 *   the global one.
 */
function contentCategoryPermissions(
  level: "read" | "write",
): Record<string, TypePermission> {
  const perms: Record<string, TypePermission> = {
    [GLOBAL_TYPE_WILDCARD]: level,
  };
  for (const id of SYSTEM_TYPE_IDS) perms[id] = "none";
  perms[`system.${GLOBAL_TYPE_WILDCARD}`] = "none";
  if (level === "write") {
    perms[`marfa.${GLOBAL_TYPE_WILDCARD}`] = "read";
  }
  return perms;
}

/**
 * Converts a list of granted scopes into the type_permissions map format
 * used by the existing auth middleware. Write implies read.
 *
 * Only scopes `isTypeScope` positively identifies get in, plus the content
 * category, which has an arm of its own because its pattern is not a type
 * pattern. Anything else, including a family this build has never heard of,
 * contributes nothing.
 *
 * **This function is registry-dependent, which it was not before.** It reads
 * `SYSTEM_TYPE_IDS`, and that set is data an instance holds rather than a
 * fact about the build: a server seeds it from `custom_types` at boot, and
 * every caller of this function runs after seeding. In a browser bundle or
 * in the SDK there is no boot, so it resolves against the compiled shipped
 * set — the same contract {@link typeMatchesPattern} already has against
 * `TYPE_REGISTRY`, and the same one every other registry-reading helper in
 * this package carries. A scope list holding no content literal touches none
 * of this and projects exactly as it did.
 */
export function scopesToTypePermissions(
  scopes: readonly string[],
): Record<string, TypePermission> {
  const perms: Record<string, TypePermission> = {};

  // The category first, the named literals over the top, so the result does
  // not depend on the order the scopes arrived in. Both directions of that
  // collision are real: the shipped read bundle names `system.connection:read`,
  // which this projection excludes, and whichever of the two ran last would
  // otherwise decide the answer.
  const content = heldContentLevel(scopes);
  if (content) Object.assign(perms, contentCategoryPermissions(content));

  for (const scope of scopes) {
    const parsed = parseScope(scope);
    if (!parsed) continue;
    if (!isTypeScope(parsed)) continue;

    const current = perms[parsed.typePattern];
    // The stronger of the two wins, which is the rule this loop already
    // applied — `current === "none"` is the only clause added, and it can
    // only be reached by an entry the category put there. A scope literal is
    // never `"none"`: the grammar has no way to spell one, so no key this
    // loop writes ends up below the level a literal named. A set holding no
    // content literal never sees a `"none"` and projects exactly as it did
    // before.
    //
    // **That is a statement about keys, and it is NOT the statement that
    // adding the category to a grant can only widen it.** Do not read it as
    // one. `resolveTypePermission` puts an exact key ahead of any wildcard,
    // and the category writes exact keys — every `SYSTEM_TYPE_IDS` member at
    // `"none"`, and `marfa.*` clamped to `"read"` on the write level. So a
    // grant already holding a wildcard that reached those ids loses them when
    // the category is added beside it:
    //
    //   ["*:read"]                   → system.credential resolves "read"
    //   ["*:read", "content:read"]   → system.credential resolves "none"
    //   ["*:write"]                  → marfa.captured_email resolves "write"
    //   ["*:write", "content:write"] → marfa.captured_email resolves "read"
    //
    // A strictly larger scope set therefore covers strictly less, and
    // `grantCoversScope` flips from true to false across the same pair. That
    // is fail-closed in both cases and confers nothing, so it is not an
    // escalation — but it does mean a standing grant re-consented alongside
    // the category is asked for again rather than waved through, and any
    // caller reasoning that a superset is safe to substitute is wrong.
    //
    // The four resolutions above are asserted rather than described.
    // `scopes.test.ts` holds them under "adding the content category to a
    // wildcard grant can narrow it", so a change that stops one of them
    // being true reddens there instead of leaving this comment standing
    // over a measurement nobody rechecks. The previous version of this
    // comment was wrong for exactly as long as it took somebody to read it.
    if (
      parsed.operation === "write" ||
      current === undefined ||
      current === "none"
    ) {
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

  // The content category, before the axis logic, because it is a membership
  // question wearing a verb. Held `content:read` covers `content:read`; held
  // `content:write` covers both; nothing else covers either.
  //
  // **A grant naming every type in the space does not cover the parent, and
  // that is the point rather than a limitation.** A row grant is a statement
  // about named things and a parent grant is a statement about the category,
  // so promoting the first to the second would hand an application types
  // nobody approved. Every existing grant is therefore filed as new at the
  // next consent and the person is asked once — the migration cost the
  // design rules for, not a regression.
  //
  // Only this direction is special. Held `content:read`, asked about
  // `core.note:read`, is answered by the `type` arm below through the
  // projection, with no code of its own: the category resolves to the global
  // wildcard and `resolveTypePermission` takes it from there.
  if (need.kind === "content") {
    const level = heldContentLevel(held);
    if (level === "write") return true;
    return level === "read" && need.operation === "read";
  }

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
