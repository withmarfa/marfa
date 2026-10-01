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
 * database does not hold.
 *
 * Both snapshots are taken under the lock: what the registry held when this
 * write began, and what it held when this write's work ended. The repair
 * runs after the lock is released, so an entry is put back only where the
 * registry still holds exactly what this write left; anything else is a
 * later writer's, and putting the old entry over it would undo that write.
 */
export async function writeTypesInTransaction<T>(
  storage: Storage,
  ids: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const before = new Map<string, TypeSchema | undefined>();
  const left = new Map<string, TypeSchema | undefined>();
  try {
    return await storage.runInTransaction(async () => {
      for (const id of ids) before.set(id, getTypeSchema(id));
      try {
        return await fn();
      } finally {
        for (const id of ids) left.set(id, getTypeSchema(id));
      }
    });
  } catch (err) {
    for (const [id, schema] of before) {
      const ours = left.get(id);
      if (ours === schema || getTypeSchema(id) !== ours) continue;
      if (schema) registerTypeSchema(schema);
      else unregisterTypeSchema(id);
    }
    throw err;
  }
}
