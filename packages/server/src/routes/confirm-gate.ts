import type { Context } from "hono";
import { needsRecentSignIn } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { RECENT_SIGN_IN_MS } from "../pages/recent-sign-in.js";
import type { ConfirmGate } from "../pages/parts/index.js";
import type { ChoosableType } from "./access-types.js";
import { contentSecurityPolicy } from "./content-security-policy.js";
import * as clock from "../clock.js";

/**
 * Milliseconds until the owner's sign-in stops counting as recent, which is
 * negative once it has, or `undefined` for a request that is not an owner's
 * browser session. A page that sends a large body reads it to open the dialog
 * before the upload starts, rather than after the server has refused it.
 */
export function signInLeft(c: Context<AppEnv>): number | undefined {
  const authority = c.get("authority");
  if (authority?.kind !== "owner") return undefined;
  return authority.authenticatedAt + RECENT_SIGN_IN_MS - clock.nowMs();
}

/**
 * What an approval page needs to ask the person to confirm it's them before it
 * sends an approval that the server would refuse for an old sign-in, or
 * `undefined` where no scope on the page can need one. Which scopes need it is
 * the question the decision asks (`needsRecentSignIn`), asked of each scope the
 * page offers against what the app already holds.
 */
export function confirmGateFor(
  c: Context<AppEnv>,
  appName: string,
  offered: readonly string[],
  held: readonly string[] | undefined,
  types: readonly ChoosableType[] = [],
): ConfirmGate | undefined {
  const left = signInLeft(c);
  if (left === undefined) return undefined;
  // Types chosen in place of all data post their own scopes, which are
  // written when the request asks to change all data.
  const chosen = offered.includes("*:write")
    ? types.map((type) => `${type.id}:write`)
    : [];
  const scopes = [...offered, ...chosen].filter((scope) =>
    needsRecentSignIn([scope], held),
  );
  if (scopes.length === 0) return undefined;
  // The dialog posts to this server, which the baseline policy does not allow.
  c.header(
    "Content-Security-Policy",
    `${contentSecurityPolicy(c.var.cspNonce)}; connect-src 'self'`,
  );
  return {
    left,
    scopes,
    why: `To let ${appName} change your data or control Marfa, confirm it's you.`,
  };
}
