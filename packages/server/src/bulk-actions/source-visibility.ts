import type { Item } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import type { SourceFilterSettings } from "../storage/filter-sql.js";

export async function sourceHiddenItemIds(
  storage: Storage,
  rows: ReadonlyMap<string, Item>,
  filter: SourceFilterSettings | undefined,
): Promise<Set<string>> {
  if (!filter || rows.size === 0) return new Set();
  // Absent rows keep the action's frozen-ID semantics; only existing rows can be source-hidden.
  const visible = await storage.items.getMany([...rows.keys()], {
    includeTrashed: true,
    source_filter: filter,
  });
  return new Set([...rows.keys()].filter((id) => !visible.has(id)));
}
