import { verifyHmacSha256 } from "./hmac-sha256.js";
import { verifySlack } from "./slack.js";
import { verifyStripe } from "./stripe.js";
import { verifyGitHub } from "./github.js";
import { verifyCustom } from "./custom.js";
import type { VerifyInboundWebhook, VerificationMethod } from "./types.js";

export type {
  VerifyInboundWebhook,
  VerifyInboundWebhookResult,
  VerificationMethod,
} from "./types.js";
export { VERIFICATION_METHODS, isVerificationMethod } from "./types.js";

/**
 * Dispatch table — the single place the route handler reads to find the
 * verifier for a stamped method. Adding a new verification method:
 *   1. Add the literal to `VERIFICATION_METHODS` in `./types.ts` (keeps
 *      the manifest-side discriminated union and this dispatch table in
 *      sync at compile time).
 *   2. Implement `<method>.ts` exporting a `VerifyInboundWebhook`.
 *   3. Add the entry here.
 *
 * No `switch` lives anywhere in the route handler — the handler just
 * reads `ADAPTERS[row.verification_method]`.
 */
export const ADAPTERS: Record<VerificationMethod, VerifyInboundWebhook> = {
  "hmac-sha256": verifyHmacSha256,
  slack: verifySlack,
  stripe: verifyStripe,
  github: verifyGitHub,
  custom: verifyCustom,
};
