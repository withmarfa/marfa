import { eq, and, asc, desc, inArray, sql } from "drizzle-orm";
import { generateId } from "@withmarfa/shared";
import type { Version } from "@withmarfa/shared";
import type { VersionStore } from "../interface.js";
import { versions } from "./schema.js";
import { items } from "./schema.js";
import type { DrizzleDb } from "./connection.js";
import { rowToVersion } from "./helpers.js";

export class SqliteVersionStore implements VersionStore {
  constructor(private db: DrizzleDb) {}

  async create(
    itemId: string,
    version: number,
    properties: Record<string, unknown>,
    deviceId?: string,
  ): Promise<Version> {
    const now = new Date().toISOString();
    const row = {
      id: generateId(),
      item_id: itemId,
      version,
      properties: JSON.stringify(properties),
      created_at: now,
      device: deviceId ?? null,
    };
    await this.db.insert(versions).values(row).run();
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
      .orderBy(asc(versions.version))
      .all();
    return rows.map(rowToVersion);
  }

  async getByVersion(itemId: string, version: number): Promise<Version | null> {
    const row = await this.db
      .select()
      .from(versions)
      .where(and(eq(versions.item_id, itemId), eq(versions.version, version)))
      .get();
    return row ? rowToVersion(row) : null;
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

  async listThinningCandidates(
    threshold: number,
    limit: number,
  ): Promise<{ itemId: string; type: string; versionCount: number }[]> {
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
