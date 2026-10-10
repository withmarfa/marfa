import { requireSecureOwnerTransport } from "../auth/owner-browser.js";
import { createMiddleware } from "hono/factory";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import type { Context } from "hono";
import type { MarfaAuth, SessionUse } from "../auth/instance.js";
import { resolveBoundCredential } from "../auth/live-credential.js";
import { withRequestAuthority } from "../auth/request-authority.js";
import {
  holdsPermission,
  requireRecentOwnerAuthentication,
  type AppEnv,
} from "./auth.js";

/** A closure chosen by the listener, never a claim in an HTTP request. */
export function directAuthorityMiddleware(
  storage: Storage,
  auth: MarfaAuth | undefined,
  baseURL: string,
  localAuthority = false,
) {
  return createMiddleware<AppEnv>(async (c, next) => {
    let renewal: SessionUse | null = null;
    if (localAuthority) {
      c.set("authority", { kind: "local_process" });
      c.set("apiKey", undefined);
      c.set("authType", undefined);
      c.set("boundCredential", undefined);
      c.set("oauthGrant", undefined);
    } else if (
      !c.req.header("authorization") &&
      auth &&
      !c.req.path.startsWith("/setup") &&
      !["/auth/sign-in", "/auth/sign-in/email"].includes(c.req.path)
    ) {
      const owner = await storage.owner?.find();
      const session = owner
        ? await auth.getSession(c.req.raw.headers, { readOnly: true })
        : null;
      if (owner && session?.user.id === owner.id) {
        requireSecureOwnerTransport(auth);
        if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
          const origin = c.req.header("origin");
          if (origin !== new URL(baseURL).origin) {
            throw new MarfaError(
              ErrorCode.FORBIDDEN,
              "Owner requests must come from this instance's origin",
            );
          }
        }
        // Admitting the request is a use of the session, which renews it.
        // One that ended since the lookup admits nothing.
        renewal = await auth.useSession(c.req.raw.headers, owner.id);
        if (renewal)
          c.set("authority", {
            kind: "owner",
            userId: renewal.session.user.id,
            sessionId: renewal.session.session.id,
            authenticatedAt: renewal.session.session.createdAt.getTime(),
          });
      }
    }
    const bound = c.get("boundCredential");
    const admitted = c.get("authority");
    await withRequestAuthority(async (permissions, recent) => {
      if (admitted?.kind === "owner") {
        const live = await auth?.getSession(c.req.raw.headers, {
          readOnly: true,
        });
        if (
          live?.session.id !== admitted.sessionId ||
          live.user.id !== admitted.userId ||
          (await storage.owner?.find())?.id !== admitted.userId
        ) {
          throw new MarfaError(
            ErrorCode.UNAUTHORIZED,
            "The owner session has ended",
          );
        }
      } else if (bound) {
        const live = await resolveBoundCredential(storage, bound);
        if (!live)
          throw new MarfaError(
            ErrorCode.UNAUTHORIZED,
            "This credential is no longer valid",
          );
        c.set("apiKey", live.key);
        if (bound.kind === "oauth")
          c.set("oauthGrant", {
            scopes: live.permissions,
            clientId: bound.clientId,
            authUserId: bound.authUserId,
          });
      }
      for (const permission of permissions) {
        if (!holdsPermission(c, permission))
          throw new MarfaError(
            ErrorCode.FORBIDDEN,
            `This credential no longer holds ${permission}`,
            { required_scope: permission },
          );
      }
      if (recent) requireRecentOwnerAuthentication(c);
    }, next);
    // Only an answer that succeeded carries the cookie: a refusal or a fault
    // sets none, and a `401` means the session ended while the request was
    // in flight.
    if (renewal?.cookie && c.res.status < 400)
      sendRenewedCookie(c, renewal.cookieName, renewal.cookie);
  });
}

/**
 * Send the browser its cookie again with the lifetime the renewal gave the
 * session, unless the response sets that cookie itself, as sign-out and the
 * end of the current session do.
 */
function sendRenewedCookie(
  c: Context<AppEnv>,
  name: string,
  cookie: string,
): void {
  const prefix = `${name}=`;
  if (c.res.headers.getSetCookie().some((line) => line.startsWith(prefix)))
    return;
  try {
    c.res.headers.append("set-cookie", cookie);
  } catch {
    // A response whose headers are immutable, such as one `Response.redirect`
    // made, is copied so the cookie can be added.
    const copy = new Response(c.res.body, c.res);
    copy.headers.append("set-cookie", cookie);
    c.res = undefined;
    c.res = copy;
  }
}
