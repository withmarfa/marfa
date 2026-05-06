import { and, eq, sql } from "drizzle-orm";
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
    tenantId: string,
  ): Promise<void> {
    // Idempotent — ignore if (tenant_id, hash) row already exists.
    // Different tenants uploading the same bytes get separate rows.
    this.db
      .insert(blobs)
      .values({
        tenant_id: tenantId,
        hash,
        mime_type: mimeType,
        size,
        storage_path: storagePath,
      })
      .onConflictDoNothing()
      .run();
    return Promise.resolve();
  }

  get(
    hash: string,
    tenantId: string,
  ): Promise<{ mime_type: string; size: number; storage_path: string } | null> {
    const row = this.db
      .select()
      .from(blobs)
      .where(and(eq(blobs.tenant_id, tenantId), eq(blobs.hash, hash)))
      .get();
    if (!row) return Promise.resolve(null);
    return Promise.resolve({
      mime_type: row.mime_type,
      size: row.size,
      storage_path: row.storage_path,
    });
  }

  listAll(): Promise<string[]> {
    // Distinct hashes across every tenant — used by the admin reconcile
    // route to find orphan files on disk. Tenant-scoped reads use `get`.
    const rows = this.db.selectDistinct({ hash: blobs.hash }).from(blobs).all();
    return Promise.resolve(rows.map((r) => r.hash));
  }

  remove(hash: string, tenantId: string): Promise<void> {
    this.db
      .delete(blobs)
      .where(and(eq(blobs.tenant_id, tenantId), eq(blobs.hash, hash)))
      .run();
    return Promise.resolve();
  }

  removeAllForHash(hash: string): Promise<void> {
    this.db.delete(blobs).where(eq(blobs.hash, hash)).run();
    return Promise.resolve();
  }

  count(): Promise<{ count: number; total_size: number }> {
    const row = this.db
      .select({
        count: sql<number>`count(*)`,
        total_size: sql<number>`coalesce(sum(${blobs.size}), 0)`,
      })
      .from(blobs)
      .get();
    return Promise.resolve({
      count: row?.count ?? 0,
      total_size: row?.total_size ?? 0,
    });
  }
}
