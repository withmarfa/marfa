import { eq, and, asc, gt, inArray, sql } from "drizzle-orm";
import { ErrorCode, generateId, MarfaError } from "@withmarfa/shared";
import type { Version } from "@withmarfa/shared";
import {
  decodeKeyedCursor,
  encodeKeyedCursor,
  ITEM_VERSIONS_CURSOR_KEY,
} from "../interface.js";
import type {
  VersionedItemFields,
  VersionPageInput,
  VersionStore,
} from "../interface.js";
import { versions } from "./schema.js";
import { items } from "./schema.js";
import type { DrizzleDb } from "./connection.js";
import { rowToVersion } from "./helpers.js";
import { isUniqueViolation } from "./pk-violation.js";

/** The base Drizzle handle or a transaction handle from `db.transaction`. */
type TxOrDb =
  DrizzleDb | Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];

export class SqliteVersionStore implements VersionStore {
  constructor(private db: DrizzleDb) {}

  /** `db` is the caller's transaction when the snapshot has to land with the
   *  write it records; the store's own handle otherwise. */
  async create(
    itemId: string,
    version: number,
    properties: Record<string, unknown>,
    itemFields: VersionedItemFields,
    db: TxOrDb = this.db,
  ): Promise<Version> {
    const row = {
      id: generateId(),
      item_id: itemId,
      version,
      properties: JSON.stringify(properties),
      type: itemFields.type,
      tier: itemFields.tier,
      occurred_at: itemFields.occurred_at,
      source_id: itemFields.source_id,
      created_at: new Date().toISOString(),
    };
    await db.insert(versions).values(row).run();
    return { ...row, properties };
  }

  /** Replays validated archive snapshots without minting IDs or applying the
   *  current type schema to properties written under an earlier schema. */
  async restore(snapshots: readonly Version[]): Promise<void> {
    if (snapshots.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const snapshot of snapshots) {
        try {
          await tx
            .insert(versions)
            .values({
              id: snapshot.id,
              item_id: snapshot.item_id,
              version: snapshot.version,
              properties: JSON.stringify(snapshot.properties),
              type: snapshot.type,
              tier: snapshot.tier,
              occurred_at: snapshot.occurred_at,
              source_id: snapshot.source_id,
              created_at: snapshot.created_at,
            })
            .run();
        } catch (err) {
          if (isUniqueViolation(err, "versions.id")) {
            throw new MarfaError(
              ErrorCode.CONFLICT,
              `Version snapshot ${snapshot.id} already exists`,
              { snapshot_id: snapshot.id, item_id: snapshot.item_id },
            );
          }
          throw err;
        }
      }
    });
  }

  /**
   * Reads on past the snapshots the reader may not read until the page is
   * full or the history ends, so a page is short only at the end.
   */
  async list(
    itemId: string,
    page: VersionPageInput,
  ): Promise<{ data: Version[]; next_cursor: string | null }> {
    let after = page.cursor
      ? Number(decodeKeyedCursor(page.cursor, ITEM_VERSIONS_CURSOR_KEY).v)
      : 0;
    if (!Number.isSafeInteger(after)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid pagination cursor",
      );
    }
    const data: Version[] = [];
    for (;;) {
      const rows = await this.db
        .select()
        .from(versions)
        .where(and(eq(versions.item_id, itemId), gt(versions.version, after)))
        .orderBy(asc(versions.version))
        .limit(page.limit + 1)
        .all();
      for (const row of rows) {
        if (!page.reads(row.type)) continue;
        const last = data.at(-1);
        if (last !== undefined && data.length === page.limit) {
          return {
            data,
            next_cursor: encodeKeyedCursor(
              String(last.version),
              last.id,
              ITEM_VERSIONS_CURSOR_KEY,
            ),
          };
        }
        data.push(rowToVersion(row));
      }
      const read = rows.at(-1);
      if (read === undefined || rows.length <= page.limit) {
        return { data, next_cursor: null };
      }
      after = read.version;
    }
  }

  async all(itemId: string): Promise<Version[]> {
    const rows = await this.db
      .select()
      .from(versions)
      .where(eq(versions.item_id, itemId))
      .orderBy(asc(versions.version))
      .all();
    return rows.map(rowToVersion);
  }

  async getByVersion(
    itemId: string,
    version: number,
    tx?: TxOrDb,
  ): Promise<Version | null> {
    const executor = tx ?? this.db;
    const row = await executor
      .select()
      .from(versions)
      .where(and(eq(versions.item_id, itemId), eq(versions.version, version)))
      .get();
    return row ? rowToVersion(row) : null;
  }

  async deleteByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.db
      .delete(versions)
      .where(inArray(versions.id, ids))
      .run();
    return result.rowsAffected;
  }

  async scanProperties(
    limit: number,
    cursor?: string,
  ): Promise<{ properties: Record<string, unknown>[]; cursor: string | null }> {
    const rows = await this.db
      .select({ id: versions.id, properties: versions.properties })
      .from(versions)
      .where(cursor ? gt(versions.id, cursor) : undefined)
      .orderBy(asc(versions.id))
      .limit(limit)
      .all();
    const last = rows.at(-1);
    return {
      properties: rows.map(
        (r) => JSON.parse(r.properties) as Record<string, unknown>,
      ),
      cursor: rows.length === limit && last ? last.id : null,
    };
  }

  async listThinningCandidates(
    threshold: number,
    limit: number,
    afterItemId?: string,
  ): Promise<
    {
      itemId: string;
      type: string;
      versionCount: number;
    }[]
  > {
    const rows = await this.db
      .select({
        itemId: versions.item_id,
        type: items.type,
        versionCount: sql<number>`count(*)`,
      })
      .from(versions)
      .innerJoin(items, eq(versions.item_id, items.id))
      .where(afterItemId ? gt(versions.item_id, afterItemId) : undefined)
      .groupBy(versions.item_id, items.type)
      .having(sql`count(*) > ${threshold}`)
      .orderBy(asc(versions.item_id))
      .limit(limit)
      .all();
    return rows;
  }
}
