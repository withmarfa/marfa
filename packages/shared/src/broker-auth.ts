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
 * that can drift: the header read, the `Bearer ` prefix, the
 * comparison, and the empty-key rule. A header rename or a second
 * accepted scheme lands once, in this function.
 *
 * Fails closed on an unset key. A deployment missing its secret must
 * refuse every caller rather than accept whatever `Bearer undefined`
 * an equally-misconfigured caller sends. Callers that can distinguish
 * "misconfigured" from "unauthorized" in their response should check
 * the key themselves first; this returns false either way.
 *
 * Async because the comparison is constant-time and the only
 * constant-time primitive available in a Workers isolate is Web
 * Crypto, which is promise-based. Node's `timingSafeEqual` is not an
 * option: this package runs in browsers and edge runtimes too.
 *
 * For npm consumers of `@withmarfa/shared` this is implementation
 * detail of the hosted runtime substrate.
 */

const ENCODER = new TextEncoder();

export async function isBrokerAuthorized(
  authorizationHeader: string | null | undefined,
  brokerKey: string | null | undefined,
): Promise<boolean> {
  if (!brokerKey) return false;
  // Short-circuiting on an absent header leaks nothing: whether a
  // caller sent the header at all is not a secret, and the branch
  // never touches the key.
  if (!authorizationHeader) return false;
  return timingSafeEqual(authorizationHeader, `Bearer ${brokerKey}`);
}

/**
 * Compare two strings without leaking their contents or their lengths
 * through timing.
 *
 * Both sides are MAC'd under a key generated fresh for this call, then
 * compared byte by byte with no early exit. Hashing first is what
 * removes the length leak a direct byte compare would still carry:
 * the tags are always 32 bytes whatever went in. The key is random per
 * call so an attacker cannot precompute a tag for a guessed secret and
 * work backwards from how the comparison behaves.
 *
 * Equal tags are taken as equal inputs. That rests on SHA-256
 * collision resistance, which is the same assumption every other
 * signature check in this codebase already makes.
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    crypto.getRandomValues(new Uint8Array(32)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const [tagA, tagB] = await Promise.all([
    crypto.subtle.sign("HMAC", key, ENCODER.encode(a)),
    crypto.subtle.sign("HMAC", key, ENCODER.encode(b)),
  ]);
  const bytesA = new Uint8Array(tagA);
  const bytesB = new Uint8Array(tagB);
  let difference = bytesA.length ^ bytesB.length;
  for (let i = 0; i < bytesA.length; i++) {
    difference |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0);
  }
  return difference === 0;
}
