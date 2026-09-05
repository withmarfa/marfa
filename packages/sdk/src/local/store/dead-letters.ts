import { asc, eq } from "drizzle-orm";
import type {
  DeadLetterEntry,
  DeadLetterReason,
  MutationKind,
  TargetKind,
} from "../types.js";
import type { Executor } from "./executor.js";
import { deadLetters } from "./schema.js";

export interface RecordDeadLetterInput {
  id: string;
  seq: number;
  kind: MutationKind;
  targetKind: TargetKind;
  targetId: string;
  payload: Record<string, unknown>;
  reason: DeadLetterReason;
  code: string | null;
  message: string;
  httpStatus: number | null;
  failedAt: string;
}

/**
 * The log of writes the server refused.
 *
 * A refusal is kept rather than dropped because a person typed it. The app
 * shows the row, and dismissing it is the person deciding the work is gone
 * — which is the only thing that removes it.
 */
export interface DeadLetterLayer {
  record(input: RecordDeadLetterInput): Promise<void>;
  list(): Promise<DeadLetterEntry[]>;
  count(): Promise<number>;
  /** Forget one refusal. The person has seen it and let it go. */
  dismiss(id: string): Promise<boolean>;
}

export function createDeadLetterLayer(exec: Executor): DeadLetterLayer {
  const select = () =>
    exec
      .select({
        id: deadLetters.id,
        seq: deadLetters.seq,
        kind: deadLetters.kind,
        targetKind: deadLetters.targetKind,
        targetId: deadLetters.targetId,
        payload: deadLetters.payload,
        reason: deadLetters.reason,
        code: deadLetters.code,
        message: deadLetters.message,
        httpStatus: deadLetters.httpStatus,
        failedAt: deadLetters.failedAt,
      })
      .from(deadLetters);

  return {
    record: async (input) => {
      await exec.insert(deadLetters).values({
        id: input.id,
        seq: input.seq,
        kind: input.kind,
        targetKind: input.targetKind,
        targetId: input.targetId,
        payload: JSON.stringify(input.payload),
        reason: input.reason,
        code: input.code,
        message: input.message,
        httpStatus: input.httpStatus,
        failedAt: input.failedAt,
      });
    },

    list: async () =>
      (await select().orderBy(asc(deadLetters.seq))).map((row) => ({
        id: row.id,
        seq: row.seq,
        kind: row.kind as MutationKind,
        targetKind: row.targetKind as TargetKind,
        targetId: row.targetId,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
        reason: row.reason as DeadLetterReason,
        code: row.code,
        message: row.message,
        httpStatus: row.httpStatus,
        failedAt: row.failedAt,
      })),

    count: async () => (await select()).length,

    dismiss: async (id) => {
      const removed = await exec
        .delete(deadLetters)
        .where(eq(deadLetters.id, id))
        .returning({ id: deadLetters.id });
      return removed.length > 0;
    },
  };
}
