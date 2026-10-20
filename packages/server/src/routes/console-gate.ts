/**
 * Who may open a console page in a browser.
 *
 * A console page is the owner's. A browser that asks for one without the
 * owner's session is sent to sign in and comes back to the same address
 * afterwards. A caller that is not a browser asking for a page (it sends an
 * `Authorization` header, or does not ask for HTML) keeps the answer it had.
 */
import type { MiddlewareHandler } from "hono";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import type { MarfaAuth, MarfaAuthSession } from "../auth/instance.js";
import { getClaimStatus, requireOwnerSession } from "../auth/instance-claim.js";
import type { Storage } from "../storage/interface.js";
import { consoleContentSecurityPolicy } from "./content-security-policy.js";
import { prefersHtml } from "./http-error-page.js";
import { setNoStore } from "./no-store.js";
import { validateReturnTo } from "./sign-in-return.js";

/**
 * The longest page address (path and query) a console page sends to sign in
 * to come back to. A longer one would ride in the sign-in page's own address
 * and form, so the person lands on Home instead.
 */
export const MAX_CONSOLE_RETURN_TO_LENGTH = 2048;

/** The owner's browser session, or `null` when this request has none. */
export async function ownerBrowserSession(
  storage: Storage,
  auth: MarfaAuth,
  headers: Headers,
): Promise<MarfaAuthSession | null> {
  try {
    return await requireOwnerSession(storage, auth, headers);
  } catch (error) {
    if (
      error instanceof MarfaError &&
      (error.code === ErrorCode.UNAUTHORIZED ||
        error.code === ErrorCode.FORBIDDEN)
    )
      return null;
    throw error;
  }
}

/** Whether a request is a browser opening a page, as opposed to a program calling. */
export function isBrowserPageRequest(
  method: string,
  headers: Headers,
): boolean {
  return (
    (method === "GET" || method === "HEAD") &&
    prefersHtml(headers.get("accept") ?? undefined) &&
    !headers.has("authorization")
  );
}

/**
 * The sign-in a console page sends a browser to. Before the owner has
 * claimed this Marfa there is nobody to sign in, so it is setup.
 */
export function consoleGate(
  storage: Storage,
  auth: MarfaAuth,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!isBrowserPageRequest(c.req.method, c.req.raw.headers)) return next();
    if (await ownerBrowserSession(storage, auth, c.req.raw.headers)) {
      c.header(
        "Content-Security-Policy",
        consoleContentSecurityPolicy(c.var.cspNonce),
      );
      return next();
    }
    setNoStore(c);
    if (!(await getClaimStatus(storage)).claimed) return c.redirect("/setup");
    const url = new URL(c.req.url);
    const wanted = `${url.pathname}${url.search}`;
    const returnTo =
      wanted.length > MAX_CONSOLE_RETURN_TO_LENGTH
        ? "/"
        : validateReturnTo(wanted, c.var.config.authBaseUrl);
    return c.redirect(
      `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`,
    );
  };
}
