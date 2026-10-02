import { and, eq, inArray } from "drizzle-orm";
import { collectBlobHashes } from "../blob-utils.js";
import type { DrizzleDb } from "./connection.js";
import type { SqliteTxContext } from "./request-context.js";
import { item_blob_references } from "./schema.js";

type Executor = DrizzleDb | SqliteTxContext;

/**
 * Make the reference index say exactly what `properties` names for this
 * item. Runs in the transaction that writes the properties, so a reader
 * never sees a row whose references disagree with it. A row's purge takes
 * its entries by the foreign key's cascade.
 */
export async function syncBlobReferences(
  db: Executor,
  row: { id: string; properties: Record<string, unknown> },
): Promise<void> {
  const named = new Set<string>();
  collectBlobHashes(row.properties, named);
  const held = new Set(
    (
      await db
        .select({ hash: item_blob_references.hash })
        .from(item_blob_references)
        .where(eq(item_blob_references.item_id, row.id))
        .all()
    ).map((r) => r.hash),
  );
  const gone = [...held].filter((hash) => !named.has(hash));
  const added = [...named].filter((hash) => !held.has(hash));
  if (gone.length > 0) {
    await db
      .delete(item_blob_references)
      .where(
        and(
          eq(item_blob_references.item_id, row.id),
          inArray(item_blob_references.hash, gone),
        ),
      )
      .run();
  }
  if (added.length > 0) {
    await db
      .insert(item_blob_references)
      .values(added.map((hash) => ({ hash, item_id: row.id })))
      .onConflictDoNothing()
      .run();
  }
}
