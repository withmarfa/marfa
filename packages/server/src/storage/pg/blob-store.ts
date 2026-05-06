import { and, eq, sql } from "drizzle-orm";
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
    tenantId: string,
  ): Promise<void> {
    // Idempotent — ignore if (tenant_id, hash) row already exists.
    // Different tenants uploading the same bytes get separate rows.
    await this.db
      .insert(blobs)
      .values({
        tenant_id: tenantId,
        hash,
        mime_type: mimeType,
        size,
        storage_path: storagePath,
      })
      .onConflictDoNothing();
  }

  async get(
    hash: string,
    tenantId: string,
  ): Promise<{ mime_type: string; size: number; storage_path: string } | null> {
    const [row] = await this.db
      .select()
      .from(blobs)
      .where(and(eq(blobs.tenant_id, tenantId), eq(blobs.hash, hash)));
    if (!row) return null;
    return {
      mime_type: row.mime_type,
      size: row.size,
      storage_path: row.storage_path,
    };
  }

  async listAll(): Promise<string[]> {
    // Distinct hashes across every tenant — used by the admin reconcile
    // route to find orphan files on disk. Tenant-scoped reads use `get`.
    const rows = await this.db.selectDistinct({ hash: blobs.hash }).from(blobs);
    return rows.map((r) => r.hash);
  }

  async remove(hash: string, tenantId: string): Promise<void> {
    await this.db
      .delete(blobs)
      .where(and(eq(blobs.tenant_id, tenantId), eq(blobs.hash, hash)));
  }

  async removeAllForHash(hash: string): Promise<void> {
    await this.db.delete(blobs).where(eq(blobs.hash, hash));
  }

  async count(): Promise<{ count: number; total_size: number }> {
    // count(*)::int returns a JS number; blob count safely fits in int.
    // sum(size) must stay ::bigint (aggregate bytes can exceed INT_MAX), and
    // node-postgres serializes bigint as a string — reflect that in the sql<>
    // annotation and coerce on the way out.
    const [row] = await this.db
      .select({
        count: sql<number>`count(*)::int`,
        total_size: sql<string>`coalesce(sum(${blobs.size}), 0)::bigint`,
      })
      .from(blobs);
    return {
      count: row?.count ?? 0,
      total_size: Number(row?.total_size ?? 0),
    };
  }
}
