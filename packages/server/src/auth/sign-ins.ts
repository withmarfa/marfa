import type { Item } from "@withmarfa/shared";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
import type { Storage } from "../storage/interface.js";
import { writeItem } from "../storage/item-write.js";
import {
  listActiveAppGrants,
  revokeProjectedGrant,
} from "./grant-lifecycle.js";
import type { MarfaAuth } from "./instance.js";
import { appSignInName, browserSignInName } from "./sign-in-names.js";

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
}

/** Who asks, for the audit rows the changes write. */
export interface SignInActor {
  /** The audit handle of the owner's session or the local command. */
  keyId: string;
  clientIp: string | null;
}

/** The longest name the owner can give a sign-in. */
export const SIGN_IN_NAME_MAX = 200;

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
  };
}

/**
 * Every live sign-in of the owner, oldest first. Before the instance has an
 * owner, nobody is signed in in a browser or through an app, and only keys
 * can reach it.
 */
export async function listSignIns(
  storage: Storage,
  auth: MarfaAuth,
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
  }));
  const apps: SignIn[] = [];
  for (const item of await listActiveAppGrants(storage)) {
    if (ownersLiveApp(item, ownerId)) apps.push(await appSignIn(storage, item));
  }
  const keys: SignIn[] = (await storage.keys.list()).map((key) => ({
    id: key.id,
    kind: "key",
    name: key.label,
    createdAt: key.created_at,
    lastUsedAt: key.last_used_at ?? null,
    expiresAt: key.expires_at ?? null,
    ipAddress: null,
    userAgent: null,
  }));
  return [...browsers, ...apps, ...keys].sort(
    (a, b) =>
      Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * End the live sign-in `id` of the owner, through the same change its own
 * door makes: a browser's session is deleted, an app's grant is revoked with
 * its tokens, refresh tokens, consent and device codes, and a key is revoked.
 * Each looks the sign-in up and ends it in one transaction, so of two ends of
 * one sign-in only the first ends it. Answers the kind it ended, or null when
 * no live sign-in of the owner has the id.
 */
export async function endSignIn(
  storage: Storage,
  auth: MarfaAuth,
  ownerId: string | null,
  id: string,
  actor: SignInActor,
): Promise<SignInKind | null> {
  if (ownerId && (await auth.endBrowserSession(ownerId, id, actor.clientIp)))
    return "browser";

  const grant = ownersLiveApp(await storage.items.get(id), ownerId);
  if (grant) {
    const revoked = await revokeProjectedGrant(storage, {
      itemId: id,
      clientId: grant.clientId,
      authUserId: grant.authUserId,
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
        },
      },
    });
    return revoked ? "app" : null;
  }

  const outcome = await runAuditedTransaction(
    storage,
    () => storage.keys.revoke(id),
    (result) =>
      result === "revoked"
        ? {
            client_ip: actor.clientIp,
            key_id: actor.keyId,
            action: "key.revoke",
            resource_type: "key",
            resource_id: id,
          }
        : null,
  );
  return outcome === "revoked" ? "key" : null;
}

/**
 * Give the live app or key `id` of the owner a new name. An app keeps it on
 * its grant's projection, beside the name it registered with; a key's name is
 * its label. A browser is named from what it reports and has no name of its
 * own to change. Answers the renamed sign-in, `"browser"` for a browser, or
 * null when no live sign-in of the owner has the id.
 */
export async function renameSignIn(
  storage: Storage,
  auth: MarfaAuth,
  ownerId: string | null,
  id: string,
  name: string,
  actor: SignInActor,
): Promise<SignIn | "browser" | null> {
  if (
    ownerId &&
    (await auth.listBrowserSessions(ownerId)).some((s) => s.id === id)
  )
    return "browser";

  const renamedApp = await runAuditedTransaction(
    storage,
    async (): Promise<Item | null> => {
      const grant = ownersLiveApp(await storage.items.get(id), ownerId);
      if (!grant) return null;
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
            resource_id:
              typeof item.properties.client_id === "string"
                ? item.properties.client_id
                : id,
            details: { grant_item_id: id },
          }
        : null,
  );
  if (renamedApp) return appSignIn(storage, renamedApp);

  const renamedKey = await runAuditedTransaction(
    storage,
    async () => {
      if (!(await storage.keys.get(id))) return null;
      return storage.keys.update(id, { label: name });
    },
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
  if (!renamedKey) return null;
  return {
    id: renamedKey.id,
    kind: "key",
    name: renamedKey.label,
    createdAt: renamedKey.created_at,
    lastUsedAt: renamedKey.last_used_at ?? null,
    expiresAt: renamedKey.expires_at ?? null,
    ipAddress: null,
    userAgent: null,
  };
}
