import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { ApiKey } from "@withmarfa/shared";
import type { Context } from "hono";
import {
  computeTypeFilter,
  getTypeFilter,
  isReservedCredentialSource,
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
 * Who a blob upload and a reference are credited to. A stored key is itself,
 * an app's own included. A signed-in app's token is its grant, named by the
 * source only a sign-in can carry, because a refresh replaces the token
 * between an upload and the write naming it.
 */
export function blobPrincipal(key: ApiKey): string {
  return isReservedCredentialSource(key.source) ? key.source : `key:${key.id}`;
}

/**
 * Whether this credential may read the blob `hash` names, whether or not it
 * is registered.
 *
 * A blob belongs to no type, so it borrows its reach from the items whose
 * properties reference it, in every lifecycle state, through the same
 * predicate the item read doors ask. A reference lends only when the
 * credential whose write introduced it has uploaded the bytes too, so
 * writing a hash into a row one may write is never a way to read the bytes
 * behind it: sending the bytes is the proof of holding them. Extensions,
 * edge properties and version snapshots keep a blob from the orphan sweep
 * and lend nothing.
 *
 * The operator key holds no type permission and stands outside the model;
 * it reads every blob.
 */
export async function mayReadBlob(
  key: ApiKey,
  storage: Storage,
  hash: string,
): Promise<boolean> {
  if (key.is_operator) return true;
  const types = await storage.blobs.lendingTypes(hash);
  return types.some((type) => mayReadType(key, type));
}

/**
 * The registered blob `hash` names, if the credential may read it, and
 * `blob_not_found`, exactly as an unknown hash answers, otherwise. Every
 * door that serves a blob's bytes, a link to them or its location log asks
 * `mayReadBlob`, through here or directly; `blob-door-census.test.ts` fails
 * on one that does not.
 */
export async function requireReadableBlob(
  c: Context<AppEnv>,
  storage: Storage,
  hash: string,
): Promise<{ mime_type: string; size_bytes: number }> {
  const key = requireAuth(c);
  if (!key.is_operator) getTypeFilter(c);
  if (!(await mayReadBlob(key, storage, hash))) throw blobNotFound();
  const record = await storage.blobs.get(hash);
  if (!record) throw blobNotFound();
  return record;
}

/**
 * Admit an upload only from a credential that could write an item to
 * reference it: write on at least one type, whichever, since an item of any
 * type can name a blob in a string. The operator key uploads without one.
 */
export function requireBlobUpload(c: Context<AppEnv>): ApiKey {
  const key = requireAuth(c);
  if (key.is_operator) return key;
  if ((computeTypeFilter(key, "write").allowed ?? []).length > 0) return key;
  throw new MarfaError(
    ErrorCode.TYPE_NOT_PERMITTED,
    "Uploading a blob takes write on at least one type, and this credential's type permissions grant write on none.",
  );
}
