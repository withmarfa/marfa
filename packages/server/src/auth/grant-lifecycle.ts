import type { Storage } from "../storage/interface.js";
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
    spaceId: string | undefined;
    clientId: string | undefined;
    authUserId: string | undefined;
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
    // the refresh tokens and the consent row are already gone. The ordering
    // argument in the docstring above is about the record, not about which
    // sweep goes first, and running this one first inverts what a fault on
    // `oauth_device_codes` costs. A lock, a permissions change or a corrupt
    // index there would abort before `revokeTokensForGrant` had run, so the
    // grant would stay active, every bearer and refresh token would survive,
    // and Disconnect would be permanently non-functional while the app kept
    // full access. Sweeping last, the same fault still kills every token and
    // still leaves the record honestly reading active.
    //
    // Called here rather than from `revokeTokensForGrant` because
    // `oauth_device_codes` is Marfa's table and the provider store owns the
    // plugin's. This function is already the single writer for both revoke
    // doors and already holds the consent lock, so keeping the sweep here
    // means one writer rather than two that can drift apart.
    await storage.oauth.deleteDeviceCodesForGrant(opts.itemId);
    await storage.items.update(
      opts.itemId,
      {
        properties: {
          ...opts.properties,
          status: "revoked",
          revoked_at: new Date().toISOString(),
        },
      },
      opts.spaceId,
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
    let spaceId: string | undefined;
    if (storage.users) {
      const userRow = await storage.users.getByAuthUserId(opts.authUserId);
      spaceId = userRow?.space_id ?? undefined;
    }
    let grantItemId: string | null = null;
    if (typeof storage.oauthProvider?.findGrantItemId === "function") {
      grantItemId = await storage.oauthProvider.findGrantItemId({
        spaceId: spaceId ?? null,
        clientId: opts.clientId,
        authUserId: opts.authUserId,
      });
    }
    await storage.audit.log({
      space_id: spaceId ?? null,
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
    spaceId: string | undefined;
    clientId: string | undefined;
    authUserId: string | undefined;
    grantItemId: string | null;
    clientIp: string | null;
    /** Set when the revocation came from the client presenting a refresh
     *  token at the RFC 7009 endpoint rather than from the person. */
    source?: "client" | "admin";
    /** The operator's key when an operator acted, so the space's own trail
     *  names who, not only which surface. */
    keyId?: string;
  },
): void {
  void storage.audit.log({
    space_id: opts.spaceId ?? null,
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
