import type { MetadataPermission, TypePermission } from "./types.js";
import { isValidTypePattern } from "./validation.js";
import { subtreeWildcardRoot, typeMatchesPattern } from "./type-patterns.js";

// ---------------------------------------------------------------------------
// Scope parsing
// ---------------------------------------------------------------------------

/**
 * Parsed representation of a scope string. Five shapes today:
 *   - item-type scope:  "core.note:read"     → kind undefined, typePattern="core.note"
 *                       ("*:read" / "*:write" are the global type wildcard)
 *   - metadata scope:   "metadata:write"     → kind="metadata", subresource undefined
 *   - metadata sub:     "metadata.types:write" → kind="metadata", subresource="types"
 *   - edge scope:       "edge.parent-of:write" or "edge.*:write"
 *                       → kind="edge", edgeType="parent-of" or "*"
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

export interface ParsedScope {
  typePattern: string;
  /** "read" / "write" for type / edge / metadata scopes; "none" for OIDC
   *  literals (which have no read/write semantics on Marfa resources). */
  operation: "read" | "write" | "none";
  /** "edge", "metadata", or "oidc" for the disambiguated families;
   *  undefined for type scopes. */
  kind?: "edge" | "metadata" | "oidc";
  /** Present when kind === "edge"; the edge type id or "*". */
  edgeType?: string;
  /** Present when kind === "metadata" and the scope names a sub-resource (e.g. "types"). */
  subresource?: string;
  /** Present when kind === "oidc"; one of the standard OIDC literals. */
  oidcScope?: OidcScope;
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
  return { typePattern, operation: match[2] as "read" | "write" };
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
 */
export function scopesToTypePermissions(
  scopes: string[],
): Record<string, TypePermission> {
  const perms: Record<string, TypePermission> = {};

  for (const scope of scopes) {
    const parsed = parseScope(scope);
    if (!parsed) continue;

    if (
      parsed.kind === "metadata" ||
      parsed.kind === "edge" ||
      parsed.kind === "oidc"
    )
      continue;

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
 */
export function scopeCovers(
  held: string[],
  requiredType: string,
  requiredOp: "read" | "write",
): boolean {
  for (const scope of held) {
    const parsed = parseScope(scope);
    if (!parsed) continue;
    if (parsed.typePattern !== requiredType) continue;
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
  scopes: string[],
): Record<string, "read" | "write"> {
  const perms: Record<string, "read" | "write"> = {};
  for (const scope of scopes) {
    const parsed = parseScope(scope);
    if (parsed?.kind !== "edge") continue;
    if (!parsed.edgeType) continue;
    // Edge parser path only emits "read" / "write" — OIDC literals are
    // caught by the kind guard above.
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
  scopes: string[],
): Record<string, MetadataPermission> {
  const perms: Record<string, MetadataPermission> = {};
  for (const scope of scopes) {
    const parsed = parseScope(scope);
    if (parsed?.kind !== "metadata") continue;
    // Metadata parser path only emits "read" / "write" — OIDC literals
    // are caught by the kind guard above.
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
 * Checks whether an edge_permissions map covers the required verb on a
 * specific edge type. Wildcard (`*`) matches any edge type. `write`
 * implies `read`. Called from the auth middleware at edge-route entry.
 */
export function edgePermissionCovers(
  perms: Record<string, "read" | "write"> | undefined,
  edgeType: string,
  requiredOp: "read" | "write",
): boolean {
  if (!perms) return false;
  const specific = perms[edgeType];
  if (specific === "write" || (specific === "read" && requiredOp === "read")) {
    return true;
  }
  const wildcard = perms["*"];
  if (wildcard === "write" || (wildcard === "read" && requiredOp === "read")) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Permission bundles
// ---------------------------------------------------------------------------

/**
 * A named, human-facing grouping of scopes rendered on the consent screen as a
 * single checkbox ("Read your stuff", "Write your stuff", …). Bundles are
 * defined in server config and advertised on the discovery document so clients
 * can request them without hard-coding the scope grammar. They are a
 * presentation + request convenience: the issued token still carries the
 * concrete scopes a bundle expands to, enforced through the usual permission
 * maps. The generous default bundle expands to the `*` wildcard so an app
 * works against a tenant's runtime `user.*` types without those types ever
 * appearing in the static scope allowlist.
 */
export interface PermissionBundle {
  /** Stable identifier, e.g. "read", "write", "profile", "connected". */
  id: string;
  /** Plain-language label for the consent checkbox, e.g. "Read your stuff". */
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
