import { and, eq, sql } from "drizzle-orm";
import type { BlobStore } from "../interface.js";
import { blobs } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

export class SqliteBlobStore implements BlobStore {
  constructor(private db: DrizzleDb) {}

  async register(
    hash: string,
    mimeType: string,
    size: number,
    storagePath: string,
    spaceId: string,
  ): Promise<void> {
    // Idempotent — ignore if (space_id, hash) row already exists.
    // Different spaces uploading the same bytes get separate rows.
    await this.db
      .insert(blobs)
      .values({
        space_id: spaceId,
        hash,
        mime_type: mimeType,
        size,
        storage_path: storagePath,
      })
      .onConflictDoNothing()
      .run();
  }

  async get(
    hash: string,
    spaceId: string,
  ): Promise<{ mime_type: string; size: number; storage_path: string } | null> {
    const row = await this.db
      .select()
      .from(blobs)
      .where(and(eq(blobs.space_id, spaceId), eq(blobs.hash, hash)))
      .get();
    if (!row) return null;
    return {
      mime_type: row.mime_type,
      size: row.size,
      storage_path: row.storage_path,
    };
  }

  async getAcrossSpaces(
    hash: string,
  ): Promise<{ mime_type: string; size: number; storage_path: string } | null> {
    const row = await this.db
      .select()
      .from(blobs)
      .where(eq(blobs.hash, hash))
      .limit(1)
      .get();
    if (!row) return null;
    return {
      mime_type: row.mime_type,
      size: row.size,
      storage_path: row.storage_path,
    };
  }

  async listAll(): Promise<string[]> {
    // Distinct hashes across every space — used by the admin reconcile
    // route to find orphan files on disk. Space-scoped reads use `get`.
    const rows = await this.db
      .selectDistinct({ hash: blobs.hash })
      .from(blobs)
      .all();
    return rows.map((r) => r.hash);
  }

  async remove(hash: string, spaceId: string): Promise<void> {
    await this.db
      .delete(blobs)
      .where(and(eq(blobs.space_id, spaceId), eq(blobs.hash, hash)))
      .run();
  }

  async removeAllForHash(hash: string): Promise<void> {
    await this.db.delete(blobs).where(eq(blobs.hash, hash)).run();
  }

  async count(): Promise<{ count: number; total_size: number }> {
    const row = await this.db
      .select({
        count: sql<number>`count(*)`,
        total_size: sql<number>`coalesce(sum(${blobs.size}), 0)`,
      })
      .from(blobs)
      .get();
    return {
      count: row?.count ?? 0,
      total_size: row?.total_size ?? 0,
    };
  }
}
