import { and, eq, lt, sql } from "drizzle-orm";
import type {
  ClaimIdempotencyKeyInput,
  IdempotencyClaim,
  IdempotencyRecord,
  IdempotencyRecordState,
  IdempotencyStore,
} from "../interface.js";
import { spaceCondition } from "../space-condition.js";
import { idempotencyRecords } from "./schema.js";
import type { PgDb } from "./connection.js";

type Row = typeof idempotencyRecords.$inferSelect;

function toRecord(row: Row): IdempotencyRecord {
  return {
    id: row.id,
    space_id: row.space_id,
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

/** Postgres implementation. See `IdempotencyStore` for the contract. */
export class PgIdempotencyStore implements IdempotencyStore {
  constructor(private db: PgDb) {}

  async claim(input: ClaimIdempotencyKeyInput): Promise<IdempotencyClaim> {
    const inserted = await this.db
      .insert(idempotencyRecords)
      .values({
        id: input.id,
        space_id: input.space_id,
        idempotency_key: input.idempotency_key,
        fingerprint: input.fingerprint,
        state: "in_flight",
        created_at: input.created_at,
      })
      .onConflictDoNothing()
      .returning({ id: idempotencyRecords.id });
    if (inserted.length > 0) return { claimed: true };

    const held = await this.find(input.space_id, input.idempotency_key);
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
      .returning({ id: idempotencyRecords.id });
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
      .returning({ id: idempotencyRecords.id });
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
      .returning({ id: idempotencyRecords.id });
    return deleted.length > 0;
  }

  async cleanup(
    retentionHours: number,
    spaceId?: string | null,
  ): Promise<number> {
    const cutoff = new Date(
      Date.now() - retentionHours * 3_600_000,
    ).toISOString();
    // `spaceCondition` gives all three shapes the sweep needs: a named
    // space, the space-less bucket, and no fence at all. Spelled through
    // the helper rather than inline, which is what stopped the stores
    // disagreeing about what an absent space means.
    const where = and(
      lt(idempotencyRecords.created_at, cutoff),
      spaceCondition(idempotencyRecords.space_id, spaceId),
    );
    const rows = await this.db
      .delete(idempotencyRecords)
      .where(where)
      .returning({ id: idempotencyRecords.id });
    return rows.length;
  }

  private async find(
    spaceId: string | null,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    // Through the same COALESCE the unique index is built on, so the read
    // and the constraint agree about which rows are one key. A plain
    // `space_id = ?` would miss the null-space bucket entirely.
    const rows = await this.db
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          sql`COALESCE(${idempotencyRecords.space_id}, '') = ${spaceId ?? ""}`,
          eq(idempotencyRecords.idempotency_key, key),
        ),
      );
    const row = rows[0];
    return row ? toRecord(row) : null;
  }
}
