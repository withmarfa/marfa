import { vi } from "vitest";
import type { Storage } from "../storage/interface.js";
import { sqliteRequestContext } from "../storage/sqlite/request-context.js";

export function afterBulkChunkCommit(
  storage: Storage,
  after: () => void | Promise<void>,
): () => void {
  const original = storage.runInTransaction.bind(storage);
  let observing = false;
  const spy = vi
    .spyOn(storage, "runInTransaction")
    .mockImplementation(
      async <T>(
        fn: () => T | Promise<T>,
        options?: { retainCommitHooksOnUncertain?: boolean },
      ): Promise<T> => {
        const root = !sqliteRequestContext.getStore();
        const result = await original(fn, options);
        if (root && !observing) {
          observing = true;
          try {
            await after();
          } finally {
            observing = false;
          }
        }
        return result;
      },
    );
  return () => {
    spy.mockRestore();
  };
}
