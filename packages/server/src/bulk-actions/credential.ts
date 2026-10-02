import type { ApiKey } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import { oauthPrincipal } from "../middleware/auth.js";
import type { CredentialKind } from "../routes/_blob-reach.js";

/** The credential a bulk-action job acts for, as it stands now. */
export interface JobCredential {
  key: ApiKey;
  /** How it authenticates: a stored key, or a sign-in's token. */
  kind: CredentialKind;
  /** The permission literals it holds: a key's own list, or a sign-in's
   *  granted scopes, which is what `requirePermission` reads for each. */
  permissions: readonly string[];
}

/**
 * Resolve the credential that queued a job, or null where it no longer
 * stands: a key revoked, deleted or past its expiry, or a sign-in whose
 * token is revoked or gone with its grant. A sign-in's token reaching its
 * ordinary expiry does not end it, since the app refreshes to a new token
 * while the grant stands.
 *
 * A job runs after the request that queued it, so what the request was
 * allowed is not what the job is allowed: the worker asks this before
 * every chunk, as the bearer middleware asks before every request.
 */
export async function resolveJobCredential(
  storage: Storage,
  apiKeyId: string | null,
): Promise<JobCredential | null> {
  if (apiKeyId === null) return null;
  const key = await storage.keys.get(apiKeyId);
  if (key) {
    if (key.expires_at && key.expires_at <= new Date().toISOString()) {
      return null;
    }
    return { key, kind: "api_key", permissions: key.permissions };
  }
  const token = await storage.oauthProvider?.getAccessTokenById(apiKeyId);
  if (!token) return null;
  return {
    key: oauthPrincipal(token),
    kind: "oauth",
    permissions: token.scopes,
  };
}
