import {
  ErrorCode,
  MarfaError,
  edgePermissionCovers,
  listTypes,
  resolveTypePermission,
} from "@withmarfa/shared";
import type { ApiKey } from "@withmarfa/shared";
import type { Context } from "hono";
import {
  computeTypeFilter,
  getTypeFilter,
  mayWriteReserved,
  requireAuth,
  type AppEnv,
  standingRule,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { mayReadNamespace } from "./_extension-reach.js";

/** One answer for a blob that is not there and one the caller may not read. */
function blobNotFound(): MarfaError {
  return new MarfaError(ErrorCode.BLOB_NOT_FOUND, "Blob not found");
}

/** How a credential authenticated: a stored key, or a signed-in app's token. */
export type CredentialKind = "api_key" | "oauth";

/**
 * Who an upload is credited to. A stored key is itself. A signed-in app is
 * its grant, which its principal's source names, because a refresh replaces
 * the token between an upload and the write naming the bytes.
 */
export function blobPrincipal(key: ApiKey, kind: CredentialKind): string {
  return kind === "oauth" ? key.source : `key:${key.id}`;
}

function requestCredential(c: Context<AppEnv>): {
  key: ApiKey;
  kind: CredentialKind;
} {
  const key = requireAuth(c);
  return { key, kind: c.get("authType") === "oauth" ? "oauth" : "api_key" };
}

/**
 * Whether this credential may read the blob `hash` names, whether or not it
 * is registered.
 *
 * A blob belongs to no type, so it borrows its reach from what references
 * it, in every lifecycle state of the item involved, through the same type
 * predicate the item listings compile. An item's properties lend to a
 * credential that may read the item's type. An edge's properties lend to one
 * that may read the edge, which is its edge type by the edge map and its
 * source's type. An extension namespace lends to one that may read the
 * namespace by the extension map and the item's type. A reference lends only
 * once a write carrying it was made for a credential that proved it held the
 * bytes (`blobProof`), so writing a hash into a row one may write is never a
 * way to read the bytes behind it. Version snapshots keep a blob from the
 * orphan sweep and lend nothing.
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
  const { allowed, excluded } = computeTypeFilter(key, "read");
  if (!allowed || allowed.length === 0) return false;
  return storage.blobs.readableThrough(hash, {
    allowedTypes: allowed,
    excludedTypes: excluded,
    readsEdgeType: (edgeType) =>
      edgePermissionCovers(key.edge_permissions, edgeType, "read"),
    readsNamespace: (namespace) => mayReadNamespace(key, namespace),
  });
}

/**
 * The proof a write needs for a digest it carries to lend: the credential
 * sent those bytes, or may read the blob as the write is made, which is as
 * good as downloading and sending them again.
 */
export function blobProof(
  storage: Storage,
  key: ApiKey,
  kind: CredentialKind,
): (hash: string) => Promise<boolean> {
  const principal = blobPrincipal(key, kind);
  return async (hash) =>
    (await storage.blobs.uploadedBy(hash, principal)) ||
    (await mayReadBlob(key, storage, hash));
}

/** `blobProof` for the credential this request carries. */
export function requestBlobProof(
  c: Context<AppEnv>,
  storage: Storage,
): (hash: string) => Promise<boolean> {
  const { key, kind } = requestCredential(c);
  return blobProof(storage, key, kind);
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
 * reference it: write, through the item doors, on at least one type
 * registered when the request is made, since an item of any type can name a
 * blob in a string. A grant on a pattern naming no registered type writes
 * nothing. The operator key uploads without one. Answers the principal the
 * upload is credited to.
 */
export function requireBlobUpload(c: Context<AppEnv>): string {
  const { key, kind } = requestCredential(c);
  const writes =
    key.is_operator ||
    listTypes().some(
      (type) =>
        mayWriteReserved(key, type.id) &&
        resolveTypePermission(type.id, key.type_permissions) === "write",
    );
  if (!writes) {
    throw new MarfaError(
      ErrorCode.TYPE_NOT_PERMITTED,
      "Uploading a blob takes write on at least one registered type, and this credential's type permissions grant write on none.",
    );
  }
  return blobPrincipal(key, kind);
}

/** Asked of every caller of a door that reads a blob, before the request is
 *  read: a credential reaching no type reads no blob, and the operator key
 *  reads every one. */
export const readsBlobs = standingRule(
  "reads some type, or the operator key",
  (c) => {
    if (!requireAuth(c).is_operator) getTypeFilter(c);
  },
);

/** Asked of every caller of the upload door, before the request is read. */
export const uploadsBlobs = standingRule(
  "writes some type, or the operator key",
  (c) => {
    requireBlobUpload(c);
  },
);
