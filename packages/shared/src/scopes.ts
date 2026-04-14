import type { TypePermission } from "./types.js";

// ---------------------------------------------------------------------------
// Scope parsing
// ---------------------------------------------------------------------------

/**
 * Parsed representation of a scope string. Three shapes today:
 *   - item-type scope:  "core.note:read"  → kind undefined, typePattern="core.note"
 *   - metadata scope:   "metadata:write"  → kind undefined, typePattern="metadata"
 *   - edge scope:       "edge.parent-of:write" or "edge.*:write"
 *                       → kind="edge", edgeType="parent-of" or "*"
 *
 * The per-edge-type scope family was added in Wave 2 PR 4 commit 15 to
 * surface fine-grained edge permissions through OAuth. Mirrors the
 * `<type>:<verb>` shape used for item types.
 */
export interface ParsedScope {
  typePattern: string;
  operation: "read" | "write";
  /** "edge" for edge-typed scopes, undefined otherwise (type or metadata). */
  kind?: "edge";
  /** Present when kind === "edge"; the edge type id or "*". */
  edgeType?: string;
}

const SCOPE_RE = /^([a-z][a-z0-9_./*-]+):(read|write)$/;
// `edge.<type>:<verb>` — type can be kebab-case (parent-of, in-thread) or
// namespaced (karakeep.list-member).
const EDGE_SCOPE_RE = /^edge\.([a-z0-9_*][a-z0-9_.\-*]*):(read|write)$/;

/** Parses a scope string into its type pattern and operation. Returns null if invalid. */
export function parseScope(scope: string): ParsedScope | null {
  if (scope === "metadata:read" || scope === "metadata:write") {
    return {
      typePattern: "metadata",
      operation: scope.split(":")[1] as "read" | "write",
    };
  }
  // eslint-disable-next-line @typescript-eslint/prefer-regexp-exec -- .match returns the same captures; the regex has no /g flag
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
 * Expands wildcard scopes against a list of known type identifiers.
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

    if (parsed.typePattern.endsWith(".*")) {
      const prefix = parsed.typePattern.slice(0, -1); // "core.media."
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
    if (requiredOp === "read") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Edge-scope helpers (Wave 2 PR 4 commit 15)
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
    const current = perms[parsed.edgeType];
    if (parsed.operation === "write" || current === undefined) {
      perms[parsed.edgeType] = parsed.operation;
    }
  }
  return perms;
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
