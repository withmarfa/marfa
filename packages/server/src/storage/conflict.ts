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
 * - A key in clientProperties counts as a client change only when its value
 *   differs from the ancestor. The contract asks clients to send only the
 *   fields they changed, but a client that echoes an unchanged field back
 *   must not manufacture a conflict against an edit nobody made — under a
 *   keep-both merge policy that surfaces as a duplicate item holding text
 *   the user never typed, which reads as corruption.
 * - Server-changed fields are keys where current differs from ancestor.
 * - Conflicting fields are the intersection of both sets.
 * - If no conflicts: auto-merge (current + client overlay). An echoed key
 *   still rides the overlay, where it is a no-op against the value the
 *   server already holds for it — unless the server changed it, in which
 *   case the overlay must not revert that change (handled below).
 * - If conflicts: return the sorted list of conflicting field names.
 */
export function detectConflict(input: ConflictInput): ConflictResult {
  const { clientProperties, currentProperties, ancestorProperties } = input;

  // A key the client sends counts as a change only if it differs from the
  // ancestor the client read. Echoes of unchanged fields are dropped here
  // AND excluded from the merge overlay: overlaying an echoed ancestor
  // value onto a field the server has since changed would silently revert
  // the server's edit, which is the clobber this detection exists to stop.
  const clientChangedFields = new Set(
    Object.keys(clientProperties).filter(
      (key) => !deepEqual(clientProperties[key], ancestorProperties[key]),
    ),
  );

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

  // Auto-merge: start with current, overlay only the genuine client
  // changes. Spreading the whole client payload here would let an echoed
  // ancestor value overwrite a field the server changed since — the
  // silent revert this detection exists to prevent, arriving through the
  // merge instead of the conflict path.
  const merged: Record<string, unknown> = { ...currentProperties };
  for (const key of clientChangedFields) {
    merged[key] = clientProperties[key];
  }
  return {
    type: "no_conflict",
    merged,
  };
}
