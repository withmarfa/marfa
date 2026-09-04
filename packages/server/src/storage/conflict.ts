// Field-level conflict detection and resolution for PATCH updates.
// Pure functions — no database access. Called by ItemStore.update, which
// applies the plan and writes any sibling inside its own transaction.

import type {
  AncestorUnavailableResponse,
  ConflictResolutionReport,
  ConflictResponse,
  Item,
  MergePolicy,
  MergeStrategy,
} from "@withmarfa/shared";
import { generateId } from "@withmarfa/shared";
import type { ResolvedItem } from "./interface.js";
import { sha256Hex } from "../utils/crypto.js";

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

// ---------------------------------------------------------------------------
// Automatic resolution
//
// The server resolves a conflict inside the update's transaction. This is the
// only implementation: the kits send `conflict=auto` and read the result, so
// two engines cannot answer one collision differently.
// ---------------------------------------------------------------------------

/** How a caller wants a colliding update resolved. */
export type ConflictMode = "auto" | "manual" | "callback";

export interface AutoMergeInput {
  clientProperties: Record<string, unknown>;
  currentProperties: Record<string, unknown>;
  ancestorProperties: Record<string, unknown>;
  conflictingFields: string[];
  policy: MergePolicy;
}

export interface AutoMergePlan {
  /** What the original row ends up holding. */
  merged: Record<string, unknown>;
  /** Conflicting fields whose losing value has to survive on a sibling. */
  keepBothFields: string[];
  /** The strategy applied to each conflicting field, for the caller's report. */
  strategyByField: Record<string, MergeStrategy>;
}

/**
 * The strategy for one field: the type's own entry, else its default, else
 * `last_writer_wins`. Mirrors what the 409 envelope tells a client, so a
 * caller reading the policy off a refusal computes what the server would.
 */
function strategyFor(field: string, policy: MergePolicy): MergeStrategy {
  return policy.fields?.[field] ?? policy.default ?? "last_writer_wins";
}

/**
 * Resolves a detected conflict by the type's policy. Pure — the sibling this
 * plan calls for is written by the caller, inside the same transaction.
 *
 * `last_writer_wins` takes the incoming write. The name is literal: of the two
 * writers, the one arriving second is the last, and it wins. Reading it the
 * other way — keeping the server's value because that writer got there first —
 * makes the strategy "first writer wins" under a name that says the opposite,
 * and silently discards the edit its author was told had been accepted.
 *
 * `keep_both_copies` leaves the server's value on the row and reports the
 * field, so the losing text lands on a sibling rather than being dropped.
 *
 * A client change that did not collide applies as it would have anyway. It is
 * measured against the ancestor for the same reason `detectConflict` measures
 * it there: a key echoed back at the value the client read is not a change,
 * and overlaying it would revert a server edit nobody asked to revert.
 */
export function planAutoMerge(input: AutoMergeInput): AutoMergePlan {
  const {
    clientProperties,
    currentProperties,
    ancestorProperties,
    conflictingFields,
    policy,
  } = input;

  const merged: Record<string, unknown> = { ...currentProperties };
  const keepBothFields: string[] = [];
  const strategyByField: Record<string, MergeStrategy> = {};
  const colliding = new Set(conflictingFields);

  for (const [key, value] of Object.entries(clientProperties)) {
    if (deepEqual(value, ancestorProperties[key])) continue;
    if (!colliding.has(key)) {
      merged[key] = value;
      continue;
    }
    const strategy = strategyFor(key, policy);
    strategyByField[key] = strategy;
    if (strategy === "keep_both_copies") {
      keepBothFields.push(key);
      continue;
    }
    merged[key] = value;
  }

  return { merged, keepBothFields: keepBothFields.sort(), strategyByField };
}

/**
 * The properties the sibling carries: the item as the server holds it, with
 * the losing writer's value for each keep-both field laid over.
 *
 * A coherent copy of the item at the moment of collision rather than a bag of
 * the conflicting fields alone, because the row has to satisfy its type — a
 * sibling holding only `body` fails the required-field check on every type
 * that requires anything else.
 */
export function conflictedSiblingProperties(input: {
  clientProperties: Record<string, unknown>;
  currentProperties: Record<string, unknown>;
  keepBothFields: string[];
}): Record<string, unknown> {
  const properties: Record<string, unknown> = { ...input.currentProperties };
  for (const field of input.keepBothFields) {
    properties[field] = input.clientProperties[field];
  }
  return properties;
}

/**
 * The id a keep-both sibling gets, derived from the item, the version the
 * losing write was based on, and the caller's idempotency key.
 *
 * Deterministic so that the same write, run twice, writes the same sibling
 * rather than a second one. The replay cache in front of the route already
 * absorbs the ordinary repeat, but it only answers for a claim that reached
 * `complete`: a request whose connection died mid-flight releases its claim,
 * and the retry then executes for real. Under a random id that retry spawns a
 * duplicate of an edit the user made once, which is the failure this exists to
 * stop -- a "conflicted copy" the person never created, sitting beside the one
 * they did.
 *
 * The base version is in the key because it is what makes two collisions on
 * one item distinct. Without it a second, genuinely different conflict under a
 * reused key would land on the first sibling's id and be swallowed.
 *
 * Shaped as a UUIDv7 because every door that accepts an id checks that shape.
 * The timestamp prefix is therefore a hash rather than a clock, which costs
 * only the time-ordering of ids nobody sorts by, and is why this is not simply
 * `generateId()` with a seed.
 */
export function conflictedSiblingId(input: {
  itemId: string;
  baseVersion: number;
  idempotencyKey: string;
}): string {
  const digest = sha256Hex(
    // Joined on a separator an id, a version and a key cannot contain, so no
    // two different triples can spell one string.
    ["conflicted-copy", input.itemId, input.baseVersion, input.idempotencyKey]
      .join("\u0000"),
  );
  const version = "7";
  // The variant nibble has to be one of 8, 9, a or b; the rest of the digest
  // carries the entropy, so folding one hex character into four values here
  // costs nothing.
  const variant = "89ab"[parseInt(digest[16] ?? "0", 16) % 4] ?? "8";
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    version + digest.slice(13, 16),
    variant + digest.slice(17, 20),
    digest.slice(20, 32),
  ].join("-");
}

// ---------------------------------------------------------------------------
// Refusal envelopes
//
// Built here rather than at each store so the two dialects cannot answer one
// situation differently. A rule enforced at one door and not its sibling is
// the defect this file exists to make impossible.
// ---------------------------------------------------------------------------

/** The enriched 409 for a stale write the caller has to resolve itself. */
export function versionConflict(
  currentVersion: number,
  currentProperties: Record<string, unknown>,
  requestedVersion: number,
  ancestorProperties: Record<string, unknown>,
  conflictingFields: string[],
  policy: MergePolicy,
): ConflictResponse {
  return {
    error: {
      code: "version_conflict",
      status: 409,
      message:
        `Version ${requestedVersion} is stale; current version is ` +
        `${currentVersion}. Conflicting fields: ` +
        `${conflictingFields.length > 0 ? conflictingFields.join(", ") : "none"}.`,
    },
    current: { version: currentVersion, properties: currentProperties },
    ancestor: { version: requestedVersion, properties: ancestorProperties },
    conflicting_fields: conflictingFields,
    merge_policy: policy,
  };
}

/** The 409 for a write whose base version can no longer be reconstructed. */
export function ancestorUnavailable(
  currentVersion: number,
  currentProperties: Record<string, unknown>,
  requestedVersion: number,
): AncestorUnavailableResponse {
  return {
    error: {
      code: "ancestor_unavailable",
      status: 409,
      message:
        `The snapshot for version ${requestedVersion} is no longer retained, ` +
        `so this write cannot be merged. Re-read the item at version ` +
        `${currentVersion} and re-apply the change.`,
    },
    current: { version: currentVersion, properties: currentProperties },
    requested_version: requestedVersion,
  };
}

/**
 * The sibling id for this write, or a fresh one when the caller sent no
 * idempotency key and there is therefore nothing to recognise a retry by.
 */
export function conflictedSiblingIdFor(
  itemId: string,
  baseVersion: number,
  input: { idempotency_key?: string },
): string {
  const key = input.idempotency_key;
  if (key === undefined || key === "") return generateId();
  return conflictedSiblingId({ itemId, baseVersion, idempotencyKey: key });
}

/** The tag a keep-both sibling carries, so an app can list them. */
export const CONFLICTED_COPY_TAG = "conflicted-copy";

/**
 * Puts the resolution report on the item the store is about to return.
 *
 * A plain spread rather than a mutation, and absent entirely when nothing was
 * resolved: a key present with `undefined` serializes to a field a client can
 * see and cannot use, which is the shape of defect this envelope work exists
 * to remove.
 */
export function attachResolution(
  item: Item,
  resolution: ConflictResolutionReport | undefined,
): ResolvedItem {
  return resolution === undefined ? item : { ...item, conflict_resolution: resolution };
}
