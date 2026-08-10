/**
 * Telling a provider's response parameters apart from a client's own.
 *
 * A registered redirect URI may carry a query, and registration does not
 * forbid it naming a parameter the OAuth response also uses. Dynamic client
 * registration is unauthenticated, so anyone can register such a URI. Any
 * check that reads a parameter's mere presence on the returned callback is
 * therefore reading something the client chose, which is how a client whose
 * URI contains `code=` can silence every genuine refusal it receives.
 *
 * The question that actually matters is whether the server *added* the
 * parameter, and answering it means diffing the returned URI against the
 * registered one.
 */

/**
 * The query parameters this OAuth Provider implementation adds to a
 * registered redirect URI. They are removed from both sides during callback
 * matching: a client may already have one in its registered URI, and the
 * provider replaces or appends the response value. Removing any other
 * parameter would let a callback with missing or changed fixed registration
 * data pass as the registered URI.
 */
const OAUTH_RESPONSE_PARAMS = new Set([
  "code",
  "error",
  "error_description",
  "iss",
  "state",
]);

/**
 * Match a returned OAuth callback to a registered redirect URI while
 * ignoring only the response parameters the authorization server adds.
 *
 * `URL.origin` cannot represent native custom schemes (it is the literal
 * string `"null"` for all of them), so scheme, authority, and path are
 * compared directly. Fixed registered query parameters remain load-bearing:
 * both URLs must contain the same non-response key/value multiset after the
 * OAuth response fields are removed from each side.
 */
export function findRegisteredResponseRedirect(
  registeredRedirectUris: readonly string[],
  candidate: string,
): URL | undefined {
  let returned: URL;
  try {
    returned = new URL(candidate);
  } catch {
    return undefined;
  }

  for (const entry of registeredRedirectUris) {
    let registered: URL;
    try {
      registered = new URL(entry);
    } catch {
      continue;
    }

    const loopback =
      registered.hostname === "127.0.0.1" ||
      registered.hostname === "::1" ||
      registered.hostname === "[::1]";
    if (
      registered.protocol !== returned.protocol ||
      registered.username !== returned.username ||
      registered.password !== returned.password ||
      registered.hostname !== returned.hostname ||
      (!loopback && registered.port !== returned.port) ||
      registered.pathname !== returned.pathname ||
      registered.hash !== returned.hash
    ) {
      continue;
    }

    const registeredQuery = [...registered.searchParams.entries()]
      .filter(([key]) => !OAUTH_RESPONSE_PARAMS.has(key))
      .sort(compareQueryEntry);
    const returnedQuery = [...returned.searchParams.entries()]
      .filter(([key]) => !OAUTH_RESPONSE_PARAMS.has(key))
      .sort(compareQueryEntry);
    if (queryEntriesEqual(registeredQuery, returnedQuery)) return registered;
  }
  return undefined;
}

export function isRegisteredResponseRedirect(
  registeredRedirectUris: readonly string[],
  candidate: string,
): boolean {
  return (
    findRegisteredResponseRedirect(registeredRedirectUris, candidate) !==
    undefined
  );
}

function compareQueryEntry(
  a: readonly [string, string],
  b: readonly [string, string],
): number {
  return a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]);
}

function queryEntriesEqual(
  a: readonly (readonly [string, string])[],
  b: readonly (readonly [string, string])[],
): boolean {
  return (
    a.length === b.length &&
    a.every(([key, value], index) => {
      const other = b[index];
      return other?.[0] === key && other[1] === value;
    })
  );
}

/**
 * Did the provider add or replace a response parameter rather than merely
 * preserve a fixed value from the registered URI? This distinction matters
 * when, for example, an error callback retains a fixed `code` query pair:
 * that pair must not turn the error into a successful-code outcome.
 */
export function hasAddedResponseParam(
  registered: URL,
  returned: URL,
  key: string,
): boolean {
  const registeredCounts = new Map<string, number>();
  for (const value of registered.searchParams.getAll(key)) {
    registeredCounts.set(value, (registeredCounts.get(value) ?? 0) + 1);
  }
  for (const value of returned.searchParams.getAll(key)) {
    const remaining = registeredCounts.get(value) ?? 0;
    if (remaining === 0) return true;
    registeredCounts.set(value, remaining - 1);
  }
  return false;
}

/**
 * Whether the authorization server itself produced `key` on this callback.
 * `requestedRedirectUri` is the URI the request named, which the plugin has
 * already validated against the client's registration, so it is a
 * registered URI by the time any response is being classified.
 *
 * False whenever the callback cannot be matched to it, which covers an
 * internal bounce and a relative Location: neither is a client callback, so
 * nothing on it was added for the client.
 */
export function serverAddedResponseParam(
  requestedRedirectUri: string | null | undefined,
  location: string,
  key: string,
): boolean {
  if (!requestedRedirectUri) return false;
  const registered = findRegisteredResponseRedirect(
    [requestedRedirectUri],
    location,
  );
  if (!registered) return false;
  let returned: URL;
  try {
    returned = new URL(location);
  } catch {
    return false;
  }
  return hasAddedResponseParam(registered, returned, key);
}
