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
  const response = await fetch(`${baseUrl}/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: new URL(baseUrl).origin,
    },
    body: JSON.stringify(credentials),
  });
  if (!response.ok)
    throw new Error(`Owner sign-in answered ${response.status}`);
  const next = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("marfa.auth.session_token="))
    ?.split(";")[0];
  if (!next) throw new Error("Owner sign-in set no cookie");
  return next;
}
