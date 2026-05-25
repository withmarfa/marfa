import { safeJsonParse } from "../json-utils.js";
import type { Item, ItemState, Metadata, Tier, Version } from "@withmarfa/shared";
import type { items, metadata, versions } from "./schema.js";

type ItemRow = typeof items.$inferSelect;
type MetadataRow = typeof metadata.$inferSelect;
type VersionRow = typeof versions.$inferSelect;

export function rowToItem(row: ItemRow): Item {
  const tier =
    row.tier === "library" || row.tier === "feed"
      ? (row.tier as Tier)
      : undefined;
  return {
    id: row.id,
    type: row.type,
    state: row.state as ItemState,
    ...(tier !== undefined && { tier }),
    tenant_id: row.tenant_id ?? null,
    properties: safeJsonParse<Record<string, unknown>>(
      row.properties,
      {},
      `item ${row.id} properties`,
    ),
    created_at: row.created_at,
    updated_at: row.updated_at,
    timestamp: row.timestamp,
    version: row.version,
    source: row.source ?? "unknown",
    ...(row.source_id != null && { source_id: row.source_id }),
    schema_version: row.schema_version ?? 1,
    ...(row.device != null && { device: row.device }),
    ...(row.capture_latitude != null && {
      capture_latitude: row.capture_latitude,
    }),
    ...(row.capture_longitude != null && {
      capture_longitude: row.capture_longitude,
    }),
  };
}

export function rowToMetadata(row: MetadataRow): Metadata {
  return {
    item_id: row.item_id,
    tags: safeJsonParse<string[]>(row.tags, [], `metadata ${row.item_id} tags`),
    extensions: safeJsonParse<Record<string, Record<string, unknown>>>(
      row.extensions,
      {},
      `metadata ${row.item_id} extensions`,
    ),
  };
}

export function rowToVersion(row: VersionRow): Version {
  return {
    id: row.id,
    item_id: row.item_id,
    version: row.version,
    properties: safeJsonParse<Record<string, unknown>>(
      row.properties,
      {},
      `version ${row.id} properties`,
    ),
    created_at: row.created_at,
    ...(row.device != null && { device: row.device }),
  };
}
