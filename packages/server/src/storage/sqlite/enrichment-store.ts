import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { declaredDescendantsOutsideNamespace } from "@withmarfa/shared";
import type {
  EnrichmentCandidate,
  EnrichmentStateInput,
  EnrichmentStateRecord,
  EnrichmentStore,
} from "../interface.js";
import { enrichmentState, items } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

export class SqliteEnrichmentStore implements EnrichmentStore {
  constructor(private db: DrizzleDb) {}

  async listCandidates(
    extractorVersion: number,
    maxAttempts: number,
    limit: number,
    configSignature: string,
  ): Promise<EnrichmentCandidate[]> {
    const blobRef = sql<string>`json_extract(${items.properties}, '$.blob_ref')`;
    // A file by name or by declared parent, the set `?type=core.file` lists:
    // a connector's image type is a file whatever it is called.
    const inherited = declaredDescendantsOutsideNamespace("core.file");
    const rows = await this.db
      .select({
        item_id: items.id,
        type: items.type,
        blob_ref: blobRef,
        mime_type: sql<
          string | null
        >`json_extract(${items.properties}, '$.mime_type')`,
      })
      .from(items)
      .leftJoin(enrichmentState, eq(enrichmentState.item_id, items.id))
      .where(
        and(
          or(
            sql`${items.type} = 'core.file'`,
            sql`${items.type} LIKE 'core.file.%'`,
            ...(inherited.length > 0 ? [inArray(items.type, inherited)] : []),
          ),
          // Literals, textually identical to idx_items_enrichment_queue's
          // predicate: SQLite uses a partial index only when the query
          // provably implies its predicate, and a bound parameter never does.
          sql`${items.state} <> 'trashed'`,
          sql`${blobRef} IS NOT NULL`,
          or(
            isNull(enrichmentState.item_id),
            ne(enrichmentState.blob_ref, blobRef),
            lt(enrichmentState.extractor_version, extractorVersion),
            and(
              eq(enrichmentState.status, "failed"),
              lt(enrichmentState.attempts, maxAttempts),
            ),
            // A skip is terminal only under the configuration that made
            // it.
            and(
              eq(enrichmentState.status, "skipped"),
              ne(enrichmentState.config_signature, configSignature),
            ),
          ),
        ),
      )
      // When the file arrived, not when it last changed: the column has to
      // mean "how long has this been waiting", and a tag or extension
      // write moves `updated_at`, which would push an item awaiting
      // extraction to the back of the queue on every write, without bound.
      //
      // `created_at` is immovable, which is the property that matters:
      // candidacy is decided by the enrichment-state anti-join, so a row
      // re-offered after a blob change or a version bump is reordered
      // against every other candidate by age rather than by recency, and
      // nothing a caller does can move any of them.
      .orderBy(asc(items.created_at))
      .limit(limit)
      .all();
    return rows
      .filter((r) => typeof r.blob_ref === "string" && r.blob_ref.length > 0)
      .map((r) => ({ ...r, mime_type: r.mime_type ?? "" }));
  }

  async get(itemId: string): Promise<EnrichmentStateRecord | null> {
    const row = await this.db
      .select()
      .from(enrichmentState)
      .where(eq(enrichmentState.item_id, itemId))
      .get();
    if (!row) return null;
    return {
      ...row,
      status: row.status as EnrichmentStateRecord["status"],
    };
  }

  async upsert(state: EnrichmentStateInput): Promise<void> {
    const row = {
      item_id: state.item_id,
      blob_ref: state.blob_ref,
      extractor_version: state.extractor_version,
      status: state.status,
      attempts: state.attempts,
      error: state.error ?? null,
      config_signature: state.config_signature,
      updated_at: new Date().toISOString(),
    };
    await this.db
      .insert(enrichmentState)
      .values(row)
      .onConflictDoUpdate({ target: enrichmentState.item_id, set: row })
      .run();
  }

  async delete(itemId: string): Promise<void> {
    await this.db
      .delete(enrichmentState)
      .where(eq(enrichmentState.item_id, itemId))
      .run();
  }
}
