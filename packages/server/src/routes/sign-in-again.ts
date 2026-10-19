import type { Context } from "hono";
import { ErrorCode, MarfaError, needsRecentSignIn } from "@withmarfa/shared";
import {
  isRecentOwnerAuthentication,
  SIGN_IN_AGAIN_MESSAGE,
  type AppEnv,
} from "../middleware/auth.js";
import { prefersHtml } from "./http-error-page.js";
import { setNoStore } from "./no-store.js";

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

/**
 * The answer to a consent decision a stale session was refused: a browser
 * that submitted the form is sent back to sign in again and then to the screen
 * it was on, and every other caller gets the refusal as it was thrown.
 */
export function answerSignInAgain(
  c: Context<AppEnv>,
  refusal: unknown,
  returnTo: string,
): Response {
  if (
    refusal instanceof MarfaError &&
    refusal.code === ErrorCode.FORBIDDEN &&
    refusal.message === SIGN_IN_AGAIN_MESSAGE &&
    prefersHtml(c.req.header("accept"))
  ) {
    setNoStore(c);
    return c.redirect(signInAgainPath(returnTo), 303);
  }
  throw refusal;
}
