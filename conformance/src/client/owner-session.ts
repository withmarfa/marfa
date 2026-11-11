/** The owner's session cookie in a `Set-Cookie` header, whatever its name. */
const SESSION_COOKIE = /(?:^|,\s*)([\w.-]*session(?:_token)?=[^;]+)/;

/** The session cookie a sign-in's answer sets, if it sets one. */
export function sessionCookieOf(response: Response): string | undefined {
  return SESSION_COOKIE.exec(response.headers.get("set-cookie") ?? "")?.[1];
}

/**
 * A password sign-in through the sign-in page's form, which every server
 * with a sign-in page serves. The answer is a redirect, back to the page
 * with an `error` when the sign-in failed.
 */
export async function postSignInForm(
  baseUrl: string,
  origin: string,
  credentials: { email: string; password: string },
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/auth/sign-in`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      ...headers,
    },
    body: new URLSearchParams(credentials),
  });
}

/** The owner's session cookie from a password sign-in, or an error naming why there is none. */
export async function signInOwnerWithPassword(
  baseUrl: string,
  origin: string,
  credentials: { email: string; password: string },
  headers: Record<string, string> = {},
): Promise<string> {
  const response = await postSignInForm(baseUrl, origin, credentials, headers);
  await response.body?.cancel();
  const location = response.headers.get("location") ?? "";
  if (response.status !== 302 && response.status !== 303)
    throw new Error(`Owner sign-in answered ${String(response.status)}`);
  if (/[?&]error=/.test(location))
    throw new Error(`Owner sign-in was refused: ${location}`);
  const cookie = sessionCookieOf(response);
  if (!cookie) throw new Error("Owner sign-in set no session cookie");
  return cookie;
}

/**
 * The owner's session cookie for the sign-in pages' fixtures: the one given,
 * while the passkey page, a door the session counts on, still admits it, or
 * a fresh password sign-in.
 */
export async function authenticateOwner(
  baseUrl: string,
  cookie: string | undefined,
  credentials: { email: string; password: string },
): Promise<string> {
  if (cookie) {
    const current = await fetch(`${baseUrl}/owner/passkeys`, {
      headers: { cookie },
    });
    await current.body?.cancel();
    if (current.ok) return cookie;
    if (current.status !== 401)
      throw new Error(`Owner session check answered ${current.status}`);
  }
  return signInOwnerWithPassword(baseUrl, new URL(baseUrl).origin, credentials);
}
