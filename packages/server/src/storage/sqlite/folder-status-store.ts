import { and, asc, desc, eq } from "drizzle-orm";
import type {
  FolderStatusAck,
  FolderStatusReport,
  StoredFolderStatus,
  FolderStatusSignIn,
} from "@withmarfa/shared";
import type { FolderStatusStore } from "../interface.js";
import { assertInWriteTransaction } from "./request-context.js";
import type { DrizzleDb } from "./connection.js";
import { folderStatus, apiKeys, auth_session } from "./schema.js";

export class SqliteFolderStatusStore implements FolderStatusStore {
  constructor(private db: DrizzleDb) {}
  async put(
    folderId: string,
    signIn: FolderStatusSignIn,
    report: FolderStatusReport,
  ): Promise<FolderStatusAck> {
    assertInWriteTransaction();
    const selector = and(
      eq(folderStatus.folder_id, folderId),
      eq(folderStatus.sign_in_kind, signIn.kind),
      eq(folderStatus.sign_in_id, signIn.id),
      eq(folderStatus.folder_store_id, report.folder_store_id),
    );
    const previous = await this.db
      .select()
      .from(folderStatus)
      .where(selector)
      .get();
    if (previous && previous.sequence >= report.sequence)
      return {
        accepted: false,
        sequence: previous.sequence,
        received_at: previous.received_at,
      };
    const received_at = new Date().toISOString();
    await this.db
      .insert(folderStatus)
      .values({
        folder_id: folderId,
        sign_in_kind: signIn.kind,
        sign_in_id: signIn.id,
        sign_in_name: signIn.name,
        folder_store_id: report.folder_store_id,
        sequence: report.sequence,
        report: JSON.stringify(report),
        received_at,
      })
      .onConflictDoUpdate({
        target: [
          folderStatus.folder_id,
          folderStatus.sign_in_kind,
          folderStatus.sign_in_id,
          folderStatus.folder_store_id,
        ],
        set: {
          sequence: report.sequence,
          report: JSON.stringify(report),
          received_at,
          sign_in_name: signIn.name,
        },
      });
    return { accepted: true, sequence: report.sequence, received_at };
  }
  async list(folderId: string): Promise<StoredFolderStatus[]> {
    const rows = await this.db
      .select()
      .from(folderStatus)
      .where(eq(folderStatus.folder_id, folderId))
      .orderBy(
        asc(folderStatus.sign_in_kind),
        asc(folderStatus.sign_in_id),
        desc(folderStatus.received_at),
        asc(folderStatus.folder_store_id),
      );
    return rows.map((row) => ({
      ...(JSON.parse(row.report) as FolderStatusReport),
      sign_in: {
        kind: row.sign_in_kind as FolderStatusSignIn["kind"],
        id: row.sign_in_id,
        name: row.sign_in_name,
      },
      received_at: row.received_at,
    }));
  }
  async isCurrent(signIn: FolderStatusSignIn, now: Date): Promise<boolean> {
    if (signIn.kind === "key") {
      const key = await this.db
        .select({
          revoked_at: apiKeys.revoked_at,
          expires_at: apiKeys.expires_at,
        })
        .from(apiKeys)
        .where(eq(apiKeys.id, signIn.id))
        .get();
      return (
        !!key &&
        key.revoked_at === null &&
        (key.expires_at === null || key.expires_at > now.toISOString())
      );
    }
    if (signIn.kind === "browser") {
      const session = await this.db
        .select({ expiresAt: auth_session.expiresAt })
        .from(auth_session)
        .where(eq(auth_session.id, signIn.id))
        .get();
      return !!session && session.expiresAt.getTime() > now.getTime();
    }

    return false;
  }
}
