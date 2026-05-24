/**
 * `@mymehq/webhooks` — cross-runtime inbound-webhook signature
 * verification.
 *
 * Public surface:
 *   - `ADAPTERS` — dispatch table keyed by `VerificationMethod`
 *   - `verifyHmacSha256`, `verifySlack`, `verifyStripe`, `verifyGitHub`
 *   - `VERIFICATION_METHODS`, `isVerificationMethod`
 *   - `Verifier`, `VerifyResult`, `VerificationMethod` types
 */
export type { Verifier, VerifyResult, VerificationMethod } from "./types.js";
export { VERIFICATION_METHODS, isVerificationMethod } from "./types.js";
export { verifyHmacSha256 } from "./hmac-sha256.js";
export { verifySlack } from "./slack.js";
export { verifyStripe } from "./stripe.js";
export { verifyGitHub } from "./github.js";
export { verifyGoogleChannel } from "./google-channel.js";
export { verifyCloudflareEmail } from "./cloudflare-email.js";
export { ADAPTERS } from "./dispatch.js";
