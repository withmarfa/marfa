import type { ApiKey, Item } from "@withmarfa/shared";
import { mayReadType } from "../middleware/auth.js";
import { cascadeMark } from "../pubsub.js";
import type { Storage } from "../storage/interface.js";

/**
 * Mirrors the stream's redaction: a mark names its row only to a credential
 * that may read that row's type.
 */
export async function withCascadeMarks(
  storage: Storage,
  key: ApiKey,
  rows: Item[],
): Promise<Item[]> {
  const binned = rows.filter((row) => row.state === "trashed");
  if (binned.length === 0) return rows;
  const marks = await storage.items.cascadeMarks(binned.map((row) => row.id));
  if (marks.size === 0) return rows;
  return rows.map((row) => {
    const root = marks.get(row.id);
    return root
      ? { ...row, ...cascadeMark(root, (type) => mayReadType(key, type)) }
      : row;
  });
}
