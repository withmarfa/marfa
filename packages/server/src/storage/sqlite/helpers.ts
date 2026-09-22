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
  // Recognized against `TIERS` rather than compared to hardcoded literals.
  // The column is NOT NULL, so a value outside the union is a stored value
  // this build does not recognize: it leaves the wire as `undefined`, the
  // field being optional there, and the boot scan counts it
  // (`stored-value-scan.ts`).
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
    occurred_at: row.occurred_at,
    version: row.version,
    source: row.source ?? "unknown",
    ...(row.source_id != null && { source_id: row.source_id }),
    schema_version: row.schema_version ?? 1,
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
  };
}
