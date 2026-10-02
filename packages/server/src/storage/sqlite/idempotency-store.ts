import { and, eq, lt } from "drizzle-orm";
import type {
  ClaimIdempotencyKeyInput,
  IdempotencyClaim,
  IdempotencyRecord,
  IdempotencyRecordState,
  IdempotencyStore,
} from "../interface.js";
import { idempotencyRecords } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

type Row = typeof idempotencyRecords.$inferSelect;

function toRecord(row: Row): IdempotencyRecord {
  return {
    id: row.id,
    credential: row.credential,
    idempotency_key: row.idempotency_key,
    fingerprint: row.fingerprint,
    state: row.state as IdempotencyRecordState,
    response_status: row.response_status,
    response_content_type: row.response_content_type,
    response_body: row.response_body,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

/** SQLite implementation. See `IdempotencyStore` for the contract. */
export class SqliteIdempotencyStore implements IdempotencyStore {
  constructor(private db: DrizzleDb) {}

  async claim(input: ClaimIdempotencyKeyInput): Promise<IdempotencyClaim> {
    const inserted = await this.db
      .insert(idempotencyRecords)
      .values({
        id: input.id,
        credential: input.credential,
        idempotency_key: input.idempotency_key,
        fingerprint: input.fingerprint,
        state: "in_flight",
        created_at: input.created_at,
      })
      .onConflictDoNothing()
      .returning({ id: idempotencyRecords.id })
      .all();
    if (inserted.length > 0) return { claimed: true };

    const held = await this.find(input.credential, input.idempotency_key);
    // The INSERT lost and the winner is already gone: a `release()` after
    // a 5xx, or the retention sweep, landing between the two statements.
    // Nobody holds the key and nobody is coming to complete it, and this
    // caller inserted nothing, so it owns no row either. Reported as its
    // own outcome rather than as a claim: saying `claimed: true` here
    // sends the caller off to run the write against a record id that does
    // not exist, `complete()` matches nothing, and the next repeat of the
    // key finds no record and writes for real.
    if (!held) return { claimed: false, held: null };
    return { claimed: false, held };
  }

  async takeOverExpiredClaim(input: {
    id: string;
    fingerprint: string;
    heldSince: string;
    now: string;
  }): Promise<boolean> {
    const won = await this.db
      .update(idempotencyRecords)
      .set({
        fingerprint: input.fingerprint,
        created_at: input.now,
        state: "in_flight",
        response_status: null,
        response_content_type: null,
        response_body: null,
        completed_at: null,
      })
      .where(
        and(
          eq(idempotencyRecords.id, input.id),
          eq(idempotencyRecords.state, "in_flight"),
          // The compare-and-swap. Two callers meeting one abandoned claim
          // read the same `created_at`; the first UPDATE moves it, so the
          // second matches nothing.
          eq(idempotencyRecords.created_at, input.heldSince),
        ),
      )
      .returning({ id: idempotencyRecords.id })
      .all();
    return won.length > 0;
  }

  async complete(input: {
    id: string;
    heldSince: string;
    response_status: number;
    response_content_type: string | null;
    response_body: string | null;
    completed_at: string;
  }): Promise<boolean> {
    // `returning` rather than a bare UPDATE: the caller has to be able to
    // tell "recorded" from "matched no row", and without it the two are
    // the same silence.
    const updated = await this.db
      .update(idempotencyRecords)
      .set({
        state: "complete",
        response_status: input.response_status,
        response_content_type: input.response_content_type,
        response_body: input.response_body,
        completed_at: input.completed_at,
      })
      // Fenced on `created_at` as well as id. A takeover swaps the row in
      // place and keeps its id, so the id names a row rather than a holder:
      // without this, a writer displaced past its lease writes over — or
      // deletes — the claim of the writer that replaced it.
      .where(
        and(
          eq(idempotencyRecords.id, input.id),
          eq(idempotencyRecords.created_at, input.heldSince),
        ),
      )
      .returning({ id: idempotencyRecords.id })
      .all();
    return updated.length > 0;
  }

  async release(id: string, heldSince: string): Promise<boolean> {
    // Fenced on `created_at` as well as id. A takeover swaps the row in
    // place and keeps its id, so the id names a row rather than a holder:
    // without this, a writer displaced past its lease writes over — or
    // deletes — the claim of the writer that replaced it.
    const deleted = await this.db
      .delete(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.id, id),
          eq(idempotencyRecords.state, "in_flight"),
          eq(idempotencyRecords.created_at, heldSince),
        ),
      )
      .returning({ id: idempotencyRecords.id })
      .all();
    return deleted.length > 0;
  }

  async cleanup(retentionHours: number): Promise<number> {
    const cutoff = new Date(
      Date.now() - retentionHours * 3_600_000,
    ).toISOString();
    const rows = await this.db
      .delete(idempotencyRecords)
      .where(lt(idempotencyRecords.created_at, cutoff))
      .returning({ id: idempotencyRecords.id })
      .all();
    return rows.length;
  }

  private async find(
    credential: string,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    const rows = await this.db
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.credential, credential),
          eq(idempotencyRecords.idempotency_key, key),
        ),
      )
      .all();
    const row = rows[0];
    return row ? toRecord(row) : null;
  }
}
