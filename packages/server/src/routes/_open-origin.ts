/**
 * The operations a page on any origin may call from a browser before the
 * owner has approved it: the discovery documents that name the endpoints,
 * and registration. A page needs both to open the approval window at all.
 *
 * Each takes no credential and answers nothing that belongs to the owner,
 * so it is answered with `Access-Control-Allow-Origin: *`. A browser lets no
 * page read that answer to a request it sent with cookies, and `app.ts`
 * keeps the cookie from registration. The answer is the same for every
 * origin, so a cache may hand it to any of them.
 * `_open-origin.test.ts` holds this list to the app's own route table.
 */
export const OPEN_TO_EVERY_ORIGIN: ReadonlyMap<string, readonly string[]> =
  new Map([
    ["/.well-known/oauth-authorization-server/auth", ["GET"]],
    ["/.well-known/openid-configuration/auth", ["GET"]],
    ["/auth/.well-known/oauth-authorization-server", ["GET"]],
    ["/auth/.well-known/openid-configuration", ["GET"]],
    ["/.well-known/oauth-protected-resource", ["GET"]],
    ["/.well-known/oauth-protected-resource/mcp", ["GET"]],
    ["/.well-known/oauth-protected-resource/mcp/schema", ["GET"]],
    ["/.well-known/oauth-protected-resource/mcp/admin", ["GET"]],
    ["/auth/oauth2/register", ["POST"]],
  ]);

/**
 * The methods `path` is open to every origin for, or undefined for a path
 * that is not. A preflight is open when the method it asks for is.
 */
export function openMethodsFor(
  method: string,
  path: string,
  preflightMethod: string | undefined,
): readonly string[] | undefined {
  const methods = OPEN_TO_EVERY_ORIGIN.get(path);
  if (methods === undefined) return undefined;
  const asked = method === "OPTIONS" ? preflightMethod?.toUpperCase() : method;
  return asked !== undefined && methods.includes(asked) ? methods : undefined;
}
