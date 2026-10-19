/**
 * The reading and the database-free refusals of an archive's line files,
 * shared by `POST /restore` and by the archive export, which asks them of its
 * own selection before it sends a byte.
 */

import {
  MarfaError,
  ErrorCode,
  isTier,
  TIERS,
  validateTransition,
  SYSTEM_DEFAULT_STATE,
  findLoneSurrogate,
  toWellFormedText,
} from "@withmarfa/shared";
import type { ItemState } from "@withmarfa/shared";
import { reservedCredentialSourcePrefix } from "../middleware/auth.js";
import {
  archiveDates,
  archiveRestoredAt,
  archiveVersions,
  archiveWriter,
} from "./restore-archive-history.js";
import { archiveLines, type ReadArchive } from "./restore-archive-read.js";
import {
  planArchiveTypes,
  type ArchiveTypeBaseline,
  type ArchiveTypeEntry,
} from "./restore-archive-types.js";

/**
 * The refusal for a line holding text that is not well-formed UTF-16 (a
 * lone surrogate) anywhere in it, in a string or a key. A restore is not a
 * way to plant text the write doors refuse. `field` is the JSON pointer into
 * the line.
 */
function wellFormedRefusal(
  file: "items" | "edges" | "types",
  id: unknown,
  line: unknown,
  index: number,
): MarfaError | null {
  const field = findLoneSurrogate(line);
  if (field === null) return null;
  const kind = file === "items" ? "item" : file === "edges" ? "edge" : "type";
  const named = toWellFormedText(String(id));
  return new MarfaError(
    ErrorCode.VALIDATION_ERROR,
    `Invalid ${kind} ${named} in ${file}.ndjson parsed row ${String(index + 1)}: ${field} holds a lone surrogate, which is not well-formed UTF-16`,
    { [`${kind}_id`]: named, row: index + 1, field },
  );
}

function archivedTypeId(entry: unknown): unknown {
  if (!isRecord(entry)) return undefined;
  const registered = entry.type ?? entry.edge_type;
  return isRecord(registered) ? registered.id : undefined;
}

export function archiveScalarRefusal(
  kind: "item" | "edge",
  row: Record<string, unknown>,
  index: number,
): MarfaError | null {
  let field: "version" | "tier";
  let expected: string;
  if (
    Object.hasOwn(row, "version") &&
    !(
      typeof row.version === "number" &&
      Number.isSafeInteger(row.version) &&
      row.version > 0
    )
  ) {
    field = "version";
    expected = "a positive safe integer";
  } else if (
    kind === "item" &&
    Object.hasOwn(row, "tier") &&
    !isTier(row.tier)
  ) {
    field = "tier";
    expected = `one of ${TIERS.join(", ")}`;
  } else {
    return null;
  }
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

/** Tags off an archived `{item, metadata}` line, defensively parsed. */
export function archiveTags(meta: unknown): string[] | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const tags = (meta as Record<string, unknown>).tags;
  if (!Array.isArray(tags)) return undefined;
  const strings = tags.filter((t): t is string => typeof t === "string");
  return strings.length > 0 ? strings : undefined;
}

/** Extensions off an archived `{item, metadata}` line, defensively parsed. */
export function archiveExtensions(
  meta: unknown,
): Record<string, Record<string, unknown>> {
  if (typeof meta !== "object" || meta === null) return {};
  const extensions = (meta as Record<string, unknown>).extensions;
  if (typeof extensions !== "object" || extensions === null) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [namespace, data] of Object.entries(extensions)) {
    // Only a restore can bring in an empty namespace: every other write takes
    // it from a route segment, which is never empty. No operation can then
    // address or delete it, so it is dropped rather than restored.
    if (namespace === "") continue;
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      out[namespace] = data as Record<string, unknown>;
    }
  }
  return out;
}

/** An `items.ndjson` line, which the restore reads defensively. */
export interface ArchivedItemLine {
  item: Record<string, unknown>;
  metadata?: unknown;
  lending_blobs?: unknown;
  lending_extensions?: unknown;
  versions?: unknown;
  writer?: unknown;
  restored_at?: unknown;
}

/** An `edges.ndjson` line. */
export interface ArchivedEdgeLine {
  edge: Record<string, unknown>;
  lending_blobs?: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One line of a line file, parsed, with its length for pacing. `value` is
 *  null for a line that does not parse or has the wrong shape, which is
 *  skipped: the exporter always emits valid JSON, so a bad line means the
 *  archive was edited by hand. */
interface ArchiveLine<T> {
  value: T | null;
  bytes: number;
}

async function* parsedLines<T>(
  path: string | undefined,
  pick: (parsed: unknown) => T | null,
): AsyncGenerator<ArchiveLine<T>> {
  for await (const line of archiveLines(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      yield { value: null, bytes: Buffer.byteLength(line) };
      continue;
    }
    yield { value: pick(parsed), bytes: Buffer.byteLength(line) };
  }
}

export function itemLines(path: string | undefined) {
  return parsedLines(path, (parsed) =>
    isRecord(parsed) && isRecord(parsed.item)
      ? (parsed as unknown as ArchivedItemLine)
      : null,
  );
}

export function edgeLines(path: string | undefined) {
  return parsedLines(path, (parsed) =>
    isRecord(parsed) && isRecord(parsed.edge)
      ? (parsed as unknown as ArchivedEdgeLine)
      : null,
  );
}

/**
 * The refusal for properties larger than any write door takes
 * (`bulkBodyCap`), answered as a write door answers a body that large. A
 * restore is not a way to plant a row the write doors would refuse.
 */
export function oversizedProperties(
  kind: "item" | "edge",
  row: Record<string, unknown>,
  index: number,
  field: string,
  properties: unknown,
  maxRowBytes: number,
): MarfaError | null {
  if (properties === undefined) return null;
  const bytes = Buffer.byteLength(JSON.stringify(properties));
  if (bytes <= maxRowBytes) return null;
  return new MarfaError(
    ErrorCode.REQUEST_TOO_LARGE,
    `Invalid ${kind} ${String(row.id)} in ${kind}s.ndjson parsed row ${String(index + 1)}: ${field} is ${String(bytes)} bytes, more than the ${String(maxRowBytes)} a write door accepts`,
    {
      [kind === "item" ? "item_id" : "edge_id"]: row.id,
      row: index + 1,
      field,
      limit_bytes: maxRowBytes,
    },
  );
}

export function restoredSource(source: unknown): string | undefined {
  if (typeof source !== "string") return undefined;
  return reservedCredentialSourcePrefix(source) === "oauth:"
    ? `restored:${source}`
    : source;
}

export function restoredProperties(
  item: Record<string, unknown>,
): Record<string, unknown> {
  const properties = (item.properties ?? {}) as Record<string, unknown>;
  return item.type === "system.connection" && properties.kind === "app"
    ? { ...properties, status: "revoked" }
    : properties;
}

/**
 * The refusals that need nothing from the database, asked of one item line.
 *
 * Asked of every line before anything is written, so a refusal is never
 * half a restore and never leaves blob bytes to take back.
 */
export function itemRefusal(
  entry: ArchivedItemLine,
  index: number,
  seenSnapshotIds: Set<string>,
  maxRowBytes: number,
): MarfaError | null {
  const { item } = entry;
  const text = wellFormedRefusal("items", item.id, entry, index);
  if (text) return text;
  archiveDates("item", item, index);
  archiveRestoredAt(item, entry.restored_at, index);
  archiveWriter(item, entry.writer, index);
  const history = archiveVersions(item, entry.versions, index, seenSnapshotIds);
  const scalar = archiveScalarRefusal("item", item, index);
  if (scalar) return scalar;
  const oversized =
    oversizedProperties(
      "item",
      item,
      index,
      "properties",
      item.properties,
      maxRowBytes,
    ) ??
    history
      .map((snapshot, at) =>
        oversizedProperties(
          "item",
          item,
          index,
          `versions.${String(at)}.properties`,
          snapshot.properties,
          maxRowBytes,
        ),
      )
      .find((refusal) => refusal !== null) ??
    null;
  if (oversized) return oversized;

  // A row in a state its type's lifecycle cannot produce is refused, the
  // question `POST /items` asks of a caller: `trashed` is a state, and not
  // one a `system.*` row can be in, and a restore that wrote it would land a
  // row nothing can purge, restore or move. Only an absent state (the
  // default) and the default itself pass without the question, since the
  // store would write whatever else the line carried. The lifecycle a type
  // has follows from its namespace, so the archive's own registrations do
  // not change the answer.
  const state = item.state;
  if (state === undefined || state === null || state === SYSTEM_DEFAULT_STATE)
    return null;
  const error = validateTransition(
    String(item.type),
    SYSTEM_DEFAULT_STATE,
    state as ItemState,
  );
  return error
    ? new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Item ${String(item.id)} of type ${String(item.type)} is recorded in a state its lifecycle cannot produce: ${error}`,
      )
    : null;
}

/** The refusals that need nothing from the database, asked of one edge line. */
export function edgeRefusal(
  line: ArchivedEdgeLine,
  index: number,
  maxRowBytes: number,
): MarfaError | null {
  const { edge } = line;
  const text = wellFormedRefusal("edges", edge.id, line, index);
  if (text) return text;
  archiveDates("edge", edge, index);
  return (
    archiveScalarRefusal("edge", edge, index) ??
    oversizedProperties(
      "edge",
      edge,
      index,
      "properties",
      edge.properties,
      maxRowBytes,
    )
  );
}

/** The registrations of `types.ndjson`, each line that parses. */
export async function archiveTypeEntries(
  path: string | undefined,
  pace?: (lineBytes: number) => Promise<void>,
): Promise<ArchiveTypeEntry[]> {
  const entries: ArchiveTypeEntry[] = [];
  for await (const line of archiveLines(path)) {
    if (pace) await pace(Buffer.byteLength(line));
    let entry: ArchiveTypeEntry;
    try {
      entry = JSON.parse(line) as ArchiveTypeEntry;
    } catch {
      // Same rule as item and edge lines.
      continue;
    }
    const text = wellFormedRefusal(
      "types",
      archivedTypeId(entry),
      entry,
      entries.length,
    );
    if (text) throw text;
    entries.push(entry);
  }
  return entries;
}

/** `pace` is awaited after each line, for a caller that hands the event
 *  loop over or stops on its own schedule. */
export async function prepareArchive(
  storage: ArchiveTypeBaseline,
  paths: ReadArchive["lineFiles"],
  maxRowBytes: number,
  pace?: (lineBytes: number) => Promise<void>,
) {
  // Everything that can refuse without writing is asked first, over the
  // whole archive, so a refused archive leaves nothing behind.
  let totalItems = 0;
  const seenSnapshotIds = new Set<string>();
  for await (const { value: entry, bytes } of itemLines(
    paths["items.ndjson"],
  )) {
    if (pace) await pace(bytes);
    if (entry === null) continue;
    const refusal = itemRefusal(
      entry,
      totalItems,
      seenSnapshotIds,
      maxRowBytes,
    );
    if (refusal) throw refusal;
    totalItems++;
  }
  seenSnapshotIds.clear();
  let totalEdges = 0;
  for await (const { value: line, bytes } of edgeLines(paths["edges.ndjson"])) {
    if (pace) await pace(bytes);
    if (line === null) continue;
    const refusal = edgeRefusal(line, totalEdges, maxRowBytes);
    if (refusal) throw refusal;
    totalEdges++;
  }
  const typePlan = await planArchiveTypes(
    storage,
    await archiveTypeEntries(paths["types.ndjson"], pace),
  );

  return { totalItems, totalEdges, typePlan };
}
