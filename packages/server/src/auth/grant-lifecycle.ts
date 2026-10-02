import type { ApiKey } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import { writeItem } from "../storage/item-write.js";
import { withConsentLock } from "./consent-lock.js";
import { log } from "../middleware/logger.js";

/**
 * The transitions of a user-app grant that more than one door reaches.
 *
 * A grant is two records: the provider plugin's `auth_oauth_consent` row
 * and the `system.connection { kind: "app" }` projection Marfa keeps beside
 * it. Every transition has to move both, or the two disagree and the
 * disagreement is invisible: a consent row with no projection answers the
 * next authorize silently while the security page shows nothing to revoke,
 * and a projection with no consent row lists an app whose tokens the
 * plugin has already forgotten. The functions here are the one writer per
 * transition, called from the user-facing routes and from the plugin
 * hooks alike, so a door added later cannot move one record and not the
 * other.
 */

/**
 * The live keys an app minted.
 *
 * A key minted through a sign-in records the app that minted it, which is what
 * lets a revocation offer to take them. Both callers ask this rather than
 * filtering a key list of their own, so the offer counts exactly the rows the
 * revoke would take. `list` excludes revoked rows and rows past their
 * `expires_at`; no door stamps a lifetime onto an app-minted key today, so
 * the count and the sweep agree.
 */
export async function keysMintedByApp(
  storage: Storage,
  opts: { clientId: string | undefined },
): Promise<ApiKey[]> {
  if (!opts.clientId) return [];
  const keys = await storage.keys.list();
  return keys.filter((k) => k.oauth_client_id === opts.clientId);
}

/**
 * Flip a projected `system.connection { kind: "app" }` grant to revoked
 * and cascade through the OAuth Provider plugin's tables (access tokens,
 * refresh tokens, and the consent row itself).
 *
 * **The cascade runs first, and a failure aborts the whole thing.** A
 * revocation that cannot drop the tokens is a revocation that did not
 * happen — the app keeps working for the rest of every token's lifetime.
 * Writing "revoked" onto the record first would leave `/auth/security`
 * describing access the user no longer has while that access still
 * works: a comforting record of a change nobody made. Leaving the record
 * alone keeps it true, and the caller turns the throw into a visible
 * failure the user can retry.
 *
 * Runs under the consent lock for the (client, user) pair. The silent
 * re-authorization path on `GET /auth/authorize` reads the standing
 * scopes, lets the plugin rewrite them, then writes the read-back set;
 * a revocation landing inside that window would be undone by a
 * restoration computed before the user asked for it, and the app would
 * keep a fully-scoped consent row for a grant they revoked.
 */
export async function revokeProjectedGrant(
  storage: Storage,
  opts: {
    /** The projection to flip, or null when the grant has the plugin's
     *  records and no live projection: the tokens and consent row still go,
     *  through the same lock, and there is no record to rewrite. */
    itemId: string | null;
    properties?: Record<string, unknown>;
    clientId: string | undefined;
    authUserId: string | undefined;
    /**
     * Also revoke the keys this app minted.
     *
     * Off unless the caller asks, because a key is not a token: it was minted
     * deliberately, it appears on the person's own keys page, and it is meant
     * to outlive the session that made it. So the security page asks and the
     * API door takes an explicit flag, and the expiry sweep — which has nobody
     * to ask — leaves them alone.
     */
    revokeKeys?: boolean;
  },
): Promise<void> {
  const cascade = async (): Promise<void> => {
    if (
      opts.clientId &&
      opts.authUserId &&
      typeof storage.oauthProvider?.revokeTokensForGrant === "function"
    ) {
      await storage.oauthProvider.revokeTokensForGrant(
        opts.clientId,
        opts.authUserId,
      );
    }
    // No projection to flip and no device codes bound to one: the plugin's
    // records above were the whole of the grant.
    if (opts.itemId === null) return;
    // Device codes after the tokens, and before the record. An outstanding
    // approved device code is another thing that still mints access, since
    // a poll inside its remaining TTL is a token mint and with
    // `offline_access` the pair it hands back carries a refresh token
    // nothing later invalidates, so a revocation that leaves one behind is
    // a revocation that did not happen.
    //
    // **After the tokens, because this cascade aborts on a throw.** That is
    // the same position `revokeTokensForGrant` gives its own sibling sweep:
    // `revokeAuthorizationCodesForGrant` runs last, once the access tokens,
    // the refresh tokens and the consent row are already gone. Running this
    // one first would invert what a fault on the device-code table costs: a
    // lock or a corrupt index there would abort before the tokens went, so
    // the grant would stay active and every bearer would survive while
    // Disconnect stayed permanently non-functional. Sweeping last, the same
    // fault still kills every token and still leaves the record honestly
    // reading active.
    //
    // Keyed on the (client, user) pair the plugin's rows carry once a person
    // has claimed them, so a pending code nobody has claimed is left alone.
    if (
      opts.clientId &&
      opts.authUserId &&
      typeof storage.oauthProvider?.deleteDeviceCodesForGrant === "function"
    ) {
      await storage.oauthProvider.deleteDeviceCodesForGrant(
        opts.clientId,
        opts.authUserId,
      );
    }
    // Keys beside the device codes and for the same reason: a key this app
    // minted is standing access that outlives every token above it, so a
    // revocation asked to take them has not happened until they are gone.
    // Before the record flip, so a fault here leaves the projection honestly
    // reading active rather than describing a disconnection that stopped
    // half-way.
    if (opts.revokeKeys === true) {
      const keys = await keysMintedByApp(storage, {
        clientId: opts.clientId,
      });
      for (const key of keys) await storage.keys.revoke(key.id);
    }
    await writeItem(
      storage,
      { kind: "platform" },
      {
        op: "update",
        id: opts.itemId,
        properties: {
          ...opts.properties,
          status: "revoked",
          revoked_at: new Date().toISOString(),
        },
      },
    );
  };
  // Without both ids there is no consent row and nothing to race over,
  // and no key to lock on either. The state flip still stands as the
  // user-facing signal.
  if (!opts.clientId || !opts.authUserId) {
    await cascade();
    return;
  }
  await withConsentLock(opts.clientId, opts.authUserId, cascade);
}

/**
 * Emit the `auth.grant.reused` audit row for a silent re-authorization
 * (consent skipped because the prior grant already covers the request).
 * Distinct from `auth.grant.created` so the operator trail separates
 * "user clicked Approve" from "server reused an existing grant". The
 * lookups here are read-only — reuse never rewrites the projection.
 * Best-effort: a failure logs and never blocks the redirect.
 */
export async function auditGrantReused(
  storage: Storage,
  opts: {
    authUserId: string;
    clientId: string;
    scopes: string[];
    clientIp: string | null;
  },
): Promise<void> {
  try {
    let grantItemId: string | null = null;
    if (typeof storage.oauthProvider?.findGrantItemId === "function") {
      grantItemId = await storage.oauthProvider.findGrantItemId({
        clientId: opts.clientId,
        authUserId: opts.authUserId,
      });
    }
    await storage.audit.log({
      action: "auth.grant.reused",
      resource_type: "oauth_grant",
      resource_id: opts.clientId,
      client_ip: opts.clientIp,
      details: {
        client_id: opts.clientId,
        user_id: opts.authUserId,
        scopes: opts.scopes,
        grant_item_id: grantItemId,
      },
    });
  } catch (err) {
    log("warn", "consent skip: auth.grant.reused audit emit failed", {
      client_id: opts.clientId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Emit the `auth.grant.revoked` audit row. One shape for every revoke door,
 * so an operator reading the trail can filter on the action without
 * knowing which surface produced it; `source` names the surface only where
 * it is not the person acting on their own grant.
 *
 * Fire-and-forget on purpose: the revoke has already happened by the time
 * this runs, and an audit failure must not turn a completed revocation
 * into a user-visible error. `storage.audit.log` never rejects.
 */
export function auditGrantRevoked(
  storage: Storage,
  opts: {
    clientId: string | undefined;
    authUserId: string | undefined;
    grantItemId: string | null;
    clientIp: string | null;
    /** Set when the revocation came from the client presenting a refresh
     *  token at the RFC 7009 endpoint rather than from the person. */
    source?: "client" | "admin";
    /** The operator's key when an operator acted, so the trail names who,
     *  not only which surface. */
    keyId?: string;
  },
): void {
  void storage.audit.log({
    action: "auth.grant.revoked",
    resource_type: "oauth_grant",
    resource_id: opts.clientId ?? opts.grantItemId ?? "unknown",
    client_ip: opts.clientIp,
    ...(opts.keyId === undefined ? {} : { key_id: opts.keyId }),
    details: {
      client_id: opts.clientId,
      user_id: opts.authUserId,
      grant_item_id: opts.grantItemId,
      ...(opts.source === undefined ? {} : { source: opts.source }),
    },
  });
}
