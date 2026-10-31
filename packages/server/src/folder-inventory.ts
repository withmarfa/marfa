import type { Item } from "@withmarfa/shared";
import type { Storage } from "./storage/interface.js";

export interface FolderSummary {
  id: string;
  title: string;
  created_at: string;
}

/** An item's `title` property with surrounding and repeated whitespace
 *  removed, or `fallback` when it holds no text. */
export function displayTitle(item: Item, fallback: string): string {
  const title = item.properties.title;
  return typeof title === "string" && title.trim()
    ? title.trim().replace(/\s+/g, " ")
    : fallback;
}

export function folderSummary(item: Item): FolderSummary {
  return {
    id: item.id,
    title: displayTitle(item, "Untitled folder"),
    created_at: item.created_at,
  };
}

export async function listFolders(
  storage: Storage,
  limit: number,
  cursor?: string,
) {
  const page = await storage.items.list({
    types: ["system.folder"],
    states: ["active"],
    limit,
    cursor,
  });
  return { data: page.data.map(folderSummary), next_cursor: page.next_cursor };
}
