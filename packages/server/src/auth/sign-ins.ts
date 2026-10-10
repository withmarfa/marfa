import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { Item } from "@withmarfa/shared";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
import type { StoredApiKey, Storage } from "../storage/interface.js";
import { writeItem } from "../storage/item-write.js";
import { withConsentLock } from "./consent-lock.js";
import {
  listActiveAppGrants,
  revokeProjectedGrant,
} from "./grant-lifecycle.js";
import type { MarfaAuth } from "./instance.js";
import type { KeysInReach } from "./key-reach.js";
import {
  appSignInName,
  browserSignInName,
  keySignInName,
} from "./sign-in-names.js";

/**
 * The owner's sign-ins: every way the owner's Marfa can be reached. A browser
 * is one of the owner's sessions, an app is one app's grant for the owner,
 * and a key is a live key. Each is named by the id of the record it already
 * is (the session, the grant's projection, the key), so ending one through
 * here and through its own door are one change to one record.
 */
export type SignInKind = "browser" | "app" | "key";

export interface SignIn {
  id: string;
  kind: SignInKind;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  /** For a key an app minted, that app's sign-in while it is live. */
  mintedBy: string | null;
}

/** Who asks, for the audit rows the changes write. */
export interface SignInActor {
  /** The audit handle of the owner's session or the local command. */
  keyId: string;
  clientIp: string | null;
}

/** The app grant `item` is, when it is a live one of the owner. */
function ownersLiveApp(
  item: Item | null,
  ownerId: string | null,
): { clientId: string; authUserId: string } | null {
  if (
    ownerId === null ||
    item?.type !== "system.connection" ||
    item.state !== "active"
  )
    return null;
  const props = item.properties;
  if (props.kind !== "app" || props.status !== "active") return null;
  if (typeof props.client_id !== "string" || props.user_id !== ownerId)
    return null;
  return { clientId: props.client_id, authUserId: ownerId };
}

async function appSignIn(storage: Storage, item: Item): Promise<SignIn> {
  const props = item.properties;
  const clientId = typeof props.client_id === "string" ? props.client_id : "";
  const client = clientId
    ? await storage.oauthProvider?.getClient(clientId)
    : null;
  return {
    id: item.id,
    kind: "app",
    name: appSignInName(
      typeof props.name === "string" ? props.name : undefined,
      client?.name,
      clientId,
    ),
    createdAt:
      typeof props.granted_at === "string" ? props.granted_at : item.created_at,
    lastUsedAt:
      typeof props.last_used_at === "string" ? props.last_used_at : null,
    expiresAt: null,
    ipAddress: null,
    userAgent: null,
    mintedBy: null,
  };
}

function keySignIn(key: StoredApiKey, mintedBy: string | null): SignIn {
  return {
    id: key.id,
    kind: "key",
    name: keySignInName(key.label, key.id),
    createdAt: key.created_at,
    lastUsedAt: key.last_used_at ?? null,
    expiresAt: key.expires_at ?? null,
    ipAddress: null,
    userAgent: null,
    mintedBy,
  };
}

/** The live app sign-in of the owner that `clientId` names, if any. */
async function liveAppOf(
  storage: Storage,
  ownerId: string | null,
  clientId: string | undefined,
): Promise<string | null> {
  if (!ownerId || !clientId) return null;
  const itemId = await storage.oauthProvider?.findGrantItemId({
    clientId,
    authUserId: ownerId,
  });
  if (!itemId) return null;
  return ownersLiveApp(await storage.items.get(itemId), ownerId)
    ? itemId
    : null;
}

/**
 * Every live sign-in of the owner, oldest first. Before the instance has an
 * owner, nobody is signed in in a browser or through an app, and only keys
 * can reach it.
 */
export async function listSignIns(
  storage: Storage,
  auth: MarfaAuth,
  keys: KeysInReach,
  ownerId: string | null,
): Promise<SignIn[]> {
  const sessions = ownerId ? await auth.listBrowserSessions(ownerId) : [];
  const browsers: SignIn[] = sessions.map((session) => ({
    id: session.id,
    kind: "browser",
    name: browserSignInName(session.userAgent),
    createdAt: session.createdAt.toISOString(),
    lastUsedAt: session.lastUsedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    ipAddress: session.ipAddress,
    userAgent: session.userAgent,
    mintedBy: null,
  }));
  const grants = (await listActiveAppGrants(storage)).filter(
    (item) => ownersLiveApp(item, ownerId) !== null,
  );
  const apps = await Promise.all(
    grants.map((item) => appSignIn(storage, item)),
  );
  const appByClient = new Map(
    grants.map((item) => [item.properties.client_id as string, item.id]),
  );
  const keyRows = (await keys.list()).map((key) =>
    keySignIn(
      key,
      key.oauth_client_id === undefined
        ? null
        : (appByClient.get(key.oauth_client_id) ?? null),
    ),
  );
  return [...browsers, ...apps, ...keyRows].sort(
    (a, b) =>
      Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * What an end did: the kind it ended, `"not_app"` where `revoke_keys` named
 * a live browser or key, or null where no live sign-in of the owner has the
 * id.
 */
export type EndOutcome = SignInKind | "not_app" | null;

/**
 * End the live sign-in `id` of the owner, through the same change its own
 * door makes: a browser's session is deleted, an app's grant is revoked with
 * its tokens, refresh tokens, consent and device codes, and a key is revoked.
 * The keys an app minted go with it only where `revokeKeys` says so, as at
 * Disconnect. Each looks the sign-in up and ends it in one transaction, so of
 * two ends of one sign-in only the first ends it.
 */
export async function endSignIn(
  storage: Storage,
  auth: MarfaAuth,
  keys: KeysInReach,
  ownerId: string | null,
  id: string,
  actor: SignInActor,
  options: { revokeKeys: boolean },
): Promise<EndOutcome> {
  if (
    !options.revokeKeys &&
    ownerId &&
    (await auth.endBrowserSession(ownerId, id, actor.clientIp))
  )
    return "browser";

  const grant = ownersLiveApp(await storage.items.get(id), ownerId);
  if (grant) {
    const revoked = await revokeProjectedGrant(storage, {
      itemId: id,
      clientId: grant.clientId,
      authUserId: grant.authUserId,
      revokeKeys: options.revokeKeys,
      stillApplies: async () =>
        ownersLiveApp(await storage.items.get(id), ownerId) !== null,
      audit: {
        key_id: actor.keyId,
        action: "auth.grant.revoked",
        resource_type: "oauth_grant",
        resource_id: grant.clientId,
        client_ip: actor.clientIp,
        details: {
          client_id: grant.clientId,
          user_id: grant.authUserId,
          grant_item_id: id,
          revoke_keys: options.revokeKeys,
        },
      },
    });
    if (revoked) return "app";
  }

  if (options.revokeKeys)
    return (await isLiveBrowserOrKey(auth, keys, ownerId, id))
      ? "not_app"
      : null;

  const revoked = await runAuditedTransaction(
    storage,
    () => unlessNoKey(keys.revoke(id).then(() => true)),
    (result) =>
      result
        ? {
            client_ip: actor.clientIp,
            key_id: actor.keyId,
            action: "key.revoke",
            resource_type: "key",
            resource_id: id,
          }
        : null,
  );
  return revoked ? "key" : null;
}

/**
 * Give the live app or key `id` of the owner a new name. An app keeps it on
 * its grant's projection, beside the name it registered with, written under
 * the grant's consent lock so it cannot land on a grant revoked a moment
 * earlier; a key's name is its label. A browser is named from what it
 * reports and has no name of its own to change. Answers the renamed sign-in,
 * `"browser"` for a live browser, or null when no live sign-in of the owner
 * has the id.
 */
export async function renameSignIn(
  storage: Storage,
  auth: MarfaAuth,
  keys: KeysInReach,
  ownerId: string | null,
  id: string,
  name: string,
  actor: SignInActor,
): Promise<SignIn | "browser" | null> {
  const seen = ownersLiveApp(await storage.items.get(id), ownerId);
  if (seen) {
    const renamed = await withConsentLock(seen.clientId, seen.authUserId, () =>
      runAuditedTransaction(
        storage,
        async (): Promise<Item | null> => {
          const grant = ownersLiveApp(await storage.items.get(id), ownerId);
          if (grant?.clientId !== seen.clientId) return null;
          const written = await writeItem(
            storage,
            { kind: "platform" },
            { op: "update", id, properties: { name } },
          );
          if (written.outcome !== "updated")
            throw new Error("The sign-in's name was not written");
          return written.item;
        },
        (item) =>
          item
            ? {
                client_ip: actor.clientIp,
                key_id: actor.keyId,
                action: "auth.grant.rename",
                resource_type: "oauth_grant",
                resource_id: seen.clientId,
                details: { grant_item_id: id },
              }
            : null,
      ),
    );
    if (renamed) return appSignIn(storage, renamed);
  }

  const renamedKey = await runAuditedTransaction(
    storage,
    () => unlessNoKey(keys.change(id, () => ({ label: name }))),
    (key) =>
      key
        ? {
            client_ip: actor.clientIp,
            key_id: actor.keyId,
            action: "key.update",
            resource_type: "key",
            resource_id: id,
            details: { fields: ["label"] },
          }
        : null,
  );
  if (renamedKey)
    return keySignIn(
      renamedKey,
      await liveAppOf(storage, ownerId, renamedKey.oauth_client_id),
    );

  return ownerId &&
    (await auth.listBrowserSessions(ownerId)).some((s) => s.id === id)
    ? "browser"
    : null;
}

/** Whether `id` names a live browser session of the owner or a live key. */
async function isLiveBrowserOrKey(
  auth: MarfaAuth,
  keys: KeysInReach,
  ownerId: string | null,
  id: string,
): Promise<boolean> {
  if (
    ownerId &&
    (await auth.listBrowserSessions(ownerId)).some((s) => s.id === id)
  )
    return true;
  return (await keys.list()).some((key) => key.id === id);
}

/** What `work` answers, or null where it found no live key with the id. */
async function unlessNoKey<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work;
  } catch (error) {
    if (
      error instanceof MarfaError &&
      error.code === ErrorCode.API_KEY_NOT_FOUND
    )
      return null;
    throw error;
  }
}
