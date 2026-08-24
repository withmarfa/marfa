import type { TypePermission } from "./types.js";
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
 * handle. Five of them name a namespace tier the platform defines
 * (`classifyNamespace`); `capability` names none, and is reserved for the
 * opposite reason — it is the root the OAuth capability scopes live under,
 * and reserving it is what stops a registered type ever sharing a literal
 * with a grant of administrative authority. A reserved root without a tier
 * is therefore a namespace nothing can occupy, which is the intent.
 */
export const RESERVED_ROOTS: ReadonlySet<string> = new Set([
  "core",
  "system",
  "app",
  "user",
  "marfa",
  "capability",
]);

/**
 * Reserved words for the handle namespace. Four categories:
 *   - Structural words (admin, api, support, login, ...) that would clash
 *     with operational URL slugs and pronouns.
 *   - Future-reserved namespaces (sync, auth, data) — names plausibly
 *     needed for future platform-shipped namespaces. Cheap to lock now,
 *     easy to release later if no concrete driver materializes.
 *   - Major tech companies — squatting on these would create the most
 *     likely confusion vectors for end users browsing the marketplace.
 *   - Major consumer apps and platforms — same rationale.
 *
 * The list is intentionally non-exhaustive. Domain-verified claims can
 * unlock specific entries for the legitimate owner once that flow lands.
 */
export const RESERVED_HANDLE_WORDS: ReadonlySet<string> = new Set([
  // Structural / operational
  "admin",
  "api",
  "support",
  "help",
  "docs",
  "console",
  "auth",
  "login",
  "logout",
  "signup",
  "register",
  "settings",
  "dashboard",
  "billing",
  "terms",
  "privacy",
  "about",
  "home",
  "you",
  "me",
  "we",
  "us",
  "marfa",
  // Future-reserved namespaces
  "sync",
  "data",
  // Major tech companies
  "google",
  "apple",
  "microsoft",
  "meta",
  "amazon",
  "netflix",
  "twitter",
  "x",
  "linkedin",
  "github",
  "gitlab",
  "openai",
  "anthropic",
  "mistral",
  "cohere",
  // Major consumer apps and platforms
  "obsidian",
  "notion",
  "figma",
  "linear",
  "slack",
  "discord",
  "spotify",
  "dropbox",
  "evernote",
  "todoist",
]);

/**
 * Returns true if the value matches a reserved root or a reserved
 * handle word (in either set). Callers needing a typed-error surface
 * should branch on this BEFORE calling `isValidHandle`, which
 * collapses every failure mode into a single boolean.
 */
export function isReservedHandle(value: string): boolean {
  if (typeof value !== "string") return false;
  return RESERVED_ROOTS.has(value) || RESERVED_HANDLE_WORDS.has(value);
}

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Returns true if the value is a valid handle: lowercase alphanumeric and
 * hyphens only, 3–32 characters, no leading/trailing hyphens, no consecutive
 * hyphens, not a reserved root or structural word. Comparison is
 * case-insensitive — the canonical form is lowercase; collision detection at
 * the storage layer also lowercases.
 */
export function isValidHandle(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length < 3 || value.length > 32) return false;
  if (value.includes("--")) return false;
  if (!HANDLE_RE.test(value)) return false;
  if (RESERVED_ROOTS.has(value)) return false;
  if (RESERVED_HANDLE_WORDS.has(value)) return false;
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
 * word is suffixed so it clears `isReservedHandle`.
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
 * Reserved words are **not** checked here, matching
 * `isValidTypeIdentifier`: whether a publisher may claim `google` is an
 * authorization question answered at registration, where the credential is
 * in hand. A syntactic validator that refused reserved handles would refuse
 * the platform's own integrations, which live under `marfa/`.
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
