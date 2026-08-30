import type { TypePermission } from "./types.js";
import { RESERVED_ROOT_NAMES } from "./scope-roots.js";
import {
  GLOBAL_TYPE_WILDCARD,
  subtreeWildcardRoot,
  typeMatchesAnyPattern,
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

// Basic format check — not exhaustive.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Returns true if the value looks like a valid email address. */
export function isValidEmail(value: string): boolean {
  return EMAIL.test(value);
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
 * First segments a publisher may never claim, in the type grammar or as a
 * handle. Five name a namespace tier the platform defines
 * (`classifyNamespace`). The rest name none, and are reserved for the
 * opposite reason — each is a root an OAuth scope family lives under, and
 * reserving it is what stops a registered type ever sharing a literal with a
 * grant. A reserved root without a tier is therefore a namespace nothing can
 * occupy, which is the intent.
 *
 * **Derived rather than typed out**, from `scope-roots.ts`. It was a hand
 * list, and every scope family that arrived needed a second edit here to be
 * protected — `capability` got one, `content` got one, and `metadata` and
 * `edge` never did, which is the hole this closes. Composing it means the
 * next family is protected by having been declared.
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
 * Returns true if the value names a reserved root, which is the whole of what
 * a handle claim is refused for.
 *
 * A handle is a namespace claim, not a URL path — it appears in a type
 * identifier, in a scope literal and on a consent screen, and no route in the
 * server is shaped like `/<handle>` — so the string's ordinary meaning is not
 * this function's business.
 *
 * **`metadata` and `edge` are refused here now, and the previous reasoning
 * for admitting them did not survive a read of the parser.** It held that
 * they head scope literals the parser resolves and are therefore ordinary
 * claimable handles. `parseScope` tries the metadata and edge matchers BEFORE
 * the type matcher, so a type registered under a claimed `metadata` handle
 * can never have its scope literal read as a type grant at all:
 * `metadata.types:write` is taken by the metadata family first, and that is
 * the scope gating `POST /types`.
 *
 * **A shipped publisher root is deliberately NOT refused here.** A handle
 * naming one is a namespace collision rather than a grammar confusion, and
 * reserving `google` while admitting `google-drive` is the half-protection
 * T-1008 removed on the operator's ruling. The collision is answered where it
 * happens, by the seed refusing to overwrite a registration it did not write,
 * rather than by a name list here.
 *
 * This stays a function rather than an inlined `RESERVED_ROOTS.has` for two
 * reasons. Callers needing a typed-error surface branch on it BEFORE
 * calling `isValidHandle`, which collapses every failure mode into a single
 * boolean; and the question a caller asks is whether a handle may be
 * claimed, which should outlive whatever currently answers it.
 */
export function isReservedHandle(value: string): boolean {
  if (typeof value !== "string") return false;
  return RESERVED_ROOTS.has(value);
}

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
 * axes drift, which is the defect this ticket is about, arriving from the
 * other direction.
 *
 * What this replaces was not a looser grammar but an escape hatch:
 * `!isValidTypeIdentifier(id) && !id.includes("-")` admitted the kebab set by
 * skipping the check entirely for anything containing a hyphen, so `"-"`,
 * `"MY-EDGE"`, `"a b-c"`, `"../-"` and `"..--.."` all registered. Naming the
 * kebab form admits the nine shipped ids without exempting everything that
 * happens to share a character with them.
 */
export function isValidEdgeTypeIdentifier(value: string): boolean {
  if (typeof value !== "string") return false;
  if (!value.includes(".")) return EDGE_KEBAB_NAME.test(value);
  return isValidTypeIdentifier(value);
}

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Returns true if the value is a valid handle: lowercase alphanumeric and
 * hyphens only, 3–32 characters, no leading/trailing hyphens, no consecutive
 * hyphens, not a reserved root. Comparison is case-insensitive — the
 * canonical form is lowercase; collision detection at the storage layer
 * also lowercases.
 */
export function isValidHandle(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length < 3 || value.length > 32) return false;
  if (value.includes("--")) return false;
  if (!HANDLE_RE.test(value)) return false;
  if (isReservedHandle(value)) return false;
  return true;
}

/**
 * Derive a syntactically valid handle base from an email address, for the
 * programmatic sign-up path (`POST /auth/sign-up/email`) where the user
 * supplies no handle of their own. The result satisfies `isValidHandle`
 * (lowercase, 3–32 chars, single hyphens, not reserved), but callers must
 * still resolve collisions at the storage layer before claiming it — this
 * is a deterministic *candidate*, not a guaranteed-free claim.
 *
 * Sanitization maps any run of non-`[a-z0-9]` characters (including
 * existing hyphens) to a single hyphen, trims leading/trailing hyphens,
 * and caps at 32 chars. A too-short or empty local part is padded to the
 * 3-char floor with a `user-` prefix; a result that lands on a reserved
 * root is suffixed so it clears `isReservedHandle`.
 */
export function deriveHandleFromEmail(email: string): string {
  const sanitize = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/g, "");

  const local = typeof email === "string" ? (email.split("@")[0] ?? "") : "";
  let base = sanitize(local);
  if (base.length < 3) base = sanitize(`user-${base}`);
  if (base.length < 3) base = "user";
  if (isReservedHandle(base)) base = sanitize(`${base}-1`);
  return base;
}

/**
 * Returns true if the value is a syntactically valid type identifier under
 * the five-tier namespace grammar. Authorization is enforced separately at
 * registration time: `core.*` / `system.*` / `marfa.*` are refused for
 * every credential, and publisher-tier registration requires the caller's
 * user to hold the publisher handle (hosted mode; platform credentials
 * exempt).
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
      // (e.g. `google.calendar.event`, `google.tasks.task`). Publisher handles
      // cannot collide with reserved roots; see classifyNamespace.
      if (RESERVED_ROOTS.has(root)) return false;
      return segments.length >= 2;
  }
}

// The name half of an integration identifier: one or more dot-joined
// segments, so a family can carry a sub-namespace the way types do.
const INTEGRATION_NAME = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/;

/**
 * Returns true if the value is a syntactically valid integration
 * identifier: `<namespace>/<name>`, for example `readwise/reader` or
 * `marfa/rss-watcher`.
 *
 * **Dots name data; the slash names an installable.** A type identifier is
 * dotted all the way down and never carries a slash; an integration is the
 * one thing a person installs, so it gets the character that says so. The
 * two grammars are deliberately separate functions rather than one loosened
 * regex, because a slash admitted into `isValidTypeIdentifier` would reach
 * every scope literal and permission-map key in the system.
 *
 * Reserved roots are **not** checked here, matching
 * `isValidTypeIdentifier`: whether a caller may publish under a given
 * handle is an authorization question answered at registration, where the
 * credential is in hand. A syntactic validator that refused reserved roots
 * would refuse the platform's own integrations, which live under `marfa/`.
 *
 * The slash is required. An earlier dot form existed while installed
 * connections were migrated onto this grammar; every stored name now carries
 * the slash, so a dotted value names a type and never an integration.
 */
export function isValidIntegrationIdentifier(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length > 128) return false;
  const slash = value.indexOf("/");
  if (slash === -1) return false;
  // Exactly one slash: the handle is a single segment, never a path.
  if (value.slice(slash + 1).includes("/")) return false;
  const handle = value.slice(0, slash);
  const name = value.slice(slash + 1);
  if (handle.length < 3 || handle.length > 32) return false;
  if (handle.includes("--")) return false;
  if (!HANDLE_RE.test(handle)) return false;
  return INTEGRATION_NAME.test(name);
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
  if (value === "*") return true;
  if (value.length > 128) return false;
  if (value.endsWith(".*")) {
    const root = value.slice(0, -2);
    return root.length > 0 && TYPE_ID_PREFIX.test(root);
  }
  return isValidTypeIdentifier(value);
}

// ---------------------------------------------------------------------------
// Type permission resolution
// ---------------------------------------------------------------------------
/**
 * Confusable pair: this takes a LIST of patterns; `typeMatchesPattern` in
 * type-patterns.ts takes ONE. See T-738 for the incident this caused.
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

    const root = subtreeWildcardRoot(pattern);
    if (root === null) continue;
    if (type !== root && !type.startsWith(`${root}.`)) continue;
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
 * Filters extension namespaces based on the requesting key's permissions.
 * Admins see everything. Members see namespaces they have read or write access to.
 */
export function filterExtensionsByPermission(
  extensions: Record<string, Record<string, unknown>>,
  permissions:
    Record<string, import("./types.js").ExtensionPermission> | undefined,
  keyLabel: string,
  isAdmin: boolean,
): Record<string, Record<string, unknown>> {
  if (isAdmin) return extensions;

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
 * would round-trip a different string than the one an integration wrote.
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
