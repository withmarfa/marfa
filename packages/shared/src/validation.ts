import type { TypePermission } from "./types.js";

// ---------------------------------------------------------------------------
// Timestamp validation
// ---------------------------------------------------------------------------

// Full ISO 8601 with timezone: 2026-03-15T14:30:00Z or 2026-03-15T14:30:00+05:00
const STRICT_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

// Flexible: full datetime, date-only (2026-03-15), or month-only (2026-03)
const FLEXIBLE_TIMESTAMP =
  /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?)?)?$/;

/**
 * Returns true if the value is a valid ISO 8601 timestamp.
 * Accepts full datetime with timezone, date-only, or year-month.
 */
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

/**
 * Returns true if the value is a strict ISO 8601 timestamp with timezone.
 * Used for system fields like created_at and updated_at.
 */
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

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/** Returns true if the value is a valid URL. */
export function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Email validation
// ---------------------------------------------------------------------------

// Basic format check — not exhaustive, but catches obvious problems.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Returns true if the value looks like a valid email address. */
export function isValidEmail(value: string): boolean {
  return EMAIL.test(value);
}

// ---------------------------------------------------------------------------
// BCP 47 language code validation
// ---------------------------------------------------------------------------

// Matches primary language tag with optional subtags: en, en-US, zh-Hans, pt-BR
const BCP47 = /^[a-z]{2,3}(-[A-Za-z]{2,8})*$/;

/** Returns true if the value is a plausible BCP 47 language code. */
export function isValidLanguageCode(value: string): boolean {
  return BCP47.test(value);
}

// ---------------------------------------------------------------------------
// Type identifier validation
// ---------------------------------------------------------------------------

// Type identifiers: dot-separated segments. Min 2 segments.
// Segments: lowercase alphanumeric, underscores, hyphens. Max 128 characters.
//
// TSC42 §3 namespace grammar (enforced structurally below):
//   core.<segment>             — exactly two segments under core (subtypes
//                                permitted: core.media.book, core.entity.person)
//   system.<segment>           — exactly two segments
//   app.<app-name>.<type>      — exactly three segments (app trust separates
//                                from publisher trust; the explicit segment
//                                makes that visible)
//   user.<segment>             — exactly two segments (subtypes permitted)
//   <publisher>.<type>         — exactly two segments where first is a
//                                non-reserved-root handle
const TYPE_ID = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;

const RESERVED_ROOTS = new Set(["core", "system", "app", "user", "myme"]);

/**
 * Returns true if the value is a syntactically valid type identifier under
 * the five-tier namespace grammar. Server-side enforcement of who can
 * register `core.*` / `system.*` / `myme.*` happens separately
 * (registration time; gated by the credential's is_platform flag).
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
    case "myme":
      // Subtypes allowed: core.entity.person is valid; system.* stays at
      // two segments operationally but the grammar accepts deeper paths
      // (server-side validation rejects deeper system registrations).
      return segments.length >= 2;
    default:
      // <publisher>.<type>: exactly two segments. Publisher handles cannot
      // collide with reserved roots; see classifyNamespace.
      if (RESERVED_ROOTS.has(root)) return false;
      return segments.length === 2;
  }
}

// ---------------------------------------------------------------------------
// Type permission resolution
// ---------------------------------------------------------------------------

/**
 * Returns true if the type matches any of the given patterns.
 * Patterns can be exact matches, prefix wildcards (core.media.*), or global (*).
 */
export function matchesTypePattern(type: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === "*") return true;
    if (pattern === type) return true;
    if (pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1))) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves the effective permission for a type against a permissions map.
 * Resolution order: exact match, then longest wildcard prefix, then global
 * wildcard (*), then implicit 'none'.
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
    if (pattern === "*") {
      // Global wildcard — use only if nothing more specific matches
      if (bestLength === 0) {
        bestMatch = permission;
      }
      continue;
    }

    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -1);
      if (type.startsWith(prefix) && prefix.length > bestLength) {
        bestMatch = permission;
        bestLength = prefix.length;
      }
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
    | Record<string, import("./types.js").ExtensionPermission>
    | undefined,
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
    | Record<string, import("./types.js").ExtensionPermission>
    | undefined,
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
