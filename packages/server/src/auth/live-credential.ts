import type { ApiKey } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import { oauthPrincipal } from "../middleware/auth.js";
import type { CredentialKind } from "../routes/_blob-reach.js";

/** A credential as it stands now, for work that outlives its request. */
export interface LiveCredential {
  key: ApiKey;
  /** How it authenticates: a stored key, or a sign-in's token. */
  kind: CredentialKind;
  /** The permission literals it holds: a key's own list, or a sign-in's
   *  granted scopes, which is what `requirePermission` reads for each. */
  permissions: readonly string[];
}

export interface LiveCredentialOptions {
  /**
   * Whether a sign-in's token past its ordinary expiry still stands.
   *
   * A queued job says yes: the app refreshes to a new token under a new id
   * while the grant stands, and the job was queued under the old one. An
   * open event stream says no: it is the request the token was presented
   * on, and the bearer check would refuse that token now, so the stream
   * ends and the app reconnects with the token it refreshed to.
   */
  tokenOutlivesExpiry: boolean;
}

/**
 * Resolve a credential by its id as it stands now, or null where it no
 * longer does: a key revoked, deleted or past its expiry, or a sign-in
 * whose token is revoked or gone with its grant, which is what
 * disconnecting an app does.
 *
 * Long-lived work asks this again rather than keeping what its request was
 * allowed, as the bearer middleware asks before every request: a bulk-action
 * job before every chunk, an event stream before every batch of frames and
 * at every heartbeat. A key narrowed meanwhile answers with its narrowed
 * maps, so the work narrows with it.
 */
export async function resolveLiveCredential(
  storage: Storage,
  id: string | null,
  options: LiveCredentialOptions,
): Promise<LiveCredential | null> {
  if (id === null) return null;
  const key = await storage.keys.get(id);
  if (key) {
    if (key.expires_at && key.expires_at <= new Date().toISOString()) {
      return null;
    }
    return { key, kind: "api_key", permissions: key.permissions };
  }
  const token = await storage.oauthProvider?.getAccessTokenById(id);
  if (!token) return null;
  if (
    !options.tokenOutlivesExpiry &&
    token.expiresAtMs !== null &&
    token.expiresAtMs < Date.now()
  ) {
    return null;
  }
  return {
    key: oauthPrincipal(token),
    kind: "oauth",
    permissions: token.scopes,
  };
}
