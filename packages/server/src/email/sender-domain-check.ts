/**
 * Sender-domain check — fails loud at boot if the configured
 * MYME_EMAIL_FROM doesn't end in a domain Resend has DKIM-stamped.
 *
 * Resend's domain verification ties DKIM to a specific subdomain
 * (mail.myme.so is verified; the apex myme.so is not). Sending
 * from noreply@myme.so would fail SPF on the receiving end and
 * Resend would 403 the call entirely. Operator memory is not the
 * right place to bake that constraint in — the boot guard makes the
 * mistake unmissable.
 *
 * Test environments and the none / smtp backends skip the check.
 */
const REQUIRED_DOMAIN_SUFFIX = "@mail.myme.so";

export interface SenderDomainCheckOptions {
  backend: "resend" | "smtp" | "none";
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
        `for the Resend backend (the verified Resend domain is mail.myme.so; ` +
        `apex myme.so has no DKIM key, so emails would fail SPF). ` +
        `Set MYME_EMAIL_FROM to a value ending in ${REQUIRED_DOMAIN_SUFFIX}.`,
    );
  }
}

/**
 * Throws SenderDomainMismatchError when the Resend backend is in
 * use, the env is not test, and `from` doesn't end in the verified
 * Resend domain. No-op for SMTP / none backends (operator owns the
 * domain config there).
 */
export function checkSenderDomain(opts: SenderDomainCheckOptions): void {
  const skip =
    opts.skip ?? (process.env.NODE_ENV === "test" || !process.env.NODE_ENV);
  if (skip) return;
  if (opts.backend !== "resend") return;
  // Extract email part from "Name <email@domain>" or "email@domain".
  const match = /<([^>]+)>/.exec(opts.from);
  const email = (match?.[1] ?? opts.from).trim();
  if (!email.toLowerCase().endsWith(REQUIRED_DOMAIN_SUFFIX)) {
    throw new SenderDomainMismatchError(opts.from);
  }
}
