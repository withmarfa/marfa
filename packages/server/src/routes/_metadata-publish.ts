import type { Item } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";

/**
 * The item as it stands after a metadata write, for the event payload.
 *
 * Every door that writes tags or extensions reads the item first, to
 * authorize against it, and that snapshot predates the write — including
 * the modification time the write just moved. Publishing it tells a
 * subscriber the item last changed before the change it is being told
 * about, so a client merging the frame over a read records a time the
 * server has already passed.
 *
 * Falls back to the snapshot the caller already holds if the row has
 * gone in between: a delete racing the write is not a reason to publish
 * nothing.
 */
export async function itemAfterMetadataWrite(
  storage: Storage,
  before: Item,
): Promise<Item> {
  return (await storage.items.get(before.id)) ?? before;
}
