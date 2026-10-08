import { createMiddleware } from "hono/factory";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import type { MarfaAuth } from "../auth/instance.js";
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
    if (localAuthority) {
      c.set("authority", { kind: "local_process" });
      c.set("apiKey", undefined);
      c.set("authType", undefined);
      c.set("boundCredential", undefined);
      c.set("oauthGrant", undefined);
    } else if (
      !c.req.header("authorization") &&
      auth &&
      !c.req.path.startsWith("/setup")
    ) {
      const session = await auth.getSession(c.req.raw.headers, {
        readOnly: true,
      });
      if (session && (await storage.owner?.find())?.id === session.user.id) {
        if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
          const origin = c.req.header("origin");
          if (origin !== new URL(baseURL).origin) {
            throw new MarfaError(
              ErrorCode.FORBIDDEN,
              "Owner requests must come from this instance's origin",
            );
          }
        }
        c.set("authority", {
          kind: "owner",
          userId: session.user.id,
          sessionId: session.session.id,
          authenticatedAt: session.session.createdAt.getTime(),
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
          !live ||
          live.session.id !== admitted.sessionId ||
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
  });
}
