import type {
  AncestorUnavailableResponse,
  ConflictResponse,
  ConflictSnapshot,
  Item,
  MergePolicy,
  MergeStrategy,
  Tier,
} from "@withmarfa/shared";
import type { HttpTransport } from "./transport.js";
import { AncestorUnavailableError, ConflictError } from "./errors.js";

/**
 * Conflict resolution strategy for item updates.
 *
 * - `"auto"` (default): the server resolves, inside the transaction that
 *   performs the update, by the type's policy. `last_writer_wins` fields take
 *   this write's value; `keep_both_copies` fields leave the server's value on
 *   the item and the losing value lands on a sibling tagged `conflicted-copy`,
 *   written in the same transaction. The kit does not merge, does not create
 *   the sibling and does not retry.
 * - `"manual"`: throws a `ConflictError` with both versions and the list of
 *   conflicting fields. The caller decides how to resolve.
 * - `"callback"`: calls a custom `ConflictResolver` with the conflict data.
 *   The resolver returns the merged properties to submit, and the kit retries.
 */
export type ConflictStrategy = "auto" | "manual" | "callback";

export interface ConflictData {
  current: ConflictSnapshot;
  ancestor: ConflictSnapshot;
  conflictingFields: string[];
  clientPatch: Record<string, unknown>;
  /** Resolved per-field merge policy for the conflicting item's type. */
  mergePolicy: MergePolicy;
}

export type ConflictResolver = (
  conflict: ConflictData,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

/**
 * What the server did, surfaced so an app can present an accurate affordance
 * ("your edit was saved as a conflicted copy").
 *
 * - `itemId` — the item that was updated.
 * - `mergedItemId` — the same id; kept so listeners that care about identity
 *   in event streams have a stable field.
 * - `conflictedCopyId` — the sibling carrying the losing values, when any
 *   field kept both. Read from the server's report: no route says what a
 *   write created, so this is the only thing that names it.
 * - `fields` — the fields that collided.
 * - `strategy` — keyed by field name, the strategy applied to each.
 */
export interface ConflictAutoMergedEvent {
  itemId: string;
  mergedItemId: string;
  conflictedCopyId?: string;
  fields: string[];
  strategy: Record<string, MergeStrategy>;
}

/** Optional callback fired when the server reports a resolved conflict. */
export type ConflictAutoMergeListener = (
  event: ConflictAutoMergedEvent,
) => void | Promise<void>;

const MAX_RETRIES = 3;

function isConflictResponse(body: unknown): body is ConflictResponse {
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    "current" in body &&
    "conflicting_fields" in body
  );
}

/** The refusal for a base version whose snapshot the server no longer holds. */
function isAncestorUnavailable(
  body: unknown,
): body is AncestorUnavailableResponse {
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    (body as { error?: { code?: string } }).error?.code ===
      "ancestor_unavailable"
  );
}

function toConflictError(
  response: ConflictResponse,
  clientPatch: Record<string, unknown>,
): ConflictError {
  return new ConflictError(
    response.current,
    response.ancestor,
    response.conflicting_fields,
    clientPatch,
  );
}

/** The response shape an update answers with, resolved or not. */
interface UpdateSuccess {
  item: Item;
  metadata: unknown;
  conflict_resolution?: {
    fields: string[];
    strategy: Record<string, MergeStrategy>;
    conflicted_copy_id?: string;
  };
}

export async function handleConflictUpdate(
  transport: HttpTransport,
  itemId: string,
  clientPatch: Record<string, unknown>,
  version: number,
  strategy: ConflictStrategy,
  resolver?: ConflictResolver,
  tier?: Tier,
  onAutoMerge?: ConflictAutoMergeListener,
  sourceId?: string,
): Promise<Item> {
  let properties = clientPatch;
  let currentVersion = version;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await transport.requestWithConflict<UpdateSuccess>(
      "PATCH",
      `/items/${itemId}`,
      {
        // `auto` is the whole of the kit's part in resolution: it says who
        // resolves, and the server does the rest. `manual` and `callback`
        // send nothing, so they receive the envelope.
        ...(strategy === "auto" && { query: { conflict: "auto" } }),
        body: {
          properties,
          version: currentVersion,
          ...(tier !== undefined && { tier }),
          ...(sourceId !== undefined && { source_id: sourceId }),
        },
      },
    );

    if (!isConflictResponse(result) && !isAncestorUnavailable(result)) {
      const report = result.conflict_resolution;
      if (report && onAutoMerge) {
        await onAutoMerge({
          itemId,
          mergedItemId: itemId,
          ...(report.conflicted_copy_id !== undefined && {
            conflictedCopyId: report.conflicted_copy_id,
          }),
          fields: report.fields,
          strategy: report.strategy,
        });
      }
      return result.item;
    }

    // Never merged, by any strategy: with no ancestor there is nothing to
    // merge against, and resolving anyway spawns siblings holding text the
    // person never typed. The caller has to re-read and re-apply.
    if (isAncestorUnavailable(result)) {
      throw new AncestorUnavailableError(
        result.current,
        result.requested_version,
        result.error.message,
      );
    }

    // `auto` no longer loops. The server either resolved the collision or
    // told us it could not, and re-sending the same write cannot change
    // which — so a retry here would be a second write for no reason.
    if (strategy === "auto" || strategy === "manual") {
      throw toConflictError(result, clientPatch);
    }

    if (attempt === MAX_RETRIES || !resolver) {
      throw toConflictError(result, clientPatch);
    }

    properties = await resolver({
      current: result.current,
      ancestor: result.ancestor,
      conflictingFields: result.conflicting_fields,
      clientPatch,
      mergePolicy: result.merge_policy,
    });
    currentVersion = result.current.version;
  }

  // Unreachable — the loop always returns or throws.
  throw new ConflictError(
    { version: 0, properties: {} },
    { version: 0, properties: {} },
    [],
    clientPatch,
  );
}
