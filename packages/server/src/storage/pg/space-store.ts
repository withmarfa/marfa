import { eq } from "drizzle-orm";
import { spaceFromRow, storedSpaceStatus } from "../stored-space-status.js";
import { generateId } from "@withmarfa/shared";
import type { Space, SpaceConfig, SpaceStatus } from "@withmarfa/shared";
import type { SpaceStore } from "../interface.js";
import { spaces } from "./schema.js";
import type { PgDb } from "./connection.js";

export class PgSpaceStore implements SpaceStore {
  constructor(private db: PgDb) {}

  async create(name?: string): Promise<Space> {
    const now = new Date().toISOString();
    const row = {
      id: generateId(),
      name: name ?? null,
      created_at: now,
    };
    await this.db.insert(spaces).values(row);
    return {
      id: row.id,
      name: row.name,
      created_at: row.created_at,
      // The status column carries NOT NULL DEFAULT 'active'; the insert
      // above omits it, so the DB stamps it. Echo back the same default on
      // the returned row so the caller doesn't need a follow-up read.
      status: "active",
    };
  }

  async get(id: string): Promise<Space | null> {
    const [row] = await this.db
      .select({
        id: spaces.id,
        name: spaces.name,
        created_at: spaces.created_at,
        status: spaces.status,
      })
      .from(spaces)
      .where(eq(spaces.id, id));
    if (!row) return null;
    return spaceFromRow(row);
  }

  async list(): Promise<Space[]> {
    const rows = await this.db
      .select({
        id: spaces.id,
        name: spaces.name,
        created_at: spaces.created_at,
        status: spaces.status,
      })
      .from(spaces);
    return rows.map(spaceFromRow);
  }

  async soleSpaceId(): Promise<string | null> {
    // Two rows, not all of them: the second row is the whole of what
    // distinguishes "one space" from "more than one", and this runs on a
    // request path.
    const rows = await this.db.select({ id: spaces.id }).from(spaces).limit(2);
    return rows.length === 1 ? (rows[0]?.id ?? null) : null;
  }

  async getConfig(id: string): Promise<SpaceConfig | null> {
    const [row] = await this.db
      .select({ config: spaces.config })
      .from(spaces)
      .where(eq(spaces.id, id));
    if (!row?.config) return null;
    return row.config;
  }

  async updateConfig(id: string, config: SpaceConfig): Promise<void> {
    await this.db.update(spaces).set({ config }).where(eq(spaces.id, id));
  }

  async suspend(id: string): Promise<Space | null> {
    return this.setStatus(id, "suspended");
  }

  async unsuspend(id: string): Promise<Space | null> {
    return this.setStatus(id, "active");
  }

  async getStatus(id: string): Promise<SpaceStatus | null> {
    const [row] = await this.db
      .select({ status: spaces.status })
      .from(spaces)
      .where(eq(spaces.id, id));
    // A missing row is a missing space and stays `null`. A row whose
    // status this build cannot read is a different answer entirely, and
    // collapsing the two would hand the caller `null` for a space that
    // exists, which every consumer reads as "nothing to enforce".
    if (!row) return null;
    return storedSpaceStatus(row.status, id);
  }

  private async setStatus(
    id: string,
    status: SpaceStatus,
  ): Promise<Space | null> {
    const [row] = await this.db
      .update(spaces)
      .set({ status })
      .where(eq(spaces.id, id))
      .returning({
        id: spaces.id,
        name: spaces.name,
        created_at: spaces.created_at,
        status: spaces.status,
      });
    if (!row) return null;
    return spaceFromRow(row);
  }
}
