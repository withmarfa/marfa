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
  credentials: { username: string; password: string },
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

/** What a sign-in form's redirect says: the `error` it names and the wait it gives. */
export interface SignInAnswer {
  status: number;
  location: string;
  /** The `error` the redirect to the sign-in page carries; none when the form signed the owner in. */
  error: string | undefined;
  /** The `retry_after_seconds` the redirect carries when a limit refused the attempt. */
  wait: number | undefined;
}

export function signInAnswerOf(response: Response): SignInAnswer {
  const location = response.headers.get("location") ?? "";
  const query = new URL(location, "http://sign-in.invalid").searchParams;
  const wait = query.get("retry_after_seconds");
  return {
    status: response.status,
    location,
    error: query.get("error") ?? undefined,
    wait: wait === null ? undefined : Number(wait),
  };
}

/** What the form's answer was: `signed_in`, the `error` its redirect names, or the status of an answer that is no redirect. */
export function signInOutcome(response: Response): string {
  const answer = signInAnswerOf(response);
  if (answer.status !== 302) return String(answer.status);
  return answer.error ?? "signed_in";
}

/** The owner's session cookie from a password sign-in, or an error naming why there is none. */
export async function signInOwnerWithPassword(
  baseUrl: string,
  origin: string,
  credentials: { username: string; password: string },
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
  credentials: { username: string; password: string },
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
