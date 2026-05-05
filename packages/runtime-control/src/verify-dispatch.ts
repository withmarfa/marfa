/**
 * Dispatch table for inbound webhook signature verification.
 *
 * The four supported methods (T-011 dropped `custom`) each have a
 * Web-Crypto adapter in this package. The route handler in
 * `routes/webhooks.ts` reads `ADAPTERS[subscription.verification_method]`
 * — no `switch` statements anywhere downstream.
 *
 * Mirror of `packages/server/src/inbound-webhooks/verification/` —
 * server-side adapters use `node:crypto` for parity with the existing
 * test suite; the Workers runtime needs Web Crypto. A future
 * `@mymehq/webhook-protocol` package extraction would consolidate both
 * onto a single Web-Crypto-only implementation.
 */
import type { VerifyResult } from "./verify-hmac-sha256.js";
import { verifyHmacSha256 } from "./verify-hmac-sha256.js";
import { verifySlack } from "./verify-slack.js";
import { verifyStripe } from "./verify-stripe.js";
import { verifyGitHub } from "./verify-github.js";

export type VerificationMethod = "hmac-sha256" | "slack" | "stripe" | "github";

export type Verifier = (
  rawBody: ArrayBuffer,
  headers: Headers,
  secret: string,
) => Promise<VerifyResult>;

export const ADAPTERS: Record<VerificationMethod, Verifier> = {
  "hmac-sha256": verifyHmacSha256,
  slack: verifySlack,
  stripe: verifyStripe,
  github: verifyGitHub,
};
