import { safeJsonParse } from "../json-utils.js";
import { isTier, VERSION_WRITER_KINDS } from "@withmarfa/shared";
import type {
  Item,
  ItemState,
  Metadata,
  Tier,
  Version,
  VersionWriter,
} from "@withmarfa/shared";
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
    schema_version: row.schema_version ?? 0,
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
    type: row.type,
    tier: row.tier as Tier,
    occurred_at: row.occurred_at,
    source_id: row.source_id,
    writer: rowWriter(row),
    created_at: row.created_at,
  };
}

/** The columns a writer is stored in, on a row or a snapshot. */
export interface WriterColumns {
  writer_kind: string | null;
  writer_id: string | null;
  writer_name: string | null;
}

export function writerColumns(writer: VersionWriter | null): WriterColumns {
  return {
    writer_kind: writer?.kind ?? null,
    writer_id: writer?.id ?? null,
    writer_name: writer?.name ?? null,
  };
}

/** The writer a row or a snapshot holds. A kind this build does not know
 *  cannot be stored (`items_writer_whole`), so it reads as none. */
export function rowWriter(row: WriterColumns): VersionWriter | null {
  const kind = VERSION_WRITER_KINDS.find((known) => known === row.writer_kind);
  if (kind === undefined || row.writer_id === null || row.writer_name === null)
    return null;
  return { kind, id: row.writer_id, name: row.writer_name };
}
