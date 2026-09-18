import { eq, and, desc, lt, or, gte, lte, like } from "drizzle-orm";
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
import type { DrizzleDb } from "./connection.js";

function rowToEntry(row: typeof auditLog.$inferSelect): AuditEntry {
  const details = safeJsonParse<Record<string, unknown>>(
    row.details,
    {},
    "audit_log.details",
  );
  // client_ip is persisted inside the details JSON blob for schema
  // compatibility (no migration needed); the typed interface lifts it
  // back to a top-level field on the read path.
  const ipRaw = details.client_ip;
  const client_ip =
    typeof ipRaw === "string" && ipRaw.length > 0 ? ipRaw : null;
  return {
    id: row.id,
    timestamp: row.timestamp,
    key_id: row.key_id ?? null,
    action: row.action,
    resource_type: row.resource_type,
    resource_id: row.resource_id ?? null,
    client_ip,
    details,
  };
}

export class SqliteAuditStore implements AuditStore {
  private readonly writes = new WriteTracker("audit");

  constructor(private db: DrizzleDb) {}

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
      action: entry.action,
      resource_type: entry.resource_type,
      resource_id: entry.resource_id ?? null,
      details: JSON.stringify(detailsBlob),
    };
  }

  /** Fire-and-forget. Runs under the write tracker so `drain()` can wait for
   *  it before the store closes and so its errors are swallowed: a late write
   *  that loses the race against teardown can never surface as an unhandled
   *  rejection. Never rejects — see the interface. */
  async log(entry: AuditLogEntry): Promise<void> {
    await this.writes.track(async () => {
      // Inside the tracker, not outside it. Building the row serializes
      // `details`, which can itself fail, and a caller promised a writer
      // that never rejects must not be handed one that rejects before the
      // insert is even attempted.
      const row = this.buildRow(entry);
      await this.db.insert(auditLog).values(row).run();
    });
  }

  /** The propagating form. Not tracked: the caller is awaiting it, so there
   *  is nothing in flight for shutdown to find, and tracking would swallow
   *  the very failure this exists to surface. */
  async logOrThrow(entry: AuditLogEntry): Promise<void> {
    await this.db.insert(auditLog).values(this.buildRow(entry)).run();
  }

  /** Resolve once every in-flight audit write has settled. Called by the
   *  storage's `close()` so pending fire-and-forget writes drain before the
   *  underlying connection is closed. */
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

    const rows = await query.all();
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

  async cleanup(retentionDays: number): Promise<number> {
    const cutoff = new Date(
      Date.now() - retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = await this.db
      .delete(auditLog)
      .where(lt(auditLog.timestamp, cutoff))
      .run();
    return result.rowsAffected;
  }

  async redactForUser(authUserId: string): Promise<number> {
    // LIKE-prefilter narrows the scan; in-memory parse + exact-equality
    // recursion is the truth. See pg/audit-store.ts for the full design note.
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
      )
      .all();
    let rewritten = 0;
    for (const row of candidates) {
      if (!shouldRedact(row.details, row.resource_id, authUserId)) continue;
      await this.db
        .update(auditLog)
        .set({ details: sentinel })
        .where(eq(auditLog.id, row.id))
        .run();
      rewritten += 1;
    }
    return rewritten;
  }
}

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
