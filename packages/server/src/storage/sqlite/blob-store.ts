import { eq, lt, sql } from "drizzle-orm";
import type { BlobStore } from "../interface.js";
import { blobs } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

export class SqliteBlobStore implements BlobStore {
  constructor(private db: DrizzleDb) {}

  async register(
    hash: string,
    mimeType: string,
    sizeBytes: number,
    storagePath: string,
  ): Promise<void> {
    // Idempotent — ignore if the row already exists.
    await this.db
      .insert(blobs)
      .values({
        hash,
        mime_type: mimeType,
        size_bytes: sizeBytes,
        storage_path: storagePath,
        created_at: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();
  }

  async get(hash: string): Promise<{
    mime_type: string;
    size_bytes: number;
    storage_path: string;
  } | null> {
    const row = await this.db
      .select()
      .from(blobs)
      .where(eq(blobs.hash, hash))
      .get();
    if (!row) return null;
    return {
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      storage_path: row.storage_path,
    };
  }

  async listAll(): Promise<string[]> {
    const rows = await this.db.select({ hash: blobs.hash }).from(blobs).all();
    return rows.map((r) => r.hash);
  }

  async listRegisteredBefore(cutoff: string): Promise<string[]> {
    const rows = await this.db
      .select({ hash: blobs.hash })
      .from(blobs)
      .where(lt(blobs.created_at, cutoff))
      .all();
    return rows.map((r) => r.hash);
  }

  async remove(hash: string): Promise<void> {
    await this.db.delete(blobs).where(eq(blobs.hash, hash)).run();
  }

  async count(): Promise<{ count: number; total_size_bytes: number }> {
    const row = await this.db
      .select({
        count: sql<number>`count(*)`,
        total_size_bytes: sql<number>`coalesce(sum(${blobs.size_bytes}), 0)`,
      })
      .from(blobs)
      .get();
    return {
      count: row?.count ?? 0,
      total_size_bytes: row?.total_size_bytes ?? 0,
    };
  }
}
