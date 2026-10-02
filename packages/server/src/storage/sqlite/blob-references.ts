import { and, eq, inArray } from "drizzle-orm";
import { collectBlobHashes } from "../blob-utils.js";
import type { DrizzleDb } from "./connection.js";
import type { SqliteTxContext } from "./request-context.js";
import { blobOrphans, item_blob_references, metadata } from "./schema.js";

type Executor = DrizzleDb | SqliteTxContext;

/**
 * Whether the credential a write is made for has proved it holds the bytes
 * a digest names. Null for a write made for no credential, which proves
 * nothing.
 */
export type BlobProof = ((hash: string) => Promise<boolean>) | null;

/**
 * Make the reference index say exactly what `properties` names for this
 * item. Runs in the transaction that writes the properties, so a reader
 * never sees a row whose references disagree with it. A row's purge takes
 * its entries by the foreign key's cascade.
 *
 * Whether a reference lends is decided once, when the digest enters the row:
 * it lends when the write that sent it was made for a credential with the
 * proof `proof` asks for. Nothing a later write does changes it while the
 * row keeps naming the digest, because every rule that let a later write
 * upgrade a reference let a credential holding the bytes vouch for a hash
 * someone else had put there. Only dropping the digest and writing it again
 * decides it afresh. `carried` names the digests the write sent, or every
 * one the row names when it is absent; a digest entering the row without
 * being sent was copied from elsewhere, and `inherited` says whether it lent
 * there.
 */
export async function syncBlobReferences(
  db: Executor,
  row: { id: string; properties: Record<string, unknown> },
  proof: BlobProof,
  options: {
    carried?: ReadonlySet<string>;
    inherited?: ReadonlyMap<string, boolean>;
  } = {},
): Promise<void> {
  const named = digestsIn(row.properties);
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
    if (held.has(hash)) continue;
    const sent = options.carried === undefined || options.carried.has(hash);
    const lends =
      options.inherited?.get(hash) ??
      (sent && proof !== null && (await proof(hash)));
    await db
      .insert(item_blob_references)
      .values({ hash, item_id: row.id, lends })
      .onConflictDoNothing()
      .run();
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

/**
 * Lift the orphan report of every blob `values` name, in the transaction
 * that adds or removes those references, so the grace before a purge
 * counts again from a report made after the change. Item properties need
 * none of this: their reference index does it by trigger. Extensions and
 * edge properties have no index, so the store that writes them passes the
 * text before and after, and the digests are found by the walk's own rule:
 * one pass over the text, then lookups by hash, whatever the report holds.
 */
export async function liftOrphanReports(
  db: Executor,
  values: readonly unknown[],
): Promise<void> {
  const named = new Set<string>();
  for (const value of values) collectBlobHashes(value, named);
  const hashes = [...named];
  // The parameter limit, not the report, bounds a statement.
  for (let i = 0; i < hashes.length; i += 500) {
    await db
      .delete(blobOrphans)
      .where(inArray(blobOrphans.hash, hashes.slice(i, i + 500)))
      .run();
  }
}

/** `liftOrphanReports` for the extensions of items about to be purged,
 *  which their metadata rows' cascade would otherwise remove unseen. */
export async function liftExtensionReportsOf(
  db: Executor,
  itemIds: readonly string[],
): Promise<void> {
  if (itemIds.length === 0) return;
  const rows = await db
    .select({ extensions: metadata.extensions })
    .from(metadata)
    .where(inArray(metadata.item_id, [...itemIds]))
    .all();
  await liftOrphanReports(
    db,
    rows.map((row) => row.extensions),
  );
}
