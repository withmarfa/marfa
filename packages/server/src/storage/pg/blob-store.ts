import { eq } from "drizzle-orm";
import type { BlobStore } from "../interface.js";
import { blobs } from "./schema.js";
import type { PgDb } from "./connection.js";

export class PgBlobStore implements BlobStore {
  constructor(private db: PgDb) {}

  async register(
    hash: string,
    mimeType: string,
    size: number,
    storagePath: string,
  ): Promise<void> {
    // Idempotent — ignore if hash already exists
    await this.db
      .insert(blobs)
      .values({ hash, mime_type: mimeType, size, storage_path: storagePath })
      .onConflictDoNothing();
  }

  async get(
    hash: string,
  ): Promise<{ mime_type: string; size: number; storage_path: string } | null> {
    const [row] = await this.db
      .select()
      .from(blobs)
      .where(eq(blobs.hash, hash));
    if (!row) return null;
    return {
      mime_type: row.mime_type,
      size: row.size,
      storage_path: row.storage_path,
    };
  }
}
