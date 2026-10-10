import { grantCoversScope } from "@withmarfa/shared";
import type { ApiKey, Item } from "@withmarfa/shared";
import { MAX_PAGE_LIMIT } from "../page-limits.js";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
import type { AuditLogEntry, Storage } from "../storage/interface.js";
import { writeItem } from "../storage/item-write.js";
import { withConsentLock } from "./consent-lock.js";

/**
 * The transitions of a user-app grant that more than one door reaches.
 *
 * A grant is two records: the provider plugin's `auth_oauth_consent` row
 * and the `system.connection { kind: "app" }` projection Marfa keeps beside
 * it. Every transition has to move both, or the two disagree and the
 * disagreement is invisible: a consent row with no projection answers the
 * next authorize silently while the Manage Marfa page shows nothing to revoke,
 * and a projection with no consent row lists an app whose tokens the
 * plugin has already forgotten. The functions here are the one writer per
 * transition, called from the user-facing routes and from the plugin
 * hooks alike, so a door added later cannot move one record and not the
 * other.
 */

/**
 * Every live app grant's projection, from every page, so a grant past the
 * first is not left out.
 */
export async function listActiveAppGrants(storage: Storage): Promise<Item[]> {
  const rows: Item[] = [];
  let cursor: string | undefined;
  do {
    const page = await storage.items.list({
      type: "system.connection",
      state: "active",
      limit: MAX_PAGE_LIMIT,
      cursor,
    });
    rows.push(...page.data);
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return rows.filter(
    (item) =>
      item.properties.kind === "app" && item.properties.status === "active",
  );
}

/**
 * The live keys an app minted.
 *
 * A key minted through a sign-in records the app that minted it, which is what
 * lets a revocation offer to take them. Both callers ask this rather than
 * filtering a key list of their own, so the offer counts exactly the rows the
 * revoke would take. `list` excludes revoked rows and rows past their
 * `expires_at`, so the count and the sweep agree.
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
 * Every database change and its audit share one transaction.
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
    clientId: string | undefined;
    authUserId: string | undefined;
    /**
     * Also revoke the keys this app minted.
     *
     * Off unless the caller asks, because a key is not a token: it was minted
     * deliberately, it appears in the person's own key list, and it is meant
     * to outlive the session that made it. So the Manage Marfa page offers it
     * as a separate button and the API door takes an explicit flag, and the
     * expiry sweep, which has nobody to ask, leaves them alone.
     */
    revokeKeys?: boolean;
    audit?: AuditLogEntry;
    /**
     * Asked inside the consent lock and the transaction, before anything is
     * revoked. A caller that decided to revoke from an earlier read asks
     * again here, so a grant used or approved again since is left alone.
     * When it answers false nothing is revoked or audited.
     */
    stillApplies?: () => Promise<boolean>;
  },
): Promise<boolean> {
  const cascade = async (): Promise<boolean> => {
    if (opts.stillApplies && !(await opts.stillApplies())) return false;
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
    // Claimed device codes can mint new tokens, so they belong to the same withdrawal.
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
    if (opts.revokeKeys === true) {
      const keys = await keysMintedByApp(storage, {
        clientId: opts.clientId,
      });
      for (const key of keys) await storage.keys.revoke(key.id);
    }
    if (opts.itemId === null) return true;
    await writeItem(
      storage,
      { kind: "platform" },
      {
        op: "update",
        id: opts.itemId,
        properties: {
          status: "revoked",
          revoked_at: new Date().toISOString(),
        },
      },
    );
    return true;
  };
  const commit = () =>
    runAuditedTransaction(storage, cascade, (revoked) =>
      revoked
        ? (opts.audit ?? {
            action: "auth.grant.revoked",
            resource_type: "oauth_grant",
            resource_id: opts.clientId ?? opts.itemId ?? undefined,
            details: {
              client_id: opts.clientId,
              user_id: opts.authUserId,
              grant_item_id: opts.itemId,
            },
          })
        : null,
    );
  // Without both ids there is no consent row and nothing to race over,
  // and no key to lock on either. The state flip still stands as the
  // user-facing signal.
  if (!opts.clientId || !opts.authUserId) return commit();
  return withConsentLock(opts.clientId, opts.authUserId, commit);
}

/**
 * Emit the `auth.grant.reused` audit row for a silent re-authorization
 * (consent skipped because the prior grant already covers the request).
 * Distinct from `auth.grant.created` so the operator trail separates
 * "user clicked Approve" from "server reused an existing grant". The
 * lookups here are read-only — reuse never rewrites the projection.
 * The observation is durable before an authorization response is returned.
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
  let grantItemId: string | null = null;
  if (typeof storage.oauthProvider?.findGrantItemId === "function") {
    grantItemId = await storage.oauthProvider.findGrantItemId({
      clientId: opts.clientId,
      authUserId: opts.authUserId,
    });
  }
  await runAuditedTransaction(storage, () => undefined, {
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
}

/** The caller owns the consent lock and transaction, including the provider consent write. */
export async function projectGrantOnConsent(
  storage: Storage,
  opts: {
    authUserId: string;
    clientId: string;
    scopes: string[];
    clientIp: string | null;
  },
): Promise<AuditLogEntry> {
  let itemId =
    (await storage.oauthProvider?.findGrantItemId({
      clientId: opts.clientId,
      authUserId: opts.authUserId,
    })) ?? null;
  const now = new Date().toISOString();
  if (itemId) {
    const existing = await storage.items.get(itemId);
    const prior = Array.isArray(existing?.properties.scopes)
      ? (existing.properties.scopes as string[])
      : [];
    if (prior.some((scope) => !grantCoversScope(opts.scopes, scope))) {
      if (!storage.oauthProvider)
        throw new Error("Credential storage is unavailable");
      await storage.oauthProvider.revokeAccessTokensForGrant(
        opts.clientId,
        opts.authUserId,
      );
    }
    const written = await writeItem(
      storage,
      { kind: "platform" },
      {
        op: "update",
        id: itemId,
        properties: {
          scopes: opts.scopes,
          status: "active",
          granted_at: now,
          revoked_at: undefined,
        },
      },
    );
    if (written.outcome !== "updated")
      throw new Error("Consent projection was not updated");
  } else {
    const { item } = await writeItem(
      storage,
      { kind: "platform" },
      {
        op: "create",
        type: "system.connection",
        state: "active",
        properties: {
          kind: "app",
          client_id: opts.clientId,
          user_id: opts.authUserId,
          scopes: opts.scopes,
          status: "active",
          granted_at: now,
        },
        source: "marfa/oauth2/consent",
      },
    );
    itemId = item.id;
  }
  return {
    action: "auth.grant.created",
    resource_type: "oauth_grant",
    resource_id: opts.clientId,
    client_ip: opts.clientIp,
    details: {
      client_id: opts.clientId,
      user_id: opts.authUserId,
      scopes: opts.scopes,
      grant_item_id: itemId,
    },
  };
}
