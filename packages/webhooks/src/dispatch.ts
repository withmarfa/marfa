/**
 * Dispatch table — the single place callers read to find the verifier
 * for a stamped method. Adding a new verification method:
 *   1. Add the literal to `VERIFICATION_METHODS` in `./types.ts`.
 *   2. Implement `<method>.ts` exporting a `Verifier`.
 *   3. Add the entry here.
 *
 * No `switch` lives in either route handler — they read
 * `ADAPTERS[subscription.verification_method]`.
 */
import type { Verifier, VerificationMethod } from "./types.js";
import { verifyHmacSha256 } from "./hmac-sha256.js";
import { verifySlack } from "./slack.js";
import { verifyStripe } from "./stripe.js";
import { verifyGitHub } from "./github.js";

export const ADAPTERS: Record<VerificationMethod, Verifier> = {
  "hmac-sha256": verifyHmacSha256,
  slack: verifySlack,
  stripe: verifyStripe,
  github: verifyGitHub,
};
