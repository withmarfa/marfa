import { eq, and, asc } from "drizzle-orm";
import { generateId } from "@mymehq/shared";
import type { Version } from "@mymehq/shared";
import type { VersionStore } from "../interface.js";
import { versions } from "./schema.js";
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
      device_id: deviceId ?? null,
    };
    await executor.insert(versions).values(row);
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
}
