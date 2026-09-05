/* eslint-disable no-restricted-syntax -- Not yet on the shared space
 * fence. `storage/space-condition.ts` is the one spelling of it, and
 * this store predates it; the rule covers every store so a new file is
 * covered by default, which leaves the existing ones needing a line
 * that says so. Normalizing one is a change of its own: an absent space
 * has to be read call site by call site, and reading it wrong is the
 * defect the helper exists for. Delete this line when you do. */
import { eq, and, desc, lt, or, gte, lte, isNull, like } from "drizzle-orm";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MIN_PAGE_LIMIT,
} from "../../page-limits.js";
import { createHash } from "node:crypto";
import { generateId } from "@withmarfa/shared";
import type { PaginatedResult } from "@withmarfa/shared";
import type { AuditEntry, AuditLogEntry, AuditStore } from "../interface.js";
import { encodeCursor, decodeCursor } from "../interface.js";
import { safeJsonParse } from "../json-utils.js";
import { WriteTracker } from "../write-tracker.js";
import { auditLog } from "./schema.js";
import type { PgDb } from "./connection.js";

function rowToEntry(row: typeof auditLog.$inferSelect): AuditEntry {
  const details = safeJsonParse<Record<string, unknown>>(
    row.details,
    {},
    "audit_log.details",
  );
  // client_ip is persisted alongside the rest of details (audit_log.details
  // is JSON, so no migration was needed); the typed interface lifts it back
  // to a top-level field on the read path.
  const ipRaw = details.client_ip;
  const client_ip =
    typeof ipRaw === "string" && ipRaw.length > 0 ? ipRaw : null;
  return {
    id: row.id,
    timestamp: row.timestamp,
    key_id: row.key_id ?? null,
    space_id: row.space_id ?? null,
    action: row.action,
    resource_type: row.resource_type,
    resource_id: row.resource_id ?? null,
    client_ip,
    details,
  };
}

export class PgAuditStore implements AuditStore {
  private readonly writes = new WriteTracker("audit");

  constructor(private db: PgDb) {}

  /** Fold the typed `client_ip` into the JSON `details` blob. Persisting it
   *  alongside the existing details keeps the schema stable (no migration
   *  needed) while exposing IP as a typed field on read. */
  private buildRow(entry: AuditLogEntry): typeof auditLog.$inferInsert {
    const detailsBlob: Record<string, unknown> = { ...(entry.details ?? {}) };
    if (entry.client_ip !== undefined && entry.client_ip !== null) {
      detailsBlob.client_ip = entry.client_ip;
    }
    return {
      id: generateId(),
      timestamp: new Date().toISOString(),
      key_id: entry.key_id ?? null,
      space_id: entry.space_id ?? null,
      action: entry.action,
      resource_type: entry.resource_type,
      resource_id: entry.resource_id ?? null,
      details: JSON.stringify(detailsBlob),
    };
  }

  /** Fire-and-forget. Runs under the write tracker so `drain()` can wait for
   *  it before the pool closes and so its errors are swallowed: a late write
   *  that loses the race against teardown can never surface as an unhandled
   *  rejection. Never rejects — see the interface. */
  async log(entry: AuditLogEntry): Promise<void> {
    await this.writes.track(async () => {
      // Inside the tracker, not outside it. Building the row serializes
      // `details`, which can itself fail, and a caller promised a writer
      // that never rejects must not be handed one that rejects before the
      // insert is even attempted.
      const row = this.buildRow(entry);
      await this.db.insert(auditLog).values(row);
    });
  }

  /** The propagating form. Not tracked: the caller is awaiting it, so there
   *  is nothing in flight for shutdown to find, and tracking would swallow
   *  the very failure this exists to surface. */
  async logOrThrow(entry: AuditLogEntry): Promise<void> {
    await this.db.insert(auditLog).values(this.buildRow(entry));
  }

  /** Resolve once every in-flight audit write has settled. Called by the
   *  storage's `close()` so pending fire-and-forget writes drain before the
   *  connection pool is torn down. */
  async drain(): Promise<void> {
    await this.writes.drain();
  }

  async list(filters: {
    action?: string;
    resource_type?: string;
    resource_id?: string;
    since?: string;
    until?: string;
    limit?: number;
    cursor?: string;
    space_id?: string | null;
  }): Promise<PaginatedResult<AuditEntry>> {
    const limit = Math.max(
      MIN_PAGE_LIMIT,
      Math.min(filters.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
    );
    const conditions = [];

    if (filters.action) {
      conditions.push(eq(auditLog.action, filters.action));
    }
    if (filters.resource_type) {
      conditions.push(eq(auditLog.resource_type, filters.resource_type));
    }
    if (filters.resource_id) {
      conditions.push(eq(auditLog.resource_id, filters.resource_id));
    }
    if (filters.since) {
      conditions.push(gte(auditLog.timestamp, filters.since));
    }
    if (filters.until) {
      conditions.push(lte(auditLog.timestamp, filters.until));
    }
    // Space scope. When the caller is space-scoped (filter explicitly set),
    // restrict to rows with matching `space_id`. When omitted, no space
    // filter is applied — bootstrap-admin reads on self-hosted, plus the
    // cleanup job which is currently global.
    if (filters.space_id !== undefined && filters.space_id !== null) {
      conditions.push(eq(auditLog.space_id, filters.space_id));
    }

    if (filters.cursor) {
      const { v, id } = decodeCursor(filters.cursor);
      const cursorClause = or(
        lt(auditLog.timestamp, v),
        and(eq(auditLog.timestamp, v), lt(auditLog.id, id)),
      );
      if (cursorClause) conditions.push(cursorClause);
    }

    let query = this.db
      .select()
      .from(auditLog)
      .orderBy(desc(auditLog.timestamp), desc(auditLog.id))
      .limit(limit + 1)
      .$dynamic();

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const rows = await query;
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(rowToEntry);
    let nextCursor: string | null = null;
    if (hasMore) {
      const last = data.at(-1);
      if (!last) throw new Error("unreachable: hasMore but data is empty");
      nextCursor = encodeCursor(last.timestamp, last.id);
    }

    return { data, cursor: nextCursor, has_more: hasMore };
  }

  async cleanup(
    retentionDays: number,
    spaceId?: string | null,
  ): Promise<number> {
    const cutoff = new Date(
      Date.now() - retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    // Three filter shapes:
    //   undefined → every row older than cutoff
    //   string    → space_id = X
    //   null      → space_id IS NULL
    const spaceClause =
      spaceId === undefined
        ? undefined
        : spaceId === null
          ? isNull(auditLog.space_id)
          : eq(auditLog.space_id, spaceId);
    const where =
      spaceClause === undefined
        ? lt(auditLog.timestamp, cutoff)
        : and(lt(auditLog.timestamp, cutoff), spaceClause);
    const rows = await this.db
      .delete(auditLog)
      .where(where)
      .returning({ id: auditLog.id });
    return rows.length;
  }

  async redactForUser(authUserId: string): Promise<number> {
    // Scrub PII from audit rows that name this user. The pre-filter
    // (LIKE '%authUserId%' OR resource_id = ?) is a cheap index-friendly
    // cut to avoid scanning every row; the in-memory check below is the
    // authoritative filter (substring matches in unrelated `details`
    // payloads do not falsely trigger).
    const sentinel = JSON.stringify({
      redacted: true,
      user_id_sha256: createHash("sha256").update(authUserId).digest("hex"),
    });
    const candidates = await this.db
      .select({
        id: auditLog.id,
        details: auditLog.details,
        resource_id: auditLog.resource_id,
      })
      .from(auditLog)
      .where(
        or(
          eq(auditLog.resource_id, authUserId),
          like(auditLog.details, `%${authUserId}%`),
        ),
      );
    let rewritten = 0;
    for (const row of candidates) {
      if (!shouldRedact(row.details, row.resource_id, authUserId)) continue;
      await this.db
        .update(auditLog)
        .set({ details: sentinel })
        .where(eq(auditLog.id, row.id));
      rewritten += 1;
    }
    return rewritten;
  }
}

/**
 * Decide whether an audit row genuinely identifies the user. Match criteria:
 *   - `resource_id === authUserId`, OR
 *   - any leaf string value inside `details` (recursive walk) equals
 *     `authUserId` exactly. Substring matches do not count — that's
 *     the LIKE pre-filter's job to be cheap; this is the truth.
 */
function shouldRedact(
  detailsRaw: string,
  resourceId: string | null,
  authUserId: string,
): boolean {
  if (resourceId === authUserId) return true;
  const parsed = safeJsonParse<unknown>(detailsRaw, null, "audit_log.details");
  return containsExactValue(parsed, authUserId);
}

function containsExactValue(node: unknown, needle: string): boolean {
  if (typeof node === "string") return node === needle;
  if (Array.isArray(node)) {
    for (const v of node) if (containsExactValue(v, needle)) return true;
    return false;
  }
  if (node && typeof node === "object") {
    for (const v of Object.values(node)) {
      if (containsExactValue(v, needle)) return true;
    }
  }
  return false;
}
