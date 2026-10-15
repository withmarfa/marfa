/**
 * The browser origins an approval allows.
 *
 * A web page connects the way an app does, and approving it lets its address
 * call the API across origins. The address is taken from what the page
 * registered and the consent screen shows, never from the `Origin` a browser
 * reports, because registration needs no credential: only the owner's
 * approval makes an address trusted.
 *
 * Nothing is stored for it. An origin is allowed exactly while a live grant's
 * client registered a redirect URI on it, so every door that ends a grant
 * forgets the address with it, and an address two grants share stays until
 * the last of them ends. The connected apps list and this check read the same
 * grants, so an address is allowed exactly while its app is listed.
 *
 * The origin reaches cross-origin requests and nothing else: the form-origin
 * gate (`routes/_cross-origin.ts`) and the sign-in library's trusted origins
 * are built from `CORS_ORIGINS` and the issuer alone.
 */
import { errorMessage } from "../error-text.js";
import { log } from "../middleware/logger.js";
import type { Storage } from "../storage/interface.js";

/** What a client's registration says about where it lives. */
export interface RegisteredClient {
  applicationType: string | null;
  redirectUris: readonly string[];
}

/**
 * The origin of a redirect URI a web page registered, or undefined for one
 * that names no web page. Registration holds a web client to `https` off the
 * loopback; the scheme is checked again so that a row written any other way
 * cannot make a custom scheme or plain `http` into a browser origin.
 */
function pageOrigin(redirectUri: string): string | undefined {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  // WHATWG serialization lowercases the host and drops the default port, so
  // a path, a query, a trailing slash or `:443` leaves the same origin.
  return url.origin;
}

/**
 * The origins a client's approval allows: one per distinct origin among its
 * redirect URIs, in registration order, and none for a native app, whose
 * redirect URI is where a program on a device listens rather than a page.
 */
export function webOriginsOf(client: RegisteredClient): string[] {
  if (client.applicationType !== "web") return [];
  const origins: string[] = [];
  for (const uri of client.redirectUris) {
    const origin = pageOrigin(uri);
    if (origin !== undefined && !origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/**
 * Whether a live grant allows `origin`, the serialized `Origin` a browser
 * sent. Read per request, so a grant that ends stops allowing its address
 * with no cache to clear. A storage failure answers false: a request the
 * server cannot vouch for is refused, never allowed.
 */
export async function isApprovedWebOrigin(
  storage: Storage,
  origin: string,
): Promise<boolean> {
  const store = storage.oauthProvider;
  if (!store || !origin.startsWith("https://")) return false;
  try {
    const clients = await store.listLiveGrantClients();
    return clients.some((client) => webOriginsOf(client).includes(origin));
  } catch (err) {
    log("warn", "cors: approved origins could not be read", {
      error: errorMessage(err),
    });
    return false;
  }
}
