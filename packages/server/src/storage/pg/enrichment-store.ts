import { and, asc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import type {
  EnrichmentCandidate,
  EnrichmentStateInput,
  EnrichmentStateRecord,
  EnrichmentStore,
} from "../interface.js";
import { enrichmentState, items } from "./schema.js";
import type { PgDb } from "./connection.js";

export class PgEnrichmentStore implements EnrichmentStore {
  constructor(private db: PgDb) {}

  async listCandidates(
    extractorVersion: number,
    maxAttempts: number,
    limit: number,
    configSignature: string,
  ): Promise<EnrichmentCandidate[]> {
    const blobRef = sql<string>`${items.properties}->>'blob_ref'`;
    const rows = await this.db
      .select({
        item_id: items.id,
        space_id: items.space_id,
        type: items.type,
        blob_ref: blobRef,
        mime_type: sql<string | null>`${items.properties}->>'mime_type'`,
      })
      .from(items)
      .leftJoin(enrichmentState, eq(enrichmentState.item_id, items.id))
      .where(
        and(
          // Literals, not bound parameters, and textually identical to
          // idx_items_enrichment_candidates' predicate: the planner only
          // uses a partial index when the query provably implies its
          // predicate, and a bound parameter defeats the proof under a
          // generic plan.
          sql`(${items.type} = 'core.file' OR ${items.type} LIKE 'core.file.%')`,
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
            // it. IS DISTINCT FROM, so pre-column NULL rows re-offer once
            // and get stamped.
            and(
              eq(enrichmentState.status, "skipped"),
              sql`${enrichmentState.config_signature} IS DISTINCT FROM ${configSignature}`,
            ),
          ),
        ),
      )
      .orderBy(asc(items.updated_at))
      .limit(limit);
    return rows
      .filter((r) => typeof r.blob_ref === "string" && r.blob_ref.length > 0)
      .map((r) => ({ ...r, mime_type: r.mime_type ?? "" }));
  }

  async get(itemId: string): Promise<EnrichmentStateRecord | null> {
    const rows = await this.db
      .select()
      .from(enrichmentState)
      .where(eq(enrichmentState.item_id, itemId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      status: row.status as EnrichmentStateRecord["status"],
    };
  }

  async upsert(state: EnrichmentStateInput): Promise<void> {
    const row = {
      item_id: state.item_id,
      space_id: state.space_id,
      blob_ref: state.blob_ref,
      extractor_version: state.extractor_version,
      status: state.status,
      attempts: state.attempts,
      error: state.error ?? null,
      config_signature: state.config_signature ?? null,
      updated_at: new Date().toISOString(),
    };
    await this.db
      .insert(enrichmentState)
      .values(row)
      .onConflictDoUpdate({ target: enrichmentState.item_id, set: row });
  }

  async delete(itemId: string): Promise<void> {
    await this.db
      .delete(enrichmentState)
      .where(eq(enrichmentState.item_id, itemId));
  }
}
