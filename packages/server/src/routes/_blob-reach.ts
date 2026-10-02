import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { Context } from "hono";
import {
  computeTypeFilter,
  getTypeFilter,
  mayReadType,
  requireAuth,
  type AppEnv,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";

/** One answer for a blob that is not there and one the caller may not read. */
function blobNotFound(): MarfaError {
  return new MarfaError(ErrorCode.BLOB_NOT_FOUND, "Blob not found");
}

/**
 * The registered blob `hash` names, if the credential may read it, and
 * `blob_not_found` otherwise. Every door that reads a blob's bytes, hands
 * out a link to them or reads its location log passes through here;
 * `blob-door-census.test.ts` fails on one that does not.
 *
 * A blob belongs to no type, so it borrows its reach from the items whose
 * properties reference it, in every lifecycle state, through the same
 * predicate the item read doors ask. Extensions, edge properties and
 * version snapshots keep a blob from the orphan sweep and lend no reach:
 * each sits behind a gate of its own that an item's type does not answer.
 * A blob nothing references therefore answers no working credential, the
 * one that uploaded it included, and answers exactly as an unknown hash,
 * so a refusal says nothing of what the instance holds.
 *
 * The operator key holds no type permission and stands outside the model;
 * it reads every blob.
 */
export async function requireReadableBlob(
  c: Context<AppEnv>,
  storage: Storage,
  hash: string,
): Promise<{ mime_type: string; size_bytes: number }> {
  const key = requireAuth(c);
  if (!key.is_operator) {
    getTypeFilter(c);
    const types = await storage.blobs.referencingTypes(hash);
    if (!types.some((type) => mayReadType(key, type))) throw blobNotFound();
  }
  const record = await storage.blobs.get(hash);
  if (!record) throw blobNotFound();
  return record;
}

/**
 * Admit an upload only from a credential that could write an item to
 * reference it: write on at least one type, whichever, since an item of any
 * type can name a blob in a string. The operator key uploads without one.
 */
export function requireBlobUpload(c: Context<AppEnv>): void {
  const key = requireAuth(c);
  if (key.is_operator) return;
  if ((computeTypeFilter(key, "write").allowed ?? []).length > 0) return;
  throw new MarfaError(
    ErrorCode.TYPE_NOT_PERMITTED,
    "Uploading a blob takes write on at least one type, and this credential's type permissions grant write on none.",
  );
}
