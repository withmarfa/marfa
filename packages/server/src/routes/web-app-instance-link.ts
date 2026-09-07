/**
 * The link back to the web app's instance picker, shown on the sign-in page.
 *
 * The web app connects to a server the moment it loads and hands the browser
 * straight here, so somebody on a first visit who wanted a different server is
 * already looking at this page by the time they realize it. The app cannot
 * offer them anything at that point — its own screen is gone — but this page
 * can hand them back to it.
 *
 * **Nothing here is taken on trust.** The only request-supplied value that
 * reaches the rendered href is `redirect_uri`, and it is emitted only after
 * exact membership of the client's own registered list. That check is what
 * stops the sign-in page becoming an open redirect wearing a helpful label:
 * without it, anyone could hand a signed-in person a `/auth/sign-in` URL whose
 * "Use a different Marfa server" link pointed at their own site.
 *
 * The destination is the client's origin rather than a hardcoded host, so a
 * self-hosted web app is served by the same code that serves `app.marfa.so`.
 */
import type { Storage } from "../storage/interface.js";
import { MARFA_WEB_CLIENT_ID } from "../auth/first-party-clients.js";

/** Parsing base for a `return_to`, which is a path and query rather than an
 *  absolute URL. Never emitted: only the parameters are read back out. */
const RELATIVE_BASE = "http://return-to.invalid";

/**
 * Where to send somebody who wants a different server, or `undefined` when
 * this sign-in is not for the first-party web app.
 *
 * `undefined` is the answer for every ordinary reason as well as every
 * suspicious one — another client, a sign-in reached directly, a
 * `redirect_uri` the client never registered — because the page renders the
 * link only when it has somewhere it has proved it can send them.
 */
export async function resolveWebAppInstanceLink(
  storage: Storage,
  returnTo: string,
  authBaseUrl: string | undefined,
): Promise<string | undefined> {
  if (!authBaseUrl) return undefined;

  let params: URLSearchParams;
  try {
    params = new URL(returnTo, RELATIVE_BASE).searchParams;
  } catch {
    return undefined;
  }

  const clientId = params.get("client_id");
  if (clientId !== MARFA_WEB_CLIENT_ID) return undefined;

  const redirectUri = params.get("redirect_uri");
  if (!redirectUri) return undefined;

  const client = await storage.oauthProvider?.getClient(clientId);
  // Exact membership, matching how the provider itself compares a redirect.
  // A prefix or origin comparison here would admit a URI the client never
  // registered, which is the whole of what this check is for.
  if (!client?.redirectUris.includes(redirectUri)) return undefined;

  let appOrigin: string;
  let instanceOrigin: string;
  try {
    appOrigin = new URL(redirectUri).origin;
    instanceOrigin = new URL(authBaseUrl).origin;
  } catch {
    return undefined;
  }

  // The app reads `?instance=` at boot and opens its picker with the value
  // prefilled, so naming this server is what puts the person in front of the
  // field holding where they are, ready to change it.
  return `${appOrigin}/?instance=${encodeURIComponent(instanceOrigin)}`;
}
