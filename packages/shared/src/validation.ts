import type { TypePermission } from "./types.js";
import { RESERVED_ROOT_NAMES } from "./scope-roots.js";
import {
  GLOBAL_TYPE_WILDCARD,
  subtreeWildcardRoot,
  typeMatchesAnyPattern,
  typeMatchesPattern,
} from "./type-patterns.js";

// Full ISO 8601 with timezone (e.g. 2026-03-15T14:30:00Z)
const STRICT_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

// Also accepts date-only (2026-03-15) and year-month (2026-03)
const FLEXIBLE_TIMESTAMP =
  /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?)?)?$/;

/** Returns true if `value` is a valid ISO 8601 timestamp (full datetime, date-only, or year-month). */
export function isValidTimestamp(value: string): boolean {
  if (!FLEXIBLE_TIMESTAMP.test(value)) return false;
  // Date constructor silently rolls over invalid dates (Feb 30 → Mar 2).
  // For date-containing strings, compare parsed components to originals.
  const parts = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(value);
  if (!parts) return false;
  const d = new Date(value);
  if (isNaN(d.getTime())) return false;
  // Only validate day/month if present in the input
  if (parts[3] !== undefined) {
    const utc = value.includes("T") || value.endsWith("Z");
    const day = utc ? d.getUTCDate() : d.getDate();
    const month = utc ? d.getUTCMonth() + 1 : d.getMonth() + 1;
    if (day !== Number(parts[3]) || month !== Number(parts[2])) return false;
  }
  return true;
}

/** Returns true if `value` is a strict ISO 8601 timestamp with timezone (used for system fields). */
export function isValidStrictTimestamp(value: string): boolean {
  if (!STRICT_TIMESTAMP.test(value)) return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

// ---------------------------------------------------------------------------
// Blob hash validation
// ---------------------------------------------------------------------------

const BLOB_HASH = /^sha256:[0-9a-f]{64}$/;

/** Returns true if the value is a valid content-addressed blob hash (sha256:<hex>). */
export function isValidBlobHash(value: string): boolean {
  return BLOB_HASH.test(value);
}

/** Returns true if the value is a valid URL. */
export function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

// Basic format check, not exhaustive: one `@` with text before it, and a
// domain holding a dot with text on both sides of it. Written as string
// scans because the single-regex form backtracks polynomially on a long
// input with many dots. 254 is the longest address SMTP carries.
const EMAIL_MAX_LENGTH = 254;
const WHITESPACE = /\s/;

/** Returns true if the value looks like a valid email address. */
export function isValidEmail(value: string): boolean {
  if (value.length > EMAIL_MAX_LENGTH || WHITESPACE.test(value)) return false;
  const at = value.indexOf("@");
  if (at < 1 || at !== value.lastIndexOf("@")) return false;
  const domain = value.slice(at + 1);
  const lastDot = domain.lastIndexOf(".");
  // A dot with text before and after it exists exactly when some dot sits
  // past the first character and before the last.
  return (
    lastDot > 0 &&
    (lastDot < domain.length - 1 || domain.lastIndexOf(".", lastDot - 1) > 0)
  );
}

// BCP 47: primary tag + optional subtags, e.g. en, en-US, zh-Hans
const BCP47 = /^[a-z]{2,3}(-[A-Za-z]{2,8})*$/;

/** Returns true if the value is a plausible BCP 47 language code. */
export function isValidLanguageCode(value: string): boolean {
  return BCP47.test(value);
}

// Type identifiers: dot-separated segments. Min 2 segments.
// Segments: lowercase alphanumeric, underscores, hyphens. Max 128 characters.
//
// Namespace grammar (enforced structurally below):
//   core.<segment>             — exactly two segments under core (subtypes
//                                permitted: core.media.book, core.entity.person)
//   system.<segment>           — exactly two segments
//   app.<app-name>.<type>      — exactly three segments (app trust separates
//                                from publisher trust; the explicit segment
//                                makes that visible)
//   user.<segment>             — exactly two segments (subtypes permitted)
//   <publisher>.<type>         — two or more segments where the first is a
//                                non-reserved-root handle
const TYPE_ID = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;

/**
 * First segments a publisher may never claim in the type grammar. Five name
 * a namespace tier the platform defines (`classifyNamespace`). The rest name
 * none, and are reserved for the opposite reason — each is a root an OAuth
 * scope family lives under, and reserving it is what stops a registered type
 * ever sharing a literal with a grant. A reserved root without a tier is therefore a namespace nothing can
 * occupy, which is the intent.
 *
 * **Derived rather than typed out**, from `scope-roots.ts`, so the next
 * scope family is protected by having been declared.
 *
 * **Reserving a root is not what makes a scope literal under it
 * unambiguous**, and the note is worth a line because the two look like one
 * job. A scope's pattern half is checked by `isValidTypePattern`, whose
 * concrete branch consults this set and whose subtree-wildcard branch does
 * not — so `content.*` stays a well-formed pattern whatever this set holds.
 * What refuses a scope under a claimed root is the root claim in
 * `parseScope`. Two gates, two paths: registration asks this one, the scope
 * grammar asks that one.
 */
export const RESERVED_ROOTS: ReadonlySet<string> = new Set(RESERVED_ROOT_NAMES);

/**
 * A single-segment kebab edge name: `parent-of`, `in-thread`, `attached-to`.
 * Starts with a letter, ends with a letter or digit, no dots.
 */
const EDGE_KEBAB_NAME = /^[a-z](?:[a-z0-9_-]*[a-z0-9])?$/;

/**
 * Returns true if the value is a well-formed edge-type identifier: either a
 * single-segment kebab name, or anything the type grammar accepts.
 *
 * **Deferring to `isValidTypeIdentifier` for the dotted form is the point.**
 * A namespaced edge type is a namespaced identifier, so it should be the same
 * identifier the type axis means — same tiers, same arity per tier, same
 * reserved-root refusals. Writing a second dotted grammar here is how the two
 * axes drift, which is exactly the defect this guards against, arriving
 * from the other direction.
 *
 * Naming the kebab form admits the nine shipped ids without exempting
 * everything that happens to share a character with them: skipping the check
 * for anything containing a hyphen would let `"-"`, `"MY-EDGE"`, `"a b-c"`,
 * `"../-"` and `"..--.."` register.
 */
export function isValidEdgeTypeIdentifier(value: string): boolean {
  if (typeof value !== "string") return false;
  if (!value.includes(".")) return EDGE_KEBAB_NAME.test(value);
  return isValidTypeIdentifier(value);
}

/**
 * Returns true if the value is a syntactically valid type identifier under
 * the five-tier namespace grammar. Authorization is enforced separately at
 * registration time: `core.*` / `system.*` / `marfa.*` are refused for
 * every credential. Nothing binds a `publisher.*` namespace to anyone:
 * there are user accounts, but no handle on them and no door that compares
 * one, so a publisher-tier identifier registers on the grammar alone.
 */
export function isValidTypeIdentifier(value: string): boolean {
  if (value.length > 128) return false;
  if (!TYPE_ID.test(value)) return false;
  const segments = value.split(".");
  const root = segments[0] ?? "";
  switch (root) {
    case "app":
      // app.<app-name>.<type>: exactly three segments, no deeper.
      return segments.length === 3;
    case "core":
    case "system":
    case "user":
    case "marfa":
      // Subtypes allowed: core.entity.person is valid; system.* stays at
      // two segments operationally but the grammar accepts deeper paths
      // (server-side validation rejects deeper system registrations).
      return segments.length >= 2;
    default:
      // <publisher>.<type>[.<subtype>...] — at least two segments. Publisher
      // namespaces may carry sub-namespaces just like the reserved roots do
      // (e.g. `acme.calendar.event`). Publisher handles cannot collide with
      // reserved roots; see classifyNamespace.
      if (RESERVED_ROOTS.has(root)) return false;
      return segments.length >= 2;
  }
}

// A dotted run of identifier segments with no arity rule — the prefix half of
// a subtree wildcard, which names a namespace rather than a concrete type.
const TYPE_ID_PREFIX = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/;

/**
 * Returns true if the value is a valid *type pattern*: the global `*`, a
 * subtree wildcard (`core.media.*`), or a concrete type identifier.
 *
 * The pattern grammar is the identifier grammar plus wildcards, and nothing
 * else. Keeping the two in step matters because a scope string is where a
 * pattern first enters the system: a scope loose enough to admit
 * `core/note:read` or `core..note:read` would mint a permission-map key that
 * can never match a real type, and the credential would look granted while
 * resolving to nothing.
 */
export function isValidTypePattern(value: string): boolean {
  if (value === GLOBAL_TYPE_WILDCARD) return true;
  if (value.length > 128) return false;
  // `subtreeWildcardRoot` owns the decomposition, so this function and the
  // matcher cannot come to different views of where a pattern's root ends.
  // A trailing `.*` with nothing before it has no root, and falls through to
  // the identifier check, which refuses it.
  const root = subtreeWildcardRoot(value);
  if (root !== null) return TYPE_ID_PREFIX.test(root);
  return isValidTypeIdentifier(value);
}

// ---------------------------------------------------------------------------
// Type permission resolution
// ---------------------------------------------------------------------------
/**
 * Confusable pair: this takes a LIST of patterns; `typeMatchesPattern` in
 * type-patterns.ts takes ONE. The reasoning is on that one, and it applies
 * in both directions: a call that reaches the wrong function of the two
 * still returns a plausible boolean, and both are read by permission checks.
 */

/**
 * Returns true if the type matches any of the given patterns. Patterns are
 * exact identifiers, subtree wildcards (`core.media.*`), or the global `*`.
 * Matching semantics live in `type-patterns.ts`.
 */
export function matchesTypePattern(type: string, patterns: string[]): boolean {
  return typeMatchesAnyPattern(type, patterns);
}

/**
 * Resolves the effective permission for a type against a permissions map.
 * Resolution order: exact match, then longest matching subtree wildcard, then
 * the global wildcard, then implicit `none`. Subtree wildcards are
 * parent-inclusive, so `core.media.*` also resolves `core.media`.
 */
export function resolveTypePermission(
  type: string,
  permissions: Record<string, TypePermission>,
): TypePermission {
  // Exact match takes priority
  const exact = permissions[type];
  if (exact !== undefined) {
    return exact;
  }

  // Find the longest matching wildcard prefix
  let bestMatch: TypePermission | undefined;
  let bestLength = 0;

  for (const [pattern, permission] of Object.entries(permissions)) {
    if (pattern === GLOBAL_TYPE_WILDCARD) {
      // Global wildcard — use only if nothing more specific matches
      if (bestLength === 0) {
        bestMatch = permission;
      }
      continue;
    }

    // The root is what ranks two matching wildcards; whether the pattern
    // matches at all is `typeMatchesPattern`'s question and is asked of it.
    // Written out here, the parent-inclusion rule was a second copy of a rule
    // that already has one home, and `type-patterns.ts` records what it costs
    // when two copies of a matching rule disagree.
    const root = subtreeWildcardRoot(pattern);
    if (root === null) continue;
    if (!typeMatchesPattern(type, pattern)) continue;
    if (root.length > bestLength) {
      bestMatch = permission;
      bestLength = root.length;
    }
  }

  return bestMatch ?? "none";
}

// ---------------------------------------------------------------------------
// Extension permission resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the effective permission for an extension namespace.
 * Checks: exact match → wildcard "*" → implicit own-namespace write → "none".
 */
export function resolveExtensionPermission(
  namespace: string,
  permissions:
    Record<string, import("./types.js").ExtensionPermission> | undefined,
  keyLabel: string,
): import("./types.js").ExtensionPermission | "none" {
  if (permissions) {
    // Exact namespace match
    const exact = permissions[namespace];
    if (exact) return exact;
    // Wildcard
    const wildcard = permissions["*"];
    if (wildcard) return wildcard;
  }
  // Implicit: keys can always write their own namespace (matching key label)
  if (namespace === keyLabel) return "write";
  return "none";
}

/**
 * Filters extension namespaces to the ones the requesting credential's
 * extension permissions reach, plus its own label's namespace.
 *
 * There is no privileged reader: one permission model has no rank that sees
 * everything.
 */
export function filterExtensionsByPermission(
  extensions: Record<string, Record<string, unknown>>,
  permissions:
    Record<string, import("./types.js").ExtensionPermission> | undefined,
  keyLabel: string,
): Record<string, Record<string, unknown>> {
  const filtered: Record<string, Record<string, unknown>> = {};
  for (const [ns, data] of Object.entries(extensions)) {
    const perm = resolveExtensionPermission(ns, permissions, keyLabel);
    if (perm !== "none") {
      filtered[ns] = data;
    }
  }
  return filtered;
}

/**
 * True when the runtime's own zone database resolves `value` as an IANA zone.
 *
 * Asking Intl is the check rather than matching a pattern against a list,
 * because the question is whether *this* runtime can render an instant in the
 * zone. A name that looks well-formed but does not resolve fails far from the
 * write that accepted it: every read that formats a date in it throws.
 *
 * Two things Intl accepts are refused here. A bare offset (`+02:00`,
 * `Etc/GMT+2`) keeps no wall clock across a daylight-saving change, which is
 * the whole reason an account states a zone rather than an offset. And a
 * miscased spelling (`europe/berlin`) resolves fine but makes two strings
 * name one zone, so a later equality test against a stored series zone
 * silently disagrees.
 *
 * Aliases are deliberately accepted as written. `Asia/Kolkata` and
 * `Europe/Kyiv` are what upstream calendars send, and this runtime's ICU
 * canonicalizes them to `Asia/Calcutta` and `Europe/Kiev`. Storing the
 * canonical form would hand a user back a zone name they did not choose and
 * would round-trip a different string than the one a connector wrote.
 */
export function isValidTimeZone(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value === "UTC") return true;
  // `Region/City`, optionally with a further segment (`America/Argentina/
  // Salta`). Leading capital per segment is what excludes the miscased forms.
  if (!/^[A-Z][A-Za-z_-]*(\/[A-Z][A-Za-z0-9_+-]*)+$/.test(value)) return false;
  // `Etc/GMT+5` passes the shape test and is an offset, not a zone.
  if (value.startsWith("Etc/GMT")) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
