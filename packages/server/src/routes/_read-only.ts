import type { Item, ReadItem } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";

/**
 * The rows with `read_only` as the connector registrations say now, read
 * once for the whole page.
 */
export async function withReadOnly<T extends Item>(
  storage: Storage,
  rows: readonly T[],
): Promise<(T & Pick<ReadItem, "read_only">)[]> {
  if (rows.length === 0) return [];
  const held = await storage.connectors.readOnly();
  return rows.map((row) => ({ ...row, read_only: held(row) }));
}

/** One row with `read_only`, as `withReadOnly` gives a page. */
export async function oneWithReadOnly<T extends Item>(
  storage: Storage,
  row: T,
): Promise<T & Pick<ReadItem, "read_only">> {
  const held = await storage.connectors.readOnly();
  return { ...row, read_only: held(row) };
}
