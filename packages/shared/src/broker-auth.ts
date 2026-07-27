/**
 * The rule for what counts as presenting the runtime broker key.
 *
 * Both ends of the control-plane ↔ integration-Worker hop check this,
 * and the two ends cannot share a refusal helper: the control plane
 * runs on Hono and answers with `c.json`, the integration Workers have
 * no framework and answer with `Response.json`, and `@withmarfa/
 * runtime-sdk` must not take a Hono dependency it would ship into
 * every integration bundle. So each side keeps its own thin
 * `brokerAuthFailure` wrapper and they agree here, on the only part
 * that can drift — the header read, the `Bearer ` prefix, the
 * comparison, and the empty-key rule. A timing-safe compare, a header
 * rename, or a second accepted scheme lands once, in this function.
 *
 * Fails closed on an unset key. A deployment missing its secret must
 * refuse every caller rather than accept whatever `Bearer undefined`
 * an equally-misconfigured caller sends. Callers that can distinguish
 * "misconfigured" from "unauthorized" in their response should check
 * the key themselves first; this returns false either way.
 *
 * For npm consumers of `@withmarfa/shared` this is implementation
 * detail of the hosted runtime substrate.
 */
export function isBrokerAuthorized(
  authorizationHeader: string | null | undefined,
  brokerKey: string | null | undefined,
): boolean {
  if (!brokerKey) return false;
  return authorizationHeader === `Bearer ${brokerKey}`;
}
