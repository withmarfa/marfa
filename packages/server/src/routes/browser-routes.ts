/**
 * The Browsers page of the owner console, read from the owner's live browser
 * sessions and drawn by `browser-pages.tsx`. The page is the owner's: a
 * browser without the owner's session is sent to sign in by the console's
 * gate, and a caller that is not the owner is refused here. Signing out is
 * done by the browser through the public doors.
 */
import { Hono } from "hono";
import type { MarfaAuth } from "../auth/instance.js";
import * as clock from "../clock.js";
import { readInstanceName } from "../instance-name.js";
import { requireDirectAuthority, type AppEnv } from "../middleware/auth.js";
import { refuseUndeclaredKeysOf } from "../middleware/undeclared-query-keys.js";
import { browserSignInName } from "../auth/sign-in-names.js";
import { dateWords, usedWords } from "../pages/key-time.js";
import type { Storage } from "../storage/interface.js";
import { BROWSERS_HREF, renderBrowsersPage } from "./browser-pages.js";
import { CONSOLE_PAGES } from "./console.js";
import { consoleContentSecurityPolicy } from "./content-security-policy.js";

const MINUTE_MS = 60_000;

/** "Signed in just now" or "Signed in October 12". */
function signedInWords(createdAt: number, now: number): string {
  return now - createdAt < MINUTE_MS
    ? "Signed in just now"
    : `Signed in ${dateWords(createdAt, now)}`;
}

CONSOLE_PAGES.register("browsers", {
  href: BROWSERS_HREF,
  value: async ({ storage, auth }) => {
    const owner = await storage.owner?.find();
    if (!owner || !auth) return undefined;
    const signedIn = (await auth.listBrowserSessions(owner.id)).length;
    return {
      text: signedIn === 0 ? "None" : `${String(signedIn)} signed in`,
    };
  },
});

export function browserRoutes(storage: Storage, auth: MarfaAuth) {
  const router = new Hono<AppEnv>();

  router.get("/browsers", async (c) => {
    requireDirectAuthority(c);
    refuseUndeclaredKeysOf(c.req.url, []);
    const owner = await storage.owner?.find();
    const authority = c.get("authority");
    const current =
      authority?.kind === "owner" ? authority.sessionId : undefined;
    const now = clock.nowMs();
    const sessions = owner ? await auth.listBrowserSessions(owner.id) : [];
    c.header(
      "Content-Security-Policy",
      consoleContentSecurityPolicy(c.var.cspNonce),
    );
    return c.html(
      renderBrowsersPage({
        nonce: c.var.cspNonce,
        instanceName: await readInstanceName(storage.settings),
        rows: sessions
          // This browser first, then the rest, the most recently used first.
          .sort(
            (a, b) =>
              Number(b.id === current) - Number(a.id === current) ||
              b.lastUsedAt.getTime() - a.lastUsedAt.getTime(),
          )
          .map((session) => ({
            id: session.id,
            name: browserSignInName(session.userAgent),
            current: session.id === current,
            description: `${session.ipAddress ? `At ${session.ipAddress}. ` : ""}${signedInWords(session.createdAt.getTime(), now)}.`,
            value: usedWords(session.lastUsedAt.getTime(), now),
          })),
      }),
    );
  });

  return router;
}
