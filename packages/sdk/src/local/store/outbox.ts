import { and, asc, eq, sql } from "drizzle-orm";
import type {
  BlockedReason,
  MutationKind,
  OutboxEntry,
  OutboxRowState,
  TargetKind,
} from "../types.js";
import type { Executor } from "./executor.js";
import { outbox } from "./schema.js";

export interface EnqueueInput {
  id: string;
  kind: MutationKind;
  targetKind: TargetKind;
  targetId: string;
  dependsOn?: string[];
  payload: Record<string, unknown>;
  baseVersion?: number | null;
  idempotencyKey: string;
  now: string;
}

interface OutboxRow {
  seq: number;
  id: string;
  kind: string;
  targetKind: string;
  targetId: string;
  dependsOn: string;
  payload: string;
  baseVersion: number | null;
  idempotencyKey: string;
  state: string;
  blockedReason: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

function toEntry(row: OutboxRow): OutboxEntry {
  return {
    seq: row.seq,
    id: row.id,
    kind: row.kind as MutationKind,
    targetKind: row.targetKind as TargetKind,
    targetId: row.targetId,
    dependsOn: JSON.parse(row.dependsOn) as string[],
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    baseVersion: row.baseVersion,
    idempotencyKey: row.idempotencyKey,
    state: row.state as OutboxRowState,
    blockedReason: row.blockedReason as BlockedReason | null,
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface OutboxLayer {
  /** Add a mutation to the queue. The caller runs this inside the same
   *  transaction as whatever else the mutation touches. */
  enqueue(input: EnqueueInput): Promise<OutboxEntry>;
  /** Everything still queued, oldest first. Pending and blocked alike:
   *  both are unsent work. */
  list(): Promise<OutboxEntry[]>;
  get(seq: number): Promise<OutboxEntry | undefined>;
  /** Queued mutations for one target, oldest first. */
  listForTarget(targetId: string): Promise<OutboxEntry[]>;
  count(): Promise<number>;
  remove(seq: number): Promise<void>;
  recordAttempt(seq: number, error: string, now: string): Promise<void>;
  block(seq: number, reason: BlockedReason, now: string): Promise<void>;
  /** Park every unsent mutation. Used when the credential is spent: the
   *  refusal belongs to the queue, not to the one write that met it. */
  blockAll(reason: BlockedReason, now: string): Promise<number>;
  /** Put one blocked mutation back in the queue and let it start its retry
   *  budget again. Whatever it was parked for: the caller has named a row,
   *  so this is a person or an app deciding about that row rather than a
   *  recovery sweeping past it. */
  retry(seq: number, now: string): Promise<void>;
  /**
   * Put back every mutation parked for one reason.
   *
   * Scoped to the reason rather than to the state, because the reasons do
   * not clear together. Recovering a credential says nothing about a
   * mutation parked for review, whose base version is gone and which meets
   * the same refusal on the very next pass — so an unscoped sweep spends a
   * request and re-parks the row on every recovery, and tells the app its
   * write is moving again when nothing has changed for it.
   */
  retryAll(reason: BlockedReason, now: string): Promise<number>;
}

export function createOutboxLayer(exec: Executor): OutboxLayer {
  const select = () =>
    exec
      .select({
        seq: outbox.seq,
        id: outbox.id,
        kind: outbox.kind,
        targetKind: outbox.targetKind,
        targetId: outbox.targetId,
        dependsOn: outbox.dependsOn,
        payload: outbox.payload,
        baseVersion: outbox.baseVersion,
        idempotencyKey: outbox.idempotencyKey,
        state: outbox.state,
        blockedReason: outbox.blockedReason,
        attempts: outbox.attempts,
        lastError: outbox.lastError,
        createdAt: outbox.createdAt,
        updatedAt: outbox.updatedAt,
      })
      .from(outbox);

  return {
    enqueue: async (input) => {
      const rows = await exec
        .insert(outbox)
        .values({
          id: input.id,
          kind: input.kind,
          targetKind: input.targetKind,
          targetId: input.targetId,
          dependsOn: JSON.stringify(input.dependsOn ?? []),
          payload: JSON.stringify(input.payload),
          baseVersion: input.baseVersion ?? null,
          idempotencyKey: input.idempotencyKey,
          state: "pending",
          attempts: 0,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning({ seq: outbox.seq });
      const seq = rows[0]?.seq;
      if (seq === undefined) {
        throw new Error("outbox insert returned no sequence number");
      }
      return {
        seq,
        id: input.id,
        kind: input.kind,
        targetKind: input.targetKind,
        targetId: input.targetId,
        dependsOn: input.dependsOn ?? [],
        payload: input.payload,
        baseVersion: input.baseVersion ?? null,
        idempotencyKey: input.idempotencyKey,
        state: "pending",
        blockedReason: null,
        attempts: 0,
        lastError: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
    },

    list: async () => (await select().orderBy(asc(outbox.seq))).map(toEntry),

    get: async (seq) => {
      const rows = await select().where(eq(outbox.seq, seq));
      const row = rows[0];
      return row === undefined ? undefined : toEntry(row);
    },

    listForTarget: async (targetId) =>
      (
        await select()
          .where(eq(outbox.targetId, targetId))
          .orderBy(asc(outbox.seq))
      ).map(toEntry),

    count: async () => {
      const rows = await exec
        .select({ total: sql<number>`count(*)` })
        .from(outbox);
      return rows[0]?.total ?? 0;
    },

    remove: async (seq) => {
      await exec.delete(outbox).where(eq(outbox.seq, seq));
    },

    recordAttempt: async (seq, error, now) => {
      await exec
        .update(outbox)
        .set({
          attempts: sql`${outbox.attempts} + 1`,
          lastError: error,
          updatedAt: now,
        })
        .where(eq(outbox.seq, seq));
    },

    block: async (seq, reason, now) => {
      await exec
        .update(outbox)
        .set({ state: "blocked", blockedReason: reason, updatedAt: now })
        .where(eq(outbox.seq, seq));
    },

    blockAll: async (reason, now) => {
      const rows = await exec
        .update(outbox)
        .set({ state: "blocked", blockedReason: reason, updatedAt: now })
        .where(eq(outbox.state, "pending"))
        .returning({ seq: outbox.seq });
      return rows.length;
    },

    retry: async (seq, now) => {
      await exec
        .update(outbox)
        .set({
          state: "pending",
          blockedReason: null,
          attempts: 0,
          updatedAt: now,
        })
        .where(and(eq(outbox.seq, seq), eq(outbox.state, "blocked")));
    },

    retryAll: async (reason, now) => {
      const rows = await exec
        .update(outbox)
        .set({
          state: "pending",
          blockedReason: null,
          attempts: 0,
          updatedAt: now,
        })
        .where(
          and(eq(outbox.state, "blocked"), eq(outbox.blockedReason, reason)),
        )
        .returning({ seq: outbox.seq });
      return rows.length;
    },
  };
}
