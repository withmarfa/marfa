import type { Item } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import { listActiveAppGrants } from "./grant-lifecycle.js";
import { appRecordName } from "./sign-in-names.js";
import { ownersLiveApp } from "./sign-ins.js";
import { webOriginsOf } from "./web-origins.js";

/**
 * What a connected app is, as the owner would say it: a web page, the
 * `marfa` command line, or any other app. It is read from how the app
 * registered, so nothing is stored for it and nothing can disagree with the
 * registration.
 */
export type AppKind = "app" | "web" | "cli";

/**
 * The `software_id` the `marfa` command line registers under. RFC 7591 gives
 * every copy of one program the same `software_id`, which is what tells the
 * command line from another program that signs in with the device grant.
 */
export const COMMAND_LINE_SOFTWARE_ID = "so.marfa.cli";

/** What a client's registration says, as far as the kind of app is concerned. */
export interface RegisteredApp {
  applicationType: string | null;
  redirectUris: readonly string[];
  softwareId: string | null;
}

/**
 * The kind of app a registration describes. A client that registered the
 * command line's `software_id` is the command line; the grant it signs in
 * with says nothing, because any program without a browser can use the device
 * grant. A client that registered as a web page with an `https` address is a
 * web page, the same reading that decides which addresses an approval lets
 * call the API. Any other client is an app.
 *
 * A registration is all there is to go on, and any client may send any
 * `software_id`: another program that sends the command line's reads as the
 * command line, and a web client that registered only a loopback address reads
 * as an app. The kind is a label for the owner and decides no access.
 */
export function appKindOf(client: RegisteredApp | null): {
  kind: AppKind;
  origins: string[];
} {
  if (client === null) return { kind: "app", origins: [] };
  if (client.softwareId === COMMAND_LINE_SOFTWARE_ID)
    return { kind: "cli", origins: [] };
  const origins = webOriginsOf(client);
  return origins.length > 0
    ? { kind: "web", origins }
    : { kind: "app", origins: [] };
}

/** One app the owner has approved. */
export interface ConnectedApp {
  /** The id of the grant: the one `DELETE /owner/sign-ins/{id}` ends. */
  id: string;
  clientId: string;
  name: string;
  kind: AppKind;
  /** The web addresses an approved web page may call from, in registration order. */
  origins: string[];
  scopes: string[];
  grantedAt: string;
  lastUsedAt: string | null;
}

async function connectedApp(
  storage: Storage,
  item: Item,
  clientId: string,
): Promise<ConnectedApp> {
  const props = item.properties;
  const client = (await storage.oauthProvider?.getClient(clientId)) ?? null;
  const { kind, origins } = appKindOf(client);
  return {
    id: item.id,
    clientId,
    name: await appRecordName(storage, item),
    kind,
    origins,
    scopes: Array.isArray(props.scopes)
      ? props.scopes.filter(
          (scope): scope is string => typeof scope === "string",
        )
      : [],
    grantedAt:
      typeof props.granted_at === "string" ? props.granted_at : item.created_at,
    lastUsedAt:
      typeof props.last_used_at === "string" ? props.last_used_at : null,
  };
}

/** Every app the owner has approved and not disconnected, newest first. */
export async function listConnectedApps(
  storage: Storage,
  ownerId: string | null,
): Promise<ConnectedApp[]> {
  const apps: ConnectedApp[] = [];
  for (const item of await listActiveAppGrants(storage)) {
    const grant = ownersLiveApp(item, ownerId);
    if (grant !== null)
      apps.push(await connectedApp(storage, item, grant.clientId));
  }
  return apps.sort(
    (a, b) =>
      b.grantedAt.localeCompare(a.grantedAt) || a.name.localeCompare(b.name),
  );
}

/** The app whose grant has `id`, or null where no live grant of the owner has it. */
export async function findConnectedApp(
  storage: Storage,
  ownerId: string | null,
  id: string,
): Promise<ConnectedApp | null> {
  const item = await storage.items.get(id);
  const grant = ownersLiveApp(item, ownerId);
  return item === null || grant === null
    ? null
    : connectedApp(storage, item, grant.clientId);
}
