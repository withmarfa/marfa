/**
 * Dead-letter operator surface for the local integrations substrate.
 *
 * A dispatch that exhausts its pg-boss retry ladder lands as a
 * `state = 'failed'` row on the dispatch queue (with a copy sent to the
 * dead-letter queue, where a worker records the terminal failure as
 * `system.activity` and completes the copy). Those failed rows carry
 * everything an operator needs — the original envelope, the failure
 * output, the attempt count, and the timestamps — so the listing reads
 * pg-boss's own table rather than keeping parallel bookkeeping.
 *
 * Replay rides `boss.retry`, pg-boss's own resurrection primitive: it
 * flips exactly the named `failed` row back to `retry` and grants one
 * additional attempt, so the existing dispatch worker picks it up on its
 * next poll. The state transition is also what makes replay exactly-once:
 * a second replay of the same job finds it no longer `failed` and is
 * refused with a 409 naming the state it is actually in. A replayed job
 * that fails again returns to `failed` and can be replayed again — each
 * replay is one explicit operator act.
 *
 * Non-retryable terminal failures (a handler returning
 * `{ ok: false, retry: false }`, or a throw on redelivery) never reach
 * this surface: the supervisor records them via `recent_errors` +
 * `system.activity action_required` and the job completes normally, so
 * pg-boss's table cannot distinguish them from successes. That is
 * deliberate — they are persistent programming errors, and re-running a
 * known-permanent failure is not an operator remedy.
 */
import { sql } from "drizzle-orm";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { PgBoss } from "pg-boss";
import type { PgDb } from "../../storage/pg/connection.js";
import { QUEUE_NAME } from "./supervisor.js";

export interface DeadLetterJob {
  id: string;
  integration: string;
  connection_id: string;
  /** Message kind off the envelope: `webhook`, `schedule`, `item-event`. */
  kind: string;
  /** Failure output recorded by pg-boss when the last attempt failed. */
  reason: string;
  /** Delivery attempts consumed (retry_count + the first delivery). */
  attempts: number;
  created_at: string;
  failed_at: string | null;
}

export interface ReplayResult {
  replayed: true;
  id: string;
}

/**
 * What `/health` needs to say a dead letter exists, in one aggregate rather
 * than a listing. The count is unbounded on purpose: a listing capped at
 * twenty would report twenty when there are five hundred, and the number is
 * the thing a watcher reacts to.
 */
export interface DeadLetterSummary {
  count: number;
  /** Oldest terminal failure still unresolved, ISO 8601. */
  oldest_failed_at: string | null;
  /**
   * Which connections are affected, so the surface that says the instance is
   * degraded also says where to look. Capped, because this rides a liveness
   * response: past the cap the count is still exact and this is a sample.
   */
  connection_ids: string[];
}

export interface DeadLetterOps {
  list(limit: number): Promise<DeadLetterJob[]>;
  replay(id: string): Promise<ReplayResult>;
  summary(): Promise<DeadLetterSummary>;
}

/** How many affected connections `summary` names before it stops. */
export const SUMMARY_CONNECTION_SAMPLE = 10;

/** The SQL renders timestamps through `to_json`, which always emits ISO
 *  8601 text (driver-independent) but with Postgres's microsecond + numeric
 *  offset profile. Re-parse to the millisecond `Z` profile every other
 *  endpoint emits, so this surface matches the API's timestamp convention. */
function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return null;
}

function messageOf(node: unknown): string | null {
  if (typeof node === "object" && node !== null) {
    const message = (node as Record<string, unknown>).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return null;
}

/** pg-boss serializes a worker throw as `{ name, message, stack }`, but its
 *  own failure paths write a wrapped shape: `fail` with a non-object payload
 *  stores `{ value: <payload> }`, and the expiration / heartbeat sweeps
 *  write `{ value: { message: "job timed out" } }` literals. Read the
 *  top-level message first, then unwrap one `value` level; fall back to the
 *  raw JSON so an unusual shape is still visible. */
export function reasonFromOutput(output: unknown): string {
  const topMessage = messageOf(output);
  if (topMessage) return topMessage;
  if (typeof output === "object" && output !== null && "value" in output) {
    const value = (output as Record<string, unknown>).value;
    if (typeof value === "string" && value.length > 0) return value;
    const wrappedMessage = messageOf(value);
    if (wrappedMessage) return wrappedMessage;
  }
  if (output === null || output === undefined) return "(no failure output)";
  return JSON.stringify(output);
}

interface FailedJobRow {
  [column: string]: unknown;
  id: string;
  data: unknown;
  output: unknown;
  retry_count: number;
  created_on: unknown;
  completed_on: unknown;
}

export function createDeadLetterOps(boss: PgBoss, db: PgDb): DeadLetterOps {
  return {
    async summary(): Promise<DeadLetterSummary> {
      // One aggregate against the same predicate the listing uses. It runs on
      // the liveness path, so it counts and samples rather than materialising
      // rows: the envelope is only opened for the sample.
      const rows = await db.execute<{
        count: string | number;
        oldest: string | null;
        connection_ids: string[] | null;
      }>(
        sql`SELECT count(*) AS count,
                   to_json(min(completed_on)) #>> '{}' AS oldest,
                   (array_agg(DISTINCT data -> 'message' ->> 'connection_id')
                      FILTER (WHERE data -> 'message' ->> 'connection_id' IS NOT NULL)
                   )[1:${SUMMARY_CONNECTION_SAMPLE}] AS connection_ids
            FROM pgboss.job
            WHERE name = ${QUEUE_NAME} AND state = 'failed'`,
      );
      const row = rows[0];
      return {
        count: row ? Number(row.count) : 0,
        // Through the same normaliser the listing uses. Postgres emits
        // microseconds and a numeric offset here, and two surfaces reporting
        // the same failure in two timestamp formats is the kind of small
        // inconsistency that costs somebody an afternoon.
        oldest_failed_at: toIso(row?.oldest ?? null),
        connection_ids: row?.connection_ids ?? [],
      };
    },

    async list(limit: number): Promise<DeadLetterJob[]> {
      // `pgboss.job` is the partitioned parent; non-partitioned queues all
      // share its default partition, so the name predicate narrows via the
      // primary-key index rather than partition pruning. Failed rows stamp
      // `completed_on` when they fail, so it orders the listing.
      const rows = await db.execute<FailedJobRow>(
        sql`SELECT id, data, output, retry_count,
              to_json(created_on) #>> '{}' AS created_on,
              to_json(completed_on) #>> '{}' AS completed_on
            FROM pgboss.job
            WHERE name = ${QUEUE_NAME} AND state = 'failed'
            ORDER BY completed_on DESC NULLS LAST, created_on DESC
            LIMIT ${limit}`,
      );
      return rows.map((row) => {
        const envelope = (
          typeof row.data === "object" && row.data !== null ? row.data : {}
        ) as Record<string, unknown>;
        const message = (
          typeof envelope.message === "object" && envelope.message !== null
            ? envelope.message
            : {}
        ) as Record<string, unknown>;
        return {
          id: row.id,
          integration:
            typeof envelope.integration_name === "string"
              ? envelope.integration_name
              : "(unknown)",
          connection_id:
            typeof message.connection_id === "string"
              ? message.connection_id
              : "(unknown)",
          kind: typeof message.kind === "string" ? message.kind : "(unknown)",
          reason: reasonFromOutput(row.output),
          attempts: row.retry_count + 1,
          created_at: toIso(row.created_on) ?? "",
          failed_at: toIso(row.completed_on),
        };
      });
    },

    async replay(id: string): Promise<ReplayResult> {
      // pg-boss's declared CommandResponse type is empty, but the runtime
      // shape is `{ jobs, requested, affected }` (manager.ts
      // mapCommandResponse); `affected` counts rows the UPDATE actually
      // moved out of `failed`.
      const response = (await boss.retry(QUEUE_NAME, id)) as unknown as {
        affected?: number;
      };
      if ((response.affected ?? 0) > 0) {
        return { replayed: true, id };
      }
      const [job] = await boss.findJobs(QUEUE_NAME, { id });
      if (!job) {
        throw new MarfaError(
          ErrorCode.NOT_FOUND,
          `No dispatch job ${id} on the local runtime queue`,
        );
      }
      throw new MarfaError(
        ErrorCode.CONFLICT,
        `Job ${id} is ${job.state}, not failed — already replayed, running, or completed`,
        { state: job.state },
      );
    },
  };
}
