import type { Context } from "hono";
import type { MarfaAuth } from "../auth/instance.js";
import { errorMessage } from "../error-text.js";
import type { AppEnv } from "../middleware/auth.js";
import { log } from "../middleware/logger.js";

/**
 * Whether a claim came from a browser on the instance's own page. The claim
 * doors admit two kinds of caller: a page at the instance's origin, which
 * always sends its `Origin`, and a script that sends no browser headers at
 * all (`requireOwnerOrigin`). Only the first has a browser to hold a cookie.
 */
export function isBrowserClaim(
  auth: Pick<MarfaAuth, "baseURL">,
  headers: Headers,
): boolean {
  return headers.get("origin") === new URL(auth.baseURL).origin;
}

/**
 * The `Set-Cookie` values of an owner session for a claim that has just
 * committed, or none when the claim did not come from a browser.
 *
 * The session is made by the password sign-in itself, dispatched in process
 * the way the sign-in page's form does, so its cookie, its lifetime, its
 * sign-in record and its audit row are the ones a later sign-in leaves, and
 * it counts as a sign-in within the last five minutes.
 *
 * The claim has committed by now, and nothing here may undo it. A sign-in
 * that fails leaves the owner claimed and the browser without a session, and
 * the person signs in at the page that follows.
 */
export async function ownerSessionCookies(
  c: Context<AppEnv>,
  auth: MarfaAuth,
  owner: { email: string },
  password: string,
): Promise<string[]> {
  if (!isBrowserClaim(auth, c.req.raw.headers)) return [];
  const headers = new Headers({
    "content-type": "application/json",
    origin: new URL(auth.baseURL).origin,
  });
  for (const name of ["user-agent", "accept-language"]) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  try {
    const response = await auth.handler(
      new Request(new URL("/auth/sign-in/email", auth.baseURL), {
        method: "POST",
        headers,
        body: JSON.stringify({ email: owner.email, password }),
      }),
      c.get("clientIp") ?? null,
    );
    if (response.ok) return response.headers.getSetCookie();
    log("warn", "The owner who just claimed could not be signed in", {
      status: response.status,
    });
  } catch (error) {
    log("warn", "The owner who just claimed could not be signed in", {
      error: errorMessage(error),
    });
  }
  return [];
}
