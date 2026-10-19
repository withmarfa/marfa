import type { Context } from "hono";
import { needsRecentSignIn } from "@withmarfa/shared";
import {
  isRecentOwnerAuthentication,
  type AppEnv,
} from "../middleware/auth.js";

/** The sign-in page, asking for the password again and returning to `returnTo`. */
export function signInAgainPath(returnTo: string): string {
  return `/auth/sign-in?prompt=login&return_to=${encodeURIComponent(returnTo)}`;
}

/**
 * The redirect that sends a browser session that signed in more than five
 * minutes ago to sign in again before a consent screen shows `requested`, or
 * `null` when the screen may be shown.
 *
 * The page asks the question the decision asks, so a person is never shown a
 * screen whose approval would be refused.
 */
export function signInAgainBeforeConsent(
  c: Context<AppEnv>,
  requested: readonly string[],
  held: readonly string[] | undefined,
  returnTo: string,
): Response | null {
  if (isRecentOwnerAuthentication(c) || !needsRecentSignIn(requested, held))
    return null;
  return c.redirect(signInAgainPath(returnTo), 302);
}
