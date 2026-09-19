/**
 * Field-by-field comparison between a promoted item and the connector
 * mirror it was promoted from.
 *
 * Promotion forks a copy and the mirror keeps re-syncing, so the two drift
 * on purpose. This is the read that makes the drift visible; accepting a
 * field is an ordinary PATCH on your own item, so nothing here writes and
 * nothing here decides which side wins.
 */

export type ReconcileFieldState =
  "same" | "diverged" | "only_yours" | "only_mirror";

export interface ReconcileField {
  key: string;
  state: ReconcileFieldState;
  yours?: unknown;
  mirror?: unknown;
}

/**
 * Structural equality over JSON values. Property bags round-trip through
 * jsonb, so key order carries no meaning and a stringify comparison would
 * report equal values as diverged.
 */
function equalJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => equalJson(v, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((k) => k in right && equalJson(left[k], right[k]));
}

export function compareProperties(
  yours: Record<string, unknown>,
  mirror: Record<string, unknown>,
): ReconcileField[] {
  // Sorted union, so a client rendering the list gets a stable order
  // whatever order the two bags happen to serialize in.
  const keys = [
    ...new Set([...Object.keys(yours), ...Object.keys(mirror)]),
  ].sort();
  return keys.map((key) => {
    const inYours = key in yours;
    const inMirror = key in mirror;
    if (inYours && !inMirror) {
      return { key, state: "only_yours" as const, yours: yours[key] };
    }
    if (!inYours && inMirror) {
      return { key, state: "only_mirror" as const, mirror: mirror[key] };
    }
    return {
      key,
      state: equalJson(yours[key], mirror[key])
        ? ("same" as const)
        : ("diverged" as const),
      yours: yours[key],
      mirror: mirror[key],
    };
  });
}
