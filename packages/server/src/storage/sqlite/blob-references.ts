import { and, eq, inArray } from "drizzle-orm";
import { collectBlobHashes } from "../blob-utils.js";
import type { BlobProof } from "../interface.js";
import type { DrizzleDb } from "./connection.js";
import type { SqliteTxContext } from "./request-context.js";
import {
  blobOrphans,
  edge_blob_references,
  extension_blob_references,
  item_blob_references,
} from "./schema.js";

type Executor = DrizzleDb | SqliteTxContext;

/**
 * What a write does to the digests a row holds: those it no longer names go,
 * and those new to it are decided once, here.
 *
 * Whether a reference lends is fixed when the digest enters the row: it lends
 * when the write that sent it was made for a credential with the proof
 * `proof` asks for. Nothing a later write does changes it while the row keeps
 * naming the digest, because every rule that let a later write upgrade a
 * reference let a credential holding the bytes vouch for a hash someone else
 * had put there. Only dropping the digest and writing it again decides it
 * afresh. `carried` names the digests the write sent, or every one the row
 * names when it is absent; a digest entering the row without being sent was
 * copied from elsewhere, and `inherited` says whether it lent there.
 */
async function decideReferences(
  held: ReadonlyMap<string, boolean>,
  named: ReadonlySet<string>,
  proof: BlobProof,
  options: ReferenceOptions,
): Promise<{ gone: string[]; entering: Map<string, boolean> }> {
  const gone = [...held.keys()].filter((hash) => !named.has(hash));
  const entering = new Map<string, boolean>();
  for (const hash of named) {
    if (held.has(hash)) continue;
    const sent = options.carried === undefined || options.carried.has(hash);
    entering.set(
      hash,
      options.inherited?.get(hash) ??
        (sent && proof !== null && (await proof(hash))),
    );
  }
  return { gone, entering };
}

interface ReferenceOptions {
  carried?: ReadonlySet<string>;
  inherited?: ReadonlyMap<string, boolean>;
}

/**
 * Make the reference index say exactly what `properties` names for this
 * item. Runs in the transaction that writes the properties, so a reader
 * never sees a row whose references disagree with it. A row's purge takes
 * its entries by the foreign key's cascade.
 */
export async function syncBlobReferences(
  db: Executor,
  row: { id: string; properties: Record<string, unknown> },
  proof: BlobProof,
  options: ReferenceOptions = {},
): Promise<void> {
  const held = await blobLending(db, row.id);
  const { gone, entering } = await decideReferences(
    held,
    digestsIn(row.properties),
    proof,
    options,
  );
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
  for (const [hash, lends] of entering) {
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

/**
 * Make the reference index say exactly what this edge's `properties` name,
 * by the rule `syncBlobReferences` applies to an item's. Runs in the
 * transaction that writes the edge; the edge's removal takes its entries by
 * the foreign key's cascade.
 */
export async function syncEdgeBlobReferences(
  db: Executor,
  edge: { id: string; properties: Record<string, unknown> },
  proof: BlobProof,
  options: Pick<ReferenceOptions, "inherited"> = {},
): Promise<void> {
  const held = await edgeBlobLending(db, edge.id);
  const { gone, entering } = await decideReferences(
    held,
    digestsIn(edge.properties),
    proof,
    options,
  );
  if (gone.length > 0) {
    await db
      .delete(edge_blob_references)
      .where(
        and(
          eq(edge_blob_references.edge_id, edge.id),
          inArray(edge_blob_references.hash, gone),
        ),
      )
      .run();
  }
  for (const [hash, lends] of entering) {
    await db
      .insert(edge_blob_references)
      .values({ hash, edge_id: edge.id, lends })
      .onConflictDoNothing()
      .run();
  }
}

/** Each digest an edge's index holds, and whether it lends. */
export async function edgeBlobLending(
  db: Executor,
  edgeId: string,
): Promise<Map<string, boolean>> {
  const rows = await db
    .select({
      hash: edge_blob_references.hash,
      lends: edge_blob_references.lends,
    })
    .from(edge_blob_references)
    .where(eq(edge_blob_references.edge_id, edgeId))
    .all();
  return new Map(rows.map((r) => [r.hash, r.lends]));
}

/**
 * Make the reference index say exactly what each of `namespaces` of this
 * item's extensions names, by the rule `syncBlobReferences` applies to an
 * item's properties. A namespace `extensions` no longer holds names nothing.
 * Runs in the transaction that writes the extensions.
 */
export async function syncExtensionBlobReferences(
  db: Executor,
  itemId: string,
  extensions: Record<string, Record<string, unknown>>,
  namespaces: readonly string[],
  proofFor: (namespace: string) => BlobProof,
): Promise<void> {
  for (const namespace of namespaces) {
    const held = await extensionBlobLending(db, itemId, namespace);
    const { gone, entering } = await decideReferences(
      held,
      digestsIn(extensions[namespace] ?? {}),
      proofFor(namespace),
      {},
    );
    if (gone.length > 0) {
      await db
        .delete(extension_blob_references)
        .where(
          and(
            eq(extension_blob_references.item_id, itemId),
            eq(extension_blob_references.namespace, namespace),
            inArray(extension_blob_references.hash, gone),
          ),
        )
        .run();
    }
    for (const [hash, lends] of entering) {
      await db
        .insert(extension_blob_references)
        .values({ hash, item_id: itemId, namespace, lends })
        .onConflictDoNothing()
        .run();
    }
  }
}

async function extensionBlobLending(
  db: Executor,
  itemId: string,
  namespace: string,
): Promise<Map<string, boolean>> {
  const rows = await db
    .select({
      hash: extension_blob_references.hash,
      lends: extension_blob_references.lends,
    })
    .from(extension_blob_references)
    .where(
      and(
        eq(extension_blob_references.item_id, itemId),
        eq(extension_blob_references.namespace, namespace),
      ),
    )
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
 * counts again from a report made after the change. Item properties, edge
 * properties and extensions need none of this: their reference indexes do it
 * by trigger. A queued property patch has no index, so the store that writes
 * it passes the text, and the digests are found by the walk's own rule: one
 * pass over the text, then lookups by hash, whatever the report holds.
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
