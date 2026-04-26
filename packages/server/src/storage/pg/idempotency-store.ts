import { and, eq, lte } from "drizzle-orm";
import type {
  IdempotencyEntry,
  IdempotencyStore,
} from "../interface.js";
import { idempotencyKeys } from "./schema.js";
import type { PgDb } from "./connection.js";

export class PgIdempotencyStore implements IdempotencyStore {
  constructor(private db: PgDb) {}

  async get(
    apiKeyId: string,
    key: string,
  ): Promise<IdempotencyEntry | null> {
    const rows = await this.db
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.api_key_id, apiKeyId),
          eq(idempotencyKeys.key, key),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    // Defensive: if the entry is past its TTL, treat it as gone. The
    // cleanup job will purge it on the next tick.
    if (Date.parse(row.expires_at) <= Date.now()) {
      return null;
    }
    return {
      api_key_id: row.api_key_id,
      key: row.key,
      request_hash: row.request_hash,
      status: row.status,
      response_body: row.response_body,
      created_at: row.created_at,
      expires_at: row.expires_at,
    };
  }

  async put(entry: IdempotencyEntry): Promise<void> {
    // First-writer-wins. If a racing handler beats us to the insert, the
    // unique index throws ON CONFLICT and we silently keep the stored
    // entry — same behaviour callers would see for a normal cache hit.
    await this.db
      .insert(idempotencyKeys)
      .values(entry)
      .onConflictDoNothing({
        target: [idempotencyKeys.api_key_id, idempotencyKeys.key],
      });
  }

  async cleanup(cutoffIso: string): Promise<number> {
    const rows = await this.db
      .delete(idempotencyKeys)
      .where(lte(idempotencyKeys.expires_at, cutoffIso))
      .returning({ key: idempotencyKeys.key });
    return rows.length;
  }
}
