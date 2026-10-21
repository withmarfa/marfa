import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
import { sameScopeSet, scopesAreNarrower } from "../storage/consent-scopes.js";
import { writeItem } from "../storage/item-write.js";
import { withConsentLock } from "./consent-lock.js";
import { ownersLiveApp, type SignInActor } from "./sign-ins.js";

/** Both grant records and every token ceiling change in one audited commit. */
export async function narrowAppGrant(
  storage: Storage,
  ownerId: string | null,
  id: string,
  expected: readonly string[],
  wanted: readonly string[],
  actor: SignInActor,
): Promise<string[]> {
  const missing = () =>
    new MarfaError(
      ErrorCode.OAUTH_GRANT_NOT_FOUND,
      "No live app grant has this ID.",
    );
  const stale = () =>
    new MarfaError(
      ErrorCode.CONFLICT,
      "This app's access changed. Reload its page before saving.",
    );
  const seen = ownersLiveApp(await storage.items.get(id), ownerId);
  if (!seen) throw missing();
  // Capture immutable intent before waiting for another consent or retirement.
  const scopes = [...new Set(wanted)];
  const expectedScopes = [...expected];
  return withConsentLock(seen.clientId, seen.authUserId, () =>
    runAuditedTransaction(
      storage,
      async () => {
        const item = await storage.items.get(id);
        const current = ownersLiveApp(item, ownerId);
        const provider = storage.oauthProvider;
        if (current?.clientId !== seen.clientId || !provider) throw missing();
        const held = await provider.getPriorConsent(
          current.clientId,
          current.authUserId,
        );
        const projected = item?.properties.scopes;
        if (
          !held ||
          !Array.isArray(projected) ||
          !sameScopeSet(held, expectedScopes) ||
          !sameScopeSet(projected as string[], expectedScopes)
        )
          throw stale();
        if (!scopesAreNarrower(held, scopes))
          throw new MarfaError(
            ErrorCode.FORBIDDEN,
            "Access can only be reduced. The app must ask again for more access.",
          );
        if (sameScopeSet(held, scopes)) return scopes;
        if (
          !(await provider.setConsentScopes(
            current.clientId,
            current.authUserId,
            scopes,
            held,
          ))
        )
          throw stale();
        await provider.revokeTokensBeyondScopes(
          current.clientId,
          current.authUserId,
          scopes,
        );
        // Codes carry their earlier approval's ceiling and cannot survive its reduction.
        await provider.revokeAuthorizationCodesForGrant(
          current.clientId,
          current.authUserId,
        );
        await provider.deleteDeviceCodesForGrant(
          current.clientId,
          current.authUserId,
        );
        const written = await writeItem(
          storage,
          { kind: "platform", by: actor.writer },
          { op: "update", id, properties: { scopes } },
        );
        if (written.outcome !== "updated")
          throw new Error("The app's access was not written");
        return scopes;
      },
      {
        action: "auth.grant.narrowed",
        resource_type: "oauth_grant",
        resource_id: seen.clientId,
        key_id: actor.keyId,
        client_ip: actor.clientIp,
        details: { grant_item_id: id, scopes },
      },
    ),
  );
}
