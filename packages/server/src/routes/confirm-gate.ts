import type { Context } from "hono";
import { needsRecentSignIn } from "@withmarfa/shared";
import { RECENT_SIGN_IN_MS, type AppEnv } from "../middleware/auth.js";
import type { ConfirmGate } from "../pages/parts/index.js";
import { contentSecurityPolicy } from "./content-security-policy.js";
import * as clock from "../clock.js";

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
): ConfirmGate | undefined {
  const authority = c.get("authority");
  if (authority?.kind !== "owner") return undefined;
  const scopes = offered.filter((scope) => needsRecentSignIn([scope], held));
  if (scopes.length === 0) return undefined;
  // The dialog posts to this server, which the baseline policy does not allow.
  c.header(
    "Content-Security-Policy",
    `${contentSecurityPolicy(c.var.cspNonce)}; connect-src 'self'`,
  );
  return {
    left: authority.authenticatedAt + RECENT_SIGN_IN_MS - clock.nowMs(),
    scopes,
    why: `To let ${appName} change your data or control Marfa, confirm it's you.`,
  };
}
