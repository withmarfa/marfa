import { createMiddleware } from "hono/factory";
import { matchedRoutes } from "hono/route";
import { ErrorCode, MarfaError, isValidId } from "@withmarfa/shared";
import type { AppEnv } from "./auth.js";
import { isDirectAuthority, requireDeclaredCredential } from "./auth.js";

export const INSTANCE_HEADER = "X-Marfa-Instance-Id";

/**
 * A write names the instance its sender expects, so one that reaches another
 * instance at the same address is refused where it lands rather than written
 * onto rows its sender never held.
 *
 * Mounted after the limiter and ahead of the idempotency claim: a refusal
 * here is never recorded under a key, so a sender that rebuilds its copy and
 * sends the same write again is answered by the instance now there. The
 * header is not part of the fingerprint for the same reason.
 *
 * A request with no credential on a protected door passes through to the
 * depth check and credential gate before the header is judged.
 */
export function instanceHeaderMiddleware(instanceId: string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS")
      return next();
    if (/^\/auth(?:\/|$)/.test(c.req.path)) return next();
    const named = c.req.header(INSTANCE_HEADER);
    if (named === undefined) return next();
    const routes = matchedRoutes(c);
    // Only a served door: an unknown path answers its `404` as it would
    // without the header.
    if (!routes.some((route) => route.method !== "ALL")) return next();
    const gated = routes.some(
      (route) => route.handler === requireDeclaredCredential,
    );
    if (gated && !isDirectAuthority(c) && c.get("apiKey") === undefined)
      return next();
    if (!isValidId(named)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `${INSTANCE_HEADER} must be one lowercase UUIDv7`,
      );
    }
    if (named !== instanceId) {
      throw new MarfaError(
        ErrorCode.INSTANCE_CHANGED,
        `${INSTANCE_HEADER} names another instance. Nothing was written. Rebuild the working copy from the instance at this address.`,
      );
    }
    return next();
  });
}
