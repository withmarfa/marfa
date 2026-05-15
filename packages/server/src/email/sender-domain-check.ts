/**
 * Sender-domain check — fails loud at boot if the configured
 * MYME_EMAIL_FROM doesn't end in a domain Cloudflare Email Service
 * has DKIM-stamped.
 *
 * CF onboarding for `mail.myme.so` auto-provisions DKIM/SPF/MX/DMARC
 * records under `cf-bounce.mail.myme.so`. Sending from an unverified
 * domain fails SPF on the receiving end and CF returns 4xx. Operator
 * memory is not the right place to bake that constraint in — the
 * boot guard makes the mistake unmissable.
 *
 * Test environments and the none / smtp backends skip the check.
 */
import type { EmailBackend } from "./transport.js";

const REQUIRED_DOMAIN_SUFFIX = "@mail.myme.so";

export interface SenderDomainCheckOptions {
  backend: EmailBackend;
  from: string;
  /** When true, skip the check (test contexts, dev with none backend
   *  pointed at a fake domain). Defaults to NODE_ENV-derived. */
  skip?: boolean;
}

export class SenderDomainMismatchError extends Error {
  readonly code = "SENDER_DOMAIN_MISMATCH";
  constructor(from: string) {
    super(
      `MYME_EMAIL_FROM=${from} must end with ${REQUIRED_DOMAIN_SUFFIX} ` +
        `for the Cloudflare Email backend (the verified send domain is ` +
        `mail.myme.so; apex myme.so has no DKIM key, so emails would fail ` +
        `SPF). Set MYME_EMAIL_FROM to a value ending in ${REQUIRED_DOMAIN_SUFFIX}.`,
    );
  }
}

/**
 * Throws SenderDomainMismatchError when the Cloudflare backend is in
 * use, the env is not test, and `from` doesn't end in the verified
 * send domain. No-op for SMTP / none backends (operator owns the
 * domain config there).
 */
export function checkSenderDomain(opts: SenderDomainCheckOptions): void {
  const skip =
    opts.skip ?? (process.env.NODE_ENV === "test" || !process.env.NODE_ENV);
  if (skip) return;
  if (opts.backend !== "cloudflare") return;
  // Extract email part from "Name <email@domain>" or "email@domain".
  const match = /<([^>]+)>/.exec(opts.from);
  const email = (match?.[1] ?? opts.from).trim();
  if (!email.toLowerCase().endsWith(REQUIRED_DOMAIN_SUFFIX)) {
    throw new SenderDomainMismatchError(opts.from);
  }
}
