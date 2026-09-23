import type { MiddlewareHandler } from "hono";
import { CONTRACT_HEADER, CONTRACT_VERSION } from "../contract.js";

/**
 * Names the contract version on the way out, after everything inside it has
 * answered. Mounted first, it reaches the answers no route shapes: the body
 * cap's refusal, the limiter's, an unmatched route, a thrown error, a CORS
 * preflight, and the sign-in library's own responses, which the headers a
 * middleware prepares before `next()` never reach.
 */
export function contractHeader(): MiddlewareHandler {
  const contract = String(CONTRACT_VERSION);
  return async (c, next) => {
    await next();
    c.res.headers.set(CONTRACT_HEADER, contract);
  };
}
