/**
 * Durable mutation queue.
 *
 * Persists pending writes to the local PGlite database in the
 * `_myme_mutation_queue` table. Survives app restart. FIFO by
 * `created_at`. The drain loop pulls one mutation at a time, marks it
 * `in_flight`, sends it via `@mymehq/sdk` (with `Idempotency-Key:
 * <write_id>`), and removes it on success.
 *
 * The class is intentionally side-effect-free with respect to network
 * I/O — `enqueue` and `mark*` only touch the local DB. The drain loop
 * (in `drain.ts`) owns the network path so the two concerns can be
 * tested independently.
 */

import { uuidv7 } from "uuidv7";
import type { PGliteWithSync } from "../storage/pglite.js";
import type { MutationKind, MutationPayload } from "./mutations.js";

export interface QueueRow {
  write_id: string;
  kind: MutationKind;
  payload: string;
  target_id: string | null;
  attempt_count: number;
  last_error: string | null;
  state: "pending" | "in_flight";
  created_at: string;
  updated_at: string;
}

export interface EnqueueOptions {
  /** Identifies the affected row for cascade-drop logic. */
  targetId?: string;
}

export class MutationQueue {
  constructor(private pg: PGliteWithSync) {}

  /**
   * Append a new mutation. Generates a `write_id` (UUIDv7), persists
   * the row, returns the assigned id so callers can track it through
   * subsequent events.
   */
  async enqueue(
    mutation: MutationPayload,
    options: EnqueueOptions = {},
  ): Promise<string> {
    const writeId = uuidv7();
    const now = new Date().toISOString();
    await this.pg.query(
      `INSERT INTO _myme_mutation_queue
         (write_id, kind, payload, target_id, attempt_count, last_error, state, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 0, NULL, 'pending', $5, $5)`,
      [
        writeId,
        mutation.kind,
        JSON.stringify(mutation.payload),
        options.targetId ?? null,
        now,
      ],
    );
    return writeId;
  }

  /** Number of pending + in-flight rows. */
  async size(): Promise<number> {
    const r = await this.pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM _myme_mutation_queue`,
    );
    return r.rows[0]?.n ?? 0;
  }

  /**
   * Pull the next pending mutation in FIFO order and mark it
   * `in_flight`. Returns `null` if the queue is empty. Atomic: if two
   * drain loops race, both succeeding is acceptable — the
   * Idempotency-Key middleware on the server side guards against
   * double-execution.
   */
  async takeNext(): Promise<QueueRow | null> {
    const r = await this.pg.query<QueueRow>(
      `SELECT * FROM _myme_mutation_queue
        WHERE state = 'pending'
        ORDER BY created_at ASC
        LIMIT 1`,
    );
    const row = r.rows[0];
    if (!row) return null;
    await this.pg.query(
      `UPDATE _myme_mutation_queue
          SET state = 'in_flight', updated_at = $2
        WHERE write_id = $1`,
      [row.write_id, new Date().toISOString()],
    );
    return { ...row, state: "in_flight" };
  }

  /** Remove a successfully-drained mutation. */
  async remove(writeId: string): Promise<void> {
    await this.pg.query(
      `DELETE FROM _myme_mutation_queue WHERE write_id = $1`,
      [writeId],
    );
  }

  /**
   * Mark a mutation as failed (transient error). Increments
   * `attempt_count` and resets `state` to `pending` so the drain loop
   * can pick it up again after backoff.
   */
  async recordFailure(writeId: string, error: string): Promise<void> {
    await this.pg.query(
      `UPDATE _myme_mutation_queue
          SET attempt_count = attempt_count + 1,
              last_error = $2,
              state = 'pending',
              updated_at = $3
        WHERE write_id = $1`,
      [writeId, error, new Date().toISOString()],
    );
  }

  /**
   * Drop all mutations that target a given local id, plus the trigger
   * row itself. Used when a `createItem` fails permanently — every
   * downstream mutation referencing that id is meaningless and gets
   * cascade-dropped.
   *
   * Returns the dropped `write_id`s so the caller can emit
   * `mutation.dropped` events.
   */
  async cascadeDrop(targetId: string): Promise<string[]> {
    const rows = (await this.pg.query<{ write_id: string }>(
      `DELETE FROM _myme_mutation_queue
        WHERE target_id = $1
        RETURNING write_id`,
      [targetId],
    )).rows;
    return rows.map((r) => r.write_id);
  }

  /** All pending rows, sorted; used by tests + the drain loop's tick. */
  async listPending(limit = 100): Promise<QueueRow[]> {
    const r = await this.pg.query<QueueRow>(
      `SELECT * FROM _myme_mutation_queue
        WHERE state = 'pending'
        ORDER BY created_at ASC
        LIMIT $1`,
      [limit],
    );
    return r.rows;
  }
}
