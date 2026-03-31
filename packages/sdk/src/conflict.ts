import type { ConflictResponse, ConflictSnapshot, Item } from "@myme/shared";
import type { HttpTransport } from "./transport.js";
import { ConflictError } from "./errors.js";

export type ConflictStrategy = "auto" | "manual" | "callback";

export interface ConflictData {
  current: ConflictSnapshot;
  ancestor: ConflictSnapshot;
  conflictingFields: string[];
  clientPatch: Record<string, unknown>;
}

export type ConflictResolver = (
  conflict: ConflictData,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

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

/**
 * Auto-merge: preserve non-conflicting client changes,
 * use server's current values for conflicting fields.
 */
function autoMerge(conflict: ConflictData): Record<string, unknown> {
  const merged = { ...conflict.current.properties };
  for (const [key, value] of Object.entries(conflict.clientPatch)) {
    if (!conflict.conflictingFields.includes(key)) {
      merged[key] = value;
    }
  }
  return merged;
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
  clientPatch: Record<string, unknown>,
  version: number,
  strategy: ConflictStrategy,
  resolver?: ConflictResolver,
): Promise<Item> {
  let properties = clientPatch;
  let currentVersion = version;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await transport.requestWithConflict<Item>(
      "PATCH",
      `/items/${itemId}`,
      { body: { properties, version: currentVersion } },
    );

    if (!isConflictResponse(result)) {
      return result;
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
    };

    if (strategy === "auto") {
      properties = autoMerge(conflict);
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
