import { and, eq } from "drizzle-orm";
import { isSubtypeOf, isValidBlobHash } from "@withmarfa/shared";
import type { DrizzleDb } from "./connection.js";
import type { SqliteTxContext } from "./request-context.js";
import { blobs, item_blob_references } from "./schema.js";

type Executor = DrizzleDb | SqliteTxContext;

const FILE_TYPE = "core.file";

/** Whether rows of `type` are files, whose `size_bytes` is the server's. */
export function isFileType(type: string): boolean {
  return isSubtypeOf(type, FILE_TYPE);
}

/**
 * The properties a file row holds once its `size_bytes` is the server's:
 * the stored length of the bytes its `blob_ref` names where that reference
 * lends, and no size where it does not, so a writer that never proved it
 * holds the bytes learns nothing of whether the instance does (`blobs.md`
 * 15). `undefined` where the row already holds exactly that, or is not a
 * file.
 *
 * Asked after the write has synced the reference index, which is where
 * whether the reference lends is decided.
 */
export async function stampedFileSize(
  db: Executor,
  row: { id: string; type: string; properties: Record<string, unknown> },
): Promise<Record<string, unknown> | undefined> {
  if (!isFileType(row.type)) return undefined;
  const ref = row.properties.blob_ref;
  let size: number | undefined;
  if (typeof ref === "string" && isValidBlobHash(ref)) {
    const held = await db
      .select({ size: blobs.size_bytes })
      .from(item_blob_references)
      .innerJoin(blobs, eq(blobs.hash, item_blob_references.hash))
      .where(
        and(
          eq(item_blob_references.item_id, row.id),
          eq(item_blob_references.hash, ref),
          eq(item_blob_references.lends, true),
        ),
      )
      .get();
    size = held?.size;
  }
  if (row.properties.size_bytes === size) return undefined;
  if (size !== undefined) return { ...row.properties, size_bytes: size };
  return Object.fromEntries(
    Object.entries(row.properties).filter(([key]) => key !== "size_bytes"),
  );
}
