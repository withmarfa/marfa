import type { TypePermission } from "./types.js";

// ---------------------------------------------------------------------------
// Scope parsing
// ---------------------------------------------------------------------------

/** Parsed representation of a scope string like "core.note:read". */
export interface ParsedScope {
  typePattern: string;
  operation: "read" | "write";
}

const SCOPE_RE = /^([a-z][a-z0-9_./*-]+):(read|write)$/;

/** Parses a scope string into its type pattern and operation. Returns null if invalid. */
export function parseScope(scope: string): ParsedScope | null {
  if (scope === "metadata:read" || scope === "metadata:write") {
    return { typePattern: "metadata", operation: scope.split(":")[1] as "read" | "write" };
  }
  const match = SCOPE_RE.exec(scope);
  if (!match) return null;
  return { typePattern: match[1]!, operation: match[2] as "read" | "write" };
}

/** Returns true if the scope string is syntactically valid. */
export function isValidScope(scope: string): boolean {
  return parseScope(scope) !== null;
}

// ---------------------------------------------------------------------------
// Wildcard expansion
// ---------------------------------------------------------------------------

/**
 * Expands wildcard scopes against a list of known type identifiers.
 * "core.work.*:read" → ["core.work:read", "core.work.book:read", ...]
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

    if (parsed.typePattern.endsWith(".*")) {
      const prefix = parsed.typePattern.slice(0, -1); // "core.work."
      for (const type of knownTypes) {
        if (type.startsWith(prefix) || type === prefix.slice(0, -1)) {
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

    // Skip metadata scopes — they don't map to type permissions
    if (parsed.typePattern === "metadata") continue;

    const current = perms[parsed.typePattern];
    // Write trumps read, never downgrade
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
    if (parsed.operation === "read" && requiredOp === "read") return true;
  }
  return false;
}
