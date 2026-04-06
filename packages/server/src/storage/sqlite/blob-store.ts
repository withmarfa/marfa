import { eq } from "drizzle-orm";
import type { BlobStore } from "../interface.js";
import { blobs } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

export class SqliteBlobStore implements BlobStore {
  constructor(private db: DrizzleDb) {}

  register(
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
    return Promise.resolve();
  }

  get(
    hash: string,
  ): Promise<{ mime_type: string; size: number; storage_path: string } | null> {
    const row = this.db.select().from(blobs).where(eq(blobs.hash, hash)).get();
    if (!row) return Promise.resolve(null);
    return Promise.resolve({
      mime_type: row.mime_type,
      size: row.size,
      storage_path: row.storage_path,
    });
  }

  listAll(): Promise<string[]> {
    const rows = this.db.select({ hash: blobs.hash }).from(blobs).all();
    return Promise.resolve(rows.map((r) => r.hash));
  }

  remove(hash: string): Promise<void> {
    this.db.delete(blobs).where(eq(blobs.hash, hash)).run();
    return Promise.resolve();
  }
}
