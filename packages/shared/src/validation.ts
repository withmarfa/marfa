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
  const parts = value.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/);
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

// Dot-delimited snake_case segments. Minimum 2 segments (namespace.name).
// Each segment: starts with letter, lowercase alphanumeric + underscores.
// Max 128 characters total.
const TYPE_ID =
  /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** Returns true if the value is a valid dot-notation type identifier. */
export function isValidTypeIdentifier(value: string): boolean {
  return value.length <= 128 && TYPE_ID.test(value);
}

// ---------------------------------------------------------------------------
// Type permission resolution
// ---------------------------------------------------------------------------

/**
 * Returns true if the type matches any of the given patterns.
 * Patterns can be exact matches, prefix wildcards (core.work.*), or global (*).
 */
export function matchesTypePattern(
  type: string,
  patterns: string[],
): boolean {
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
  if (type in permissions) {
    return permissions[type]!;
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
