import {
  ErrorCode,
  isTier,
  isValidId,
  isValidTypeIdentifier,
  MarfaError,
} from "@withmarfa/shared";
import type { Version, VersionWriter } from "@withmarfa/shared";
import { archivedWriter } from "../auth/version-writer.js";
import { normalizeTimeBound } from "../storage/interface.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refusal(
  kind: "item" | "edge",
  row: Record<string, unknown>,
  index: number,
  field: string,
  expected: string,
): MarfaError {
  return new MarfaError(
    ErrorCode.VALIDATION_ERROR,
    `Invalid ${kind} ${String(row.id)} in ${kind}s.ndjson parsed row ${String(index + 1)}: ${field} must be ${expected}`,
    {
      [kind === "item" ? "item_id" : "edge_id"]: row.id,
      row: index + 1,
      field,
    },
  );
}

function instant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    normalizeTimeBound(value, "archive date");
    return true;
  } catch (err) {
    if (err instanceof MarfaError && err.code === ErrorCode.VALIDATION_ERROR) {
      return false;
    }
    throw err;
  }
}

/** Current-row dates use canonical UTC so text-based filters compare instants. */
export function archiveDates(
  kind: "item" | "edge",
  row: Record<string, unknown>,
  index: number,
): { created_at?: string; updated_at?: string } {
  const dates: { created_at?: string; updated_at?: string } = {};
  for (const field of ["created_at", "updated_at"] as const) {
    if (!Object.hasOwn(row, field)) continue;
    const value = row[field];
    if (!instant(value)) {
      throw refusal(kind, row, index, field, "a valid instant");
    }
    dates[field] = normalizeTimeBound(value, "archive date");
  }
  return dates;
}

/** `seenIds` spans the archive; version counters are unique only within an item. */
export function archiveVersions(
  item: Record<string, unknown>,
  history: unknown,
  index: number,
  seenIds: Set<string>,
): Version[] {
  if (history === undefined) return [];
  const fail = (field: string, expected: string): never => {
    throw refusal("item", item, index, field, expected);
  };
  if (!Array.isArray(history)) return fail("versions", "an array");
  const seenVersions = new Set<number>();
  return history.map((snapshot: unknown, historyIndex) => {
    const path = `versions.${String(historyIndex)}`;
    if (!record(snapshot)) return fail(path, "an object");
    const {
      id,
      item_id,
      version,
      properties,
      type,
      tier,
      occurred_at,
      source_id,
      created_at,
      writer,
    } = snapshot;
    if (typeof id !== "string" || !isValidId(id)) {
      return fail(`${path}.id`, "a valid snapshot ID");
    }
    if (seenIds.has(id)) return fail(`${path}.id`, "unique in the archive");
    if (
      typeof item_id !== "string" ||
      !isValidId(item_id) ||
      item_id !== item.id
    ) {
      return fail(`${path}.item_id`, "the enclosing item's ID");
    }
    const currentVersion = item.version ?? 1;
    if (
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      typeof currentVersion !== "number" ||
      !Number.isSafeInteger(currentVersion) ||
      version >= currentVersion
    ) {
      return fail(
        `${path}.version`,
        "a positive safe integer below the current item version",
      );
    }
    if (seenVersions.has(version))
      return fail(`${path}.version`, "unique within the item's history");
    if (!record(properties)) return fail(`${path}.properties`, "an object");
    if (typeof type !== "string" || !isValidTypeIdentifier(type))
      return fail(`${path}.type`, "a type identifier");
    if (!isTier(tier)) return fail(`${path}.tier`, "library or feed");
    if (!instant(occurred_at))
      return fail(`${path}.occurred_at`, "a valid instant");
    if (!instant(created_at))
      return fail(`${path}.created_at`, "a valid instant");
    if (source_id !== null && typeof source_id !== "string")
      return fail(`${path}.source_id`, "a string or null");
    const named = archivedWriter(writer, `${path}.writer`);
    if ("field" in named) return fail(named.field, named.expected);
    seenIds.add(id);
    seenVersions.add(version);
    return {
      id,
      item_id,
      version,
      properties,
      type,
      tier,
      occurred_at,
      source_id,
      writer: named.writer,
      created_at,
    };
  });
}

/** The writer of an archived item's current version, which its line names
 *  beside the item. */
export function archiveWriter(
  item: Record<string, unknown>,
  writer: unknown,
  index: number,
): VersionWriter | null {
  const named = archivedWriter(writer, "writer");
  if ("field" in named)
    throw refusal("item", item, index, named.field, named.expected);
  return named.writer;
}
