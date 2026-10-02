import type { ItemStore, Storage } from "./interface.js";

/**
 * The item store's write methods, which `Storage.items` does not carry.
 *
 * The one door to them, so which modules can write an item row is the set of
 * modules importing this: `writeItem`, and the exceptions
 * `item-write-census.test.ts` names. The storage's `items` is the whole store
 * at run time; the narrower type is what keeps everything else to its reads.
 */
export function itemWrites(storage: Pick<Storage, "items">): ItemStore {
  return storage.items as ItemStore;
}
