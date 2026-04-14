import type { Item, ItemState, Metadata, Origin, Thread } from "@mymehq/shared";

/** Safely parse a JSON string, returning the fallback on error. */
export function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Convert a database row to an Item. */
export function rowToItem(row: Record<string, unknown>): Item {
  return {
    id: row.id as string,
    type: row.type as string,
    state: row.state as ItemState,
    library: Boolean(row.library),
    properties: parseJson(row.properties as string, {}),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    timestamp: row.timestamp as string,
    source: (row.source as string | null) ?? "<unknown>",
    source_id: (row.source_id as string | null) ?? undefined,
    origin: (row.origin as Origin | null) ?? "user",
    version: row.version as number,
    schema_version: (row.schema_version as number | null) ?? 1,
    device: (row.device as string | null) ?? undefined,
    parent_id: (row.parent_id as string | null) ?? null,
    thread_id: (row.thread_id as string | null) ?? null,
    capture_latitude: (row.capture_latitude as number | null) ?? undefined,
    capture_longitude: (row.capture_longitude as number | null) ?? undefined,
  };
}

/** Convert a database row to Metadata. */
export function rowToMetadata(row: Record<string, unknown>): Metadata {
  return {
    item_id: row.item_id as string,
    tags: parseJson(row.tags as string, []),
    about: parseJson(row.about as string, []),
    extensions: parseJson(row.extensions as string, {}),
  };
}

/** Convert a database row to a Thread. */
export function rowToThread(row: Record<string, unknown>): Thread {
  return {
    id: row.id as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}
