import { eq, and, asc, desc, gt, inArray, sql } from "drizzle-orm";
import { generateId } from "@withmarfa/shared";
import type { Version } from "@withmarfa/shared";
import type { VersionStore } from "../interface.js";
import { versions } from "./schema.js";
import { items } from "./schema.js";
import type { PgDb } from "./connection.js";
import { rowToVersion } from "./helpers.js";

// Drizzle Postgres transaction context shares the same query interface
type TxOrDb = PgDb | Parameters<Parameters<PgDb["transaction"]>[0]>[0];

export class PgVersionStore implements VersionStore {
  constructor(private db: PgDb) {}

  async create(
    itemId: string,
    version: number,
    properties: Record<string, unknown>,
    deviceId?: string,
    tx?: TxOrDb,
  ): Promise<Version> {
    const executor = tx ?? this.db;
    const now = new Date().toISOString();
    const row = {
      id: generateId(),
      item_id: itemId,
      version,
      properties: JSON.stringify(properties),
      created_at: now,
      device: deviceId ?? null,
    };
    await executor.insert(versions).values(row);
    return {
      id: row.id,
      item_id: itemId,
      version,
      properties,
      created_at: now,
      ...(deviceId != null && { device: deviceId }),
    };
  }

  async list(itemId: string): Promise<Version[]> {
    const rows = await this.db
      .select()
      .from(versions)
      .where(eq(versions.item_id, itemId))
      .orderBy(asc(versions.version));
    return rows.map(rowToVersion);
  }

  async getByVersion(
    itemId: string,
    version: number,
    tx?: TxOrDb,
  ): Promise<Version | null> {
    const executor = tx ?? this.db;
    const [row] = await executor
      .select()
      .from(versions)
      .where(and(eq(versions.item_id, itemId), eq(versions.version, version)));
    return row ? rowToVersion(row) : null;
  }

  async getLatestTimestamp(
    itemId: string,
    tx?: TxOrDb,
  ): Promise<string | null> {
    const executor = tx ?? this.db;
    const [row] = await executor
      .select({ created_at: versions.created_at })
      .from(versions)
      .where(eq(versions.item_id, itemId))
      .orderBy(desc(versions.version))
      .limit(1);
    return row?.created_at ?? null;
  }

  async deleteByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.db
      .delete(versions)
      .where(inArray(versions.id, ids))
      .returning({ id: versions.id });
    return rows.length;
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
      .limit(limit);
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
      spaceId: string | null;
      versionCount: number;
    }[]
  > {
    const rows = await this.db
      .select({
        itemId: versions.item_id,
        type: items.type,
        spaceId: items.space_id,
        versionCount: sql<number>`count(*)::int`,
      })
      .from(versions)
      .innerJoin(items, eq(versions.item_id, items.id))
      .groupBy(versions.item_id, items.type, items.space_id)
      .having(sql`count(*) > ${threshold}`)
      .limit(limit);
    return rows;
  }
}
