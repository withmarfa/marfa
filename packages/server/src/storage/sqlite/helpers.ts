import { safeJsonParse } from "../json-utils.js";
import { isTier } from "@withmarfa/shared";
import type { Item, ItemState, Metadata, Version } from "@withmarfa/shared";
import type { items, metadata, versions } from "./schema.js";

/**
 * The row shape every items read produces: the stored column is SQLite's
 * binary JSONB encoding, so selects project `json(properties)` back to JSON
 * text for parsing here. A bare select of the raw column would hand this
 * parser a blob it cannot read.
 */
export type ItemRow = Omit<typeof items.$inferSelect, "properties"> & {
  properties: string;
};
type MetadataRow = typeof metadata.$inferSelect;
type VersionRow = typeof versions.$inferSelect;

export function rowToItem(row: ItemRow): Item {
  // Recognized against `TIERS` rather than compared to two hardcoded
  // literals, which is what this was. Absent stays absent: `system.*` items
  // have no tier because the dimension does not apply to them, and the
  // field is optional on the wire to model that — so `undefined` here is a
  // real answer rather than a fallback, and the boot scan excuses null on
  // this column for the same reason.
  const tier = isTier(row.tier) ? row.tier : undefined;
  return {
    id: row.id,
    type: row.type,
    state: row.state as ItemState,
    ...(tier !== undefined && { tier }),
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
