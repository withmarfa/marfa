import { eq } from "drizzle-orm";
import { generateId } from "@withmarfa/shared";
import type { Space, SpaceConfig, SpaceStatus } from "@withmarfa/shared";
import type { SpaceStore } from "../interface.js";
import { spaces } from "./schema.js";
import type { DrizzleDb } from "./connection.js";
import { safeJsonParse } from "../json-utils.js";

export class SqliteSpaceStore implements SpaceStore {
  constructor(private db: DrizzleDb) {}

  async create(name?: string): Promise<Space> {
    const now = new Date().toISOString();
    const row = {
      id: generateId(),
      name: name ?? null,
      created_at: now,
    };
    await this.db.insert(spaces).values(row).run();
    return {
      id: row.id,
      name: row.name,
      created_at: row.created_at,
      // Column has DEFAULT 'active'; insert omits it. Echo the default so
      // the caller avoids a follow-up read.
      status: "active",
    };
  }

  async get(id: string): Promise<Space | null> {
    const row = await this.db
      .select()
      .from(spaces)
      .where(eq(spaces.id, id))
      .get();
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      created_at: row.created_at,
      status: row.status as SpaceStatus,
    };
  }

  async list(): Promise<Space[]> {
    const rows = await this.db.select().from(spaces).all();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      created_at: row.created_at,
      status: row.status as SpaceStatus,
    }));
  }

  async getConfig(id: string): Promise<SpaceConfig | null> {
    const row = await this.db
      .select({ config: spaces.config })
      .from(spaces)
      .where(eq(spaces.id, id))
      .get();
    if (!row?.config) return null;
    return safeJsonParse<SpaceConfig>(row.config, {}, `space ${id} config`);
  }

  async updateConfig(id: string, config: SpaceConfig): Promise<void> {
    await this.db
      .update(spaces)
      .set({ config: JSON.stringify(config) })
      .where(eq(spaces.id, id))
      .run();
  }

  async suspend(id: string): Promise<Space | null> {
    return this.setStatus(id, "suspended");
  }

  async unsuspend(id: string): Promise<Space | null> {
    return this.setStatus(id, "active");
  }

  async getStatus(id: string): Promise<SpaceStatus | null> {
    const row = await this.db
      .select({ status: spaces.status })
      .from(spaces)
      .where(eq(spaces.id, id))
      .get();
    return (row?.status as SpaceStatus | undefined) ?? null;
  }

  private async setStatus(
    id: string,
    status: SpaceStatus,
  ): Promise<Space | null> {
    const rows = await this.db
      .update(spaces)
      .set({ status })
      .where(eq(spaces.id, id))
      .returning({
        id: spaces.id,
        name: spaces.name,
        created_at: spaces.created_at,
        status: spaces.status,
      });
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      created_at: row.created_at,
      status: row.status as SpaceStatus,
    };
  }
}
