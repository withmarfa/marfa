import type {
  ConflictResponse,
  ConflictSnapshot,
  CreateItemInput,
  Item,
  MergePolicy,
  MergeStrategy,
  Tier,
} from "@mymehq/shared";
import type { HttpTransport } from "./transport.js";
import { ConflictError } from "./errors.js";

async function fetchItemType(
  transport: HttpTransport,
  itemId: string,
): Promise<string> {
  const res = await transport.request<{ item: Item }>(
    "GET",
    `/items/${itemId}`,
  );
  return res.item.type;
}

/**
 * Conflict resolution strategy for item updates.
 *
 * - `"auto"` (default): policy-aware. Per-field strategies declared on the
 *   type drive the merge. `last_writer_wins` fields take the server's value;
 *   `keep_both_copies` fields spawn a sibling item tagged `conflicted-copy`
 *   with the client's value, leaving the original at the server's value.
 *   The default for fields not listed in the policy is `last_writer_wins`.
 * - `"manual"`: Throws a `ConflictError` with both versions and the list of
 *   conflicting fields. The caller decides how to resolve.
 * - `"callback"`: Calls a custom `ConflictResolver` function with the conflict
 *   data. The resolver returns the merged properties to submit.
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
 * Notification payload emitted by the auto-merge path. Surfaces the per-field
 * outcome so callers can present an accurate UI affordance (e.g. "your edit
 * was saved as a conflicted copy").
 *
 * - `itemId` — the original item that was being updated.
 * - `mergedItemId` — the same id; included so listeners that care about
 *   identity in event streams have a stable field.
 * - `conflictedCopyId` — present when at least one `keep_both_copies` field
 *   conflicted; the id of the spawned sibling that carries the client's edit.
 * - `fields` — the list of fields that conflicted.
 * - `strategy` — keyed by field name, the strategy applied to each.
 */
export interface ConflictAutoMergedEvent {
  itemId: string;
  mergedItemId: string;
  conflictedCopyId?: string;
  fields: string[];
  strategy: Record<string, MergeStrategy>;
}

/** Optional callback fired when the auto-merge path completes successfully. */
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

function strategyFor(
  field: string,
  policy: MergePolicy | undefined,
): MergeStrategy {
  return policy?.fields?.[field] ?? policy?.default ?? "last_writer_wins";
}

/**
 * Builds the partition of conflicting fields by strategy and the merged
 * property bag the client should submit on retry. Pure — no I/O.
 */
function planAutoMerge(conflict: ConflictData): {
  merged: Record<string, unknown>;
  keepBothFields: string[];
  strategyByField: Record<string, MergeStrategy>;
} {
  const merged: Record<string, unknown> = { ...conflict.current.properties };
  const keepBothFields: string[] = [];
  const strategyByField: Record<string, MergeStrategy> = {};

  for (const [key, value] of Object.entries(conflict.clientPatch)) {
    const isConflicting = conflict.conflictingFields.includes(key);
    if (!isConflicting) {
      merged[key] = value;
      continue;
    }
    const strategy = strategyFor(key, conflict.mergePolicy);
    strategyByField[key] = strategy;
    if (strategy === "keep_both_copies") {
      keepBothFields.push(key);
    }
    // last_writer_wins fields fall through — the server's current value is
    // already in `merged`, so we do not overlay the client's stale value.
  }

  return { merged, keepBothFields, strategyByField };
}

/**
 * Spawns a sibling item carrying the client's in-flight values for the
 * keep-both fields, tagged `conflicted-copy`. Non-keep-both fields take the
 * server's current values so the sibling is a coherent copy of the item at
 * the moment of conflict.
 */
async function keepBothFlow(
  transport: HttpTransport,
  type: string,
  current: Record<string, unknown>,
  clientPatch: Record<string, unknown>,
  keepBothFields: string[],
): Promise<Item> {
  const properties: Record<string, unknown> = { ...current };
  for (const field of keepBothFields) {
    properties[field] = clientPatch[field];
  }
  const input: CreateItemInput = {
    type,
    properties,
    tags: ["conflicted-copy"],
  };
  const res = await transport.request<{ item: Item }>("POST", "/items", {
    body: input,
  });
  return res.item;
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

export async function handleConflictUpdate(
  transport: HttpTransport,
  itemId: string,
  itemType: string | undefined,
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
  let pendingAutoMergeEvent: ConflictAutoMergedEvent | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await transport.requestWithConflict<{
      item: Item;
      metadata: unknown;
    }>("PATCH", `/items/${itemId}`, {
      body: {
        properties,
        version: currentVersion,
        ...(tier !== undefined && { tier }),
        ...(sourceId !== undefined && { source_id: sourceId }),
      },
    });

    if (!isConflictResponse(result)) {
      if (pendingAutoMergeEvent && onAutoMerge) {
        await onAutoMerge(pendingAutoMergeEvent);
      }
      return result.item;
    }

    if (strategy === "manual") {
      throw toConflictError(result, clientPatch);
    }

    if (attempt === MAX_RETRIES) {
      throw toConflictError(result, clientPatch);
    }

    const conflict: ConflictData = {
      current: result.current,
      ancestor: result.ancestor,
      conflictingFields: result.conflicting_fields,
      clientPatch,
      mergePolicy: result.merge_policy,
    };

    if (strategy === "auto") {
      const plan = planAutoMerge(conflict);
      let conflictedCopyId: string | undefined;
      if (plan.keepBothFields.length > 0) {
        // When the caller skipped the upfront GET via `expectedVersion`, the
        // type wasn't pre-fetched. Pay the extra round-trip only here, on
        // the conflict path that actually needs it.
        const effectiveType =
          itemType ?? (await fetchItemType(transport, itemId));
        const sibling = await keepBothFlow(
          transport,
          effectiveType,
          result.current.properties,
          clientPatch,
          plan.keepBothFields,
        );
        conflictedCopyId = sibling.id;
      }
      properties = plan.merged;
      pendingAutoMergeEvent = {
        itemId,
        mergedItemId: itemId,
        conflictedCopyId,
        fields: conflict.conflictingFields,
        strategy: plan.strategyByField,
      };
    } else {
      if (!resolver) {
        throw toConflictError(result, clientPatch);
      }
      properties = await resolver(conflict);
    }

    currentVersion = result.current.version;
  }

  // Unreachable — the loop always returns or throws
  throw new ConflictError(
    { version: 0, properties: {} },
    { version: 0, properties: {} },
    [],
    clientPatch,
  );
}
