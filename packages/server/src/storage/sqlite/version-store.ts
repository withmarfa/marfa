import { eq, and, asc, desc, gt, inArray, sql } from "drizzle-orm";
import { generateId } from "@withmarfa/shared";
import type { Version } from "@withmarfa/shared";
import type {
  VersionedItemFields,
  VersionSnapshot,
  VersionStore,
} from "../interface.js";
import { versions } from "./schema.js";
import { items } from "./schema.js";
import type { DrizzleDb } from "./connection.js";
import { rowToVersion } from "./helpers.js";

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
    const now = new Date().toISOString();
    const row = {
      id: generateId(),
      item_id: itemId,
      version,
      properties: JSON.stringify(properties),
      tier: itemFields.tier,
      occurred_at: itemFields.occurred_at,
      source_id: itemFields.source_id,
      created_at: now,
    };
    await db.insert(versions).values(row).run();
    return {
      id: row.id,
      item_id: itemId,
      version,
      properties,
      created_at: now,
    };
  }

  async list(itemId: string): Promise<Version[]> {
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
  ): Promise<VersionSnapshot | null> {
    const executor = tx ?? this.db;
    const row = await executor
      .select()
      .from(versions)
      .where(and(eq(versions.item_id, itemId), eq(versions.version, version)))
      .get();
    if (!row) return null;
    return {
      ...rowToVersion(row),
      item_fields: {
        tier: row.tier,
        occurred_at: row.occurred_at,
        source_id: row.source_id,
      },
    };
  }

  async getLatestTimestamp(itemId: string): Promise<string | null> {
    const row = await this.db
      .select({ created_at: versions.created_at })
      .from(versions)
      .where(eq(versions.item_id, itemId))
      .orderBy(desc(versions.version))
      .limit(1)
      .get();
    return row?.created_at ?? null;
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
      .groupBy(versions.item_id, items.type)
      .having(sql`count(*) > ${threshold}`)
      .limit(limit)
      .all();
    return rows;
  }
}
