import { and, eq, inArray } from "drizzle-orm";
import { collectBlobHashes } from "../blob-utils.js";
import type { DrizzleDb } from "./connection.js";
import type { SqliteTxContext } from "./request-context.js";
import { item_blob_references } from "./schema.js";

type Executor = DrizzleDb | SqliteTxContext;

/**
 * Where a reference stands. `lends`: a write sending the digest proved its
 * credential held the bytes. `unproven`: a credential wrote it without that
 * proof, as a plant would be written. `unvouched`: nothing stood behind it,
 * as with a server-made write or a restored line naming no lending digests.
 */
export type Standing = "lends" | "unproven" | "unvouched";

/**
 * What a write says of a digest it sends. Null for a write made for no
 * credential, which vouches for nothing.
 */
export type BlobProof = ((hash: string) => Promise<Standing>) | null;

/**
 * Make the reference index say exactly what `properties` names for this
 * item. Runs in the transaction that writes the properties, so a reader
 * never sees a row whose references disagree with it. A row's purge takes
 * its entries by the foreign key's cascade.
 *
 * A digest new to the row takes the standing `proof` gives it when the write
 * sent it. One the row already names keeps its standing, with one
 * exception: an `unvouched` digest lends once a write sends it again with
 * the proof. An `unproven` one stays so while the row names it, whoever
 * writes the row next, because a credential holding every blob would
 * otherwise vouch for a hash someone else planted just by editing the row;
 * only dropping the digest and writing it again, with the proof, lends it.
 * A write sends the digests in `carried`, the properties it sent, or every
 * one the row names when that is absent. `inherited` gives the standing of
 * digests copied from another row.
 */
export async function syncBlobReferences(
  db: Executor,
  row: { id: string; properties: Record<string, unknown> },
  proof: BlobProof,
  options: {
    carried?: ReadonlySet<string>;
    inherited?: ReadonlyMap<string, Standing>;
  } = {},
): Promise<void> {
  const named = digestsIn(row.properties);
  const held = await blobStandings(db, row.id);
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
    const current = held.get(hash) ?? options.inherited?.get(hash);
    const sent = options.carried === undefined || options.carried.has(hash);
    let standing: Standing;
    if (current === undefined) {
      standing = sent && proof !== null ? await proof(hash) : "unvouched";
    } else if (current === "unvouched" && sent && proof !== null) {
      standing = (await proof(hash)) === "lends" ? "lends" : "unvouched";
    } else {
      standing = current;
    }
    if (!held.has(hash)) {
      await db
        .insert(item_blob_references)
        .values({ hash, item_id: row.id, standing })
        .onConflictDoNothing()
        .run();
    } else if (standing !== current) {
      await db
        .update(item_blob_references)
        .set({ standing })
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

/** Each digest an item's index holds, and where it stands. */
export async function blobStandings(
  db: Executor,
  itemId: string,
): Promise<Map<string, Standing>> {
  const rows = await db
    .select({
      hash: item_blob_references.hash,
      standing: item_blob_references.standing,
    })
    .from(item_blob_references)
    .where(eq(item_blob_references.item_id, itemId))
    .all();
  return new Map(rows.map((r) => [r.hash, r.standing]));
}

/** The digests a set of properties names, as the index counts them. */
export function digestsIn(properties: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  collectBlobHashes(properties, out);
  return out;
}
