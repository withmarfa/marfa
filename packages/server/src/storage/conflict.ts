// Field-level conflict detection for PATCH updates.
// Pure function — no database access. Called by ItemStore.update.

export interface ConflictInput {
  clientProperties: Record<string, unknown>;
  currentProperties: Record<string, unknown>;
  ancestorProperties: Record<string, unknown>;
}

export type ConflictResult =
  | { type: "no_conflict"; merged: Record<string, unknown> }
  | { type: "conflict"; conflicting_fields: string[] };

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((val, i) => deepEqual(val, b[i]));
  }

  if (typeof a === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => deepEqual(aObj[key], bObj[key]));
  }

  return false;
}

/**
 * Detects field-level conflicts between a client PATCH and the server's
 * current state, using the ancestor version as a common base.
 *
 * - Every key in clientProperties is treated as a client change (PATCH is partial).
 * - Server-changed fields are keys where current differs from ancestor.
 * - Conflicting fields are the intersection of both sets.
 * - If no conflicts: auto-merge (current + client overlay).
 * - If conflicts: return the sorted list of conflicting field names.
 */
export function detectConflict(input: ConflictInput): ConflictResult {
  const { clientProperties, currentProperties, ancestorProperties } = input;

  // Every key the client is sending is a change
  const clientChangedFields = new Set(Object.keys(clientProperties));

  // Find fields the server changed since the ancestor
  const serverChangedFields = new Set<string>();
  const allServerKeys = new Set([
    ...Object.keys(currentProperties),
    ...Object.keys(ancestorProperties),
  ]);
  for (const key of allServerKeys) {
    if (!deepEqual(currentProperties[key], ancestorProperties[key])) {
      serverChangedFields.add(key);
    }
  }

  // Conflicting = both client and server changed the same field
  const conflictingFields: string[] = [];
  for (const field of clientChangedFields) {
    if (serverChangedFields.has(field)) {
      conflictingFields.push(field);
    }
  }

  if (conflictingFields.length > 0) {
    return {
      type: "conflict",
      conflicting_fields: conflictingFields.sort(),
    };
  }

  // Auto-merge: start with current, overlay client changes
  return {
    type: "no_conflict",
    merged: { ...currentProperties, ...clientProperties },
  };
}
