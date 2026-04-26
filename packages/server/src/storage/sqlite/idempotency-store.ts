import { and, eq, lte } from "drizzle-orm";
import type {
  IdempotencyEntry,
  IdempotencyStore,
} from "../interface.js";
import { idempotencyKeys } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

export class SqliteIdempotencyStore implements IdempotencyStore {
  constructor(private db: DrizzleDb) {}

  async get(
    apiKeyId: string,
    key: string,
  ): Promise<IdempotencyEntry | null> {
    const rows = this.db
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.api_key_id, apiKeyId),
          eq(idempotencyKeys.key, key),
        ),
      )
      .limit(1)
      .all();
    const row = rows[0];
    if (!row) return null;
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
    this.db
      .insert(idempotencyKeys)
      .values(entry)
      .onConflictDoNothing({
        target: [idempotencyKeys.api_key_id, idempotencyKeys.key],
      })
      .run();
  }

  async cleanup(cutoffIso: string): Promise<number> {
    const result = this.db
      .delete(idempotencyKeys)
      .where(lte(idempotencyKeys.expires_at, cutoffIso))
      .run();
    return result.changes;
  }
}
