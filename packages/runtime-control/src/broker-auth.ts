import type { Context } from "hono";
import { isBrokerAuthorized } from "@withmarfa/shared";
import type { ControlPlaneEnv } from "./env.js";

/**
 * Reject a caller that did not present the broker key. Returns the
 * refusal to hand back, or `null` when the caller is authorized.
 *
 * Lives in one place because every control-plane route that can reach
 * a credential — minting a runtime credential, arming a schedule —
 * has to gate identically. A second inline copy is how two routes
 * quietly stop agreeing on what "authorized" means: one gets a fix (a
 * header rename, a timing-safe compare) and the other doesn't, and the
 * gap goes unnoticed until something depends on it.
 *
 * The Worker is routed to public hostnames, so every route that can
 * reach a credential needs this gate. Integration Workers already send
 * the header on every call (see `worker-entry.ts` in
 * `@withmarfa/runtime-sdk`).
 *
 * The comparison itself lives in `@withmarfa/shared` because the
 * integration Workers gate their own fetch surface on the same key and
 * cannot reuse this wrapper — they have no Hono context to answer
 * through, and `@withmarfa/runtime-sdk` must not take a Hono
 * dependency it would ship into every integration bundle. This
 * function is the Hono-shaped half; the rule is shared.
 */
export function brokerAuthFailure(
  c: Context<{ Bindings: ControlPlaneEnv }>,
  brokerKey: string,
): Response | null {
  if (!isBrokerAuthorized(c.req.header("authorization"), brokerKey)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return null;
}
