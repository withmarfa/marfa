import { and, eq, inArray } from "drizzle-orm";
import { collectBlobHashes } from "../blob-utils.js";
import type { DrizzleDb } from "./connection.js";
import type { SqliteTxContext } from "./request-context.js";
import { item_blob_references } from "./schema.js";

type Executor = DrizzleDb | SqliteTxContext;

/**
 * Whether the credential a write is made for has proved it holds the bytes
 * a digest names. Null where the write is made for no credential, which
 * proves nothing.
 */
export type BlobProof = ((hash: string) => Promise<boolean>) | null;

/**
 * Make the reference index say exactly what `properties` names for this
 * item. Runs in the transaction that writes the properties, so a reader
 * never sees a row whose references disagree with it. A row's purge takes
 * its entries by the foreign key's cascade.
 *
 * A digest lends once a write that carried it was made for a credential
 * holding the proof `proof` asks for, and keeps lending for as long as the
 * row names it: a write that keeps the digest never withdraws it, and one
 * carrying it with the proof upgrades it. A write carries the digests in
 * the properties it sent, `carried`, or every one the row names when that
 * is absent; a digest the row keeps only because a merge left it in place
 * was written by someone else and gains nothing from this writer's proof.
 * `inherited` names digests that lend already wherever the row's
 * properties were copied from.
 */
export async function syncBlobReferences(
  db: Executor,
  row: { id: string; properties: Record<string, unknown> },
  proof: BlobProof,
  options: {
    carried?: ReadonlySet<string>;
    inherited?: ReadonlySet<string>;
  } = {},
): Promise<void> {
  const inherited = options.inherited ?? new Set<string>();
  const named = new Set<string>();
  collectBlobHashes(row.properties, named);
  const held = await blobLending(db, row.id);
  const gone = [...held.keys()].filter((hash) => !named.has(hash));
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
  for (const hash of named) {
    const lends = held.get(hash);
    if (lends === true) continue;
    const writes = options.carried === undefined || options.carried.has(hash);
    const proved =
      inherited.has(hash) || (writes && proof !== null && (await proof(hash)));
    if (lends === undefined) {
      await db
        .insert(item_blob_references)
        .values({ hash, item_id: row.id, lends: proved })
        .onConflictDoNothing()
        .run();
    } else if (proved) {
      await db
        .update(item_blob_references)
        .set({ lends: true })
        .where(
          and(
            eq(item_blob_references.item_id, row.id),
            eq(item_blob_references.hash, hash),
          ),
        )
        .run();
    }
  }
}

/** Each digest an item's index holds, and whether it lends. */
export async function blobLending(
  db: Executor,
  itemId: string,
): Promise<Map<string, boolean>> {
  const rows = await db
    .select({
      hash: item_blob_references.hash,
      lends: item_blob_references.lends,
    })
    .from(item_blob_references)
    .where(eq(item_blob_references.item_id, itemId))
    .all();
  return new Map(rows.map((r) => [r.hash, r.lends]));
}

/** The digests a set of properties names, as the index counts them. */
export function digestsIn(properties: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  collectBlobHashes(properties, out);
  return out;
}
