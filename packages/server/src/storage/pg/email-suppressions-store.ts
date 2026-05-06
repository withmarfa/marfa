import { and, eq } from "drizzle-orm";
import type {
  EmailSuppression,
  EmailSuppressionReason,
  EmailSuppressionsStore,
} from "../interface.js";
import { emailSuppressions } from "./schema.js";
import type { PgDb } from "./connection.js";

/**
 * Wave C PR1 — per-tenant email suppression list (Postgres).
 * See sqlite peer + storage/interface.ts for design notes.
 */
export class PgEmailSuppressionsStore implements EmailSuppressionsStore {
  constructor(private db: PgDb) {}

  async isSuppressed(
    tenantId: string,
    email: string,
  ): Promise<EmailSuppression | null> {
    const [row] = await this.db
      .select()
      .from(emailSuppressions)
      .where(
        and(
          eq(emailSuppressions.tenant_id, tenantId),
          eq(emailSuppressions.email, email.toLowerCase()),
        ),
      );
    if (!row) return null;
    return {
      tenant_id: row.tenant_id,
      email: row.email,
      reason: row.reason as EmailSuppressionReason,
      created_at: row.created_at,
      source_email_id: row.source_email_id,
    };
  }

  async upsert(input: {
    tenantId: string;
    email: string;
    reason: EmailSuppressionReason;
    sourceEmailId?: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    const email = input.email.toLowerCase();
    await this.db
      .insert(emailSuppressions)
      .values({
        tenant_id: input.tenantId,
        email,
        reason: input.reason,
        created_at: now,
        source_email_id: input.sourceEmailId ?? null,
      })
      .onConflictDoUpdate({
        target: [emailSuppressions.tenant_id, emailSuppressions.email],
        set: {
          reason: input.reason,
          source_email_id: input.sourceEmailId ?? null,
          // Keep the original created_at — first-seen is more useful
          // than last-updated for the suppression timeline. The reason
          // and source-email-id refresh because the address may have
          // moved from soft-bounce to complaint.
        },
      });
  }

  async list(tenantId: string): Promise<EmailSuppression[]> {
    const rows = await this.db
      .select()
      .from(emailSuppressions)
      .where(eq(emailSuppressions.tenant_id, tenantId));
    return rows.map((r) => ({
      tenant_id: r.tenant_id,
      email: r.email,
      reason: r.reason as EmailSuppressionReason,
      created_at: r.created_at,
      source_email_id: r.source_email_id,
    }));
  }

  async remove(tenantId: string, email: string): Promise<void> {
    await this.db
      .delete(emailSuppressions)
      .where(
        and(
          eq(emailSuppressions.tenant_id, tenantId),
          eq(emailSuppressions.email, email.toLowerCase()),
        ),
      );
  }
}
