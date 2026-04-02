/* eslint-disable @typescript-eslint/require-await -- sync better-sqlite3 implementing async interface */
import { eq, and, asc } from "drizzle-orm";
import { generateId } from "@myme/shared";
import type { Version } from "@myme/shared";
import type { VersionStore } from "../interface.js";
import { versions } from "./schema.js";
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
      device_id: deviceId ?? null,
    };
    this.db.insert(versions).values(row).run();
    return {
      id: row.id,
      item_id: itemId,
      version,
      properties,
      created_at: now,
      ...(deviceId != null && { device_id: deviceId }),
    };
  }

  async list(itemId: string): Promise<Version[]> {
    const rows = this.db
      .select()
      .from(versions)
      .where(eq(versions.item_id, itemId))
      .orderBy(asc(versions.version))
      .all();
    return rows.map(rowToVersion);
  }

  async getByVersion(itemId: string, version: number): Promise<Version | null> {
    const row = this.db
      .select()
      .from(versions)
      .where(and(eq(versions.item_id, itemId), eq(versions.version, version)))
      .get();
    return row ? rowToVersion(row) : null;
  }
}
