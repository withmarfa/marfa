import type { Item } from "@withmarfa/shared";
import type { Storage } from "./storage/interface.js";

export interface FolderSummary {
  id: string;
  title: string;
  created_at: string;
}

export function folderSummary(item: Item): FolderSummary {
  const title = item.properties.title;
  return {
    id: item.id,
    title:
      typeof title === "string" && title.trim()
        ? title.trim().replace(/\s+/g, " ")
        : "Untitled folder",
    created_at: item.created_at,
  };
}

export async function listFolders(
  storage: Storage,
  limit: number,
  cursor?: string,
) {
  const page = await storage.items.list({
    type: "system.folder",
    state: "active",
    limit,
    cursor,
  });
  return { data: page.data.map(folderSummary), next_cursor: page.next_cursor };
}
