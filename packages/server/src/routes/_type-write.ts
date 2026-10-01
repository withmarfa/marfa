import {
  getTypeSchema,
  registerTypeSchema,
  unregisterTypeSchema,
} from "@withmarfa/shared";
import type { TypeSchema } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";

/**
 * Runs a write to the type registry in one transaction, and puts back what
 * the in-process registry held for `ids` if the transaction does not commit.
 *
 * The type store moves the registry while the transaction is still open, so
 * that a write waiting for the lock sees the outcome the moment it gets it.
 * A rollback after that would leave the registry describing a type the
 * database does not hold. The snapshot is taken under the lock, so what is
 * put back is what this write found, not what an earlier writer left.
 */
export async function writeTypesInTransaction<T>(
  storage: Storage,
  ids: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const before = new Map<string, TypeSchema | undefined>();
  try {
    return await storage.runInTransaction(async () => {
      for (const id of ids) before.set(id, getTypeSchema(id));
      return await fn();
    });
  } catch (err) {
    for (const [id, schema] of before) {
      if (getTypeSchema(id) === schema) continue;
      if (schema) registerTypeSchema(schema);
      else unregisterTypeSchema(id);
    }
    throw err;
  }
}
