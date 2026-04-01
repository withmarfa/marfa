import { eq } from "drizzle-orm";
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
  ): Promise<void> {
    // Idempotent — ignore if hash already exists
    this.db
      .insert(blobs)
      .values({ hash, mime_type: mimeType, size, storage_path: storagePath })
      .onConflictDoNothing()
      .run();
  }

  async get(
    hash: string,
  ): Promise<{ mime_type: string; size: number; storage_path: string } | null> {
    const row = this.db.select().from(blobs).where(eq(blobs.hash, hash)).get();
    if (!row) return null;
    return {
      mime_type: row.mime_type,
      size: row.size,
      storage_path: row.storage_path,
    };
  }
}
