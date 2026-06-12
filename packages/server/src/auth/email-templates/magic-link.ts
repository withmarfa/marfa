/**
 * Magic-link email template.
 *
 * Renders through the shared email layout. Subject specific (not
 * "Action required") so a busy inbox can scan it.
 */
import { renderEmail, type RenderedEmail } from "./email-layout.js";

export interface MagicLinkRenderInput {
  url: string;
  /** Optional minutes-until-expiry override. The actual TTL is set by
   *  better-auth's magicLink config; we surface a friendly value to
   *  match. Defaults to 5. */
  expiresInMinutes?: number;
}

export function renderMagicLinkEmail(
  input: MagicLinkRenderInput,
): RenderedEmail {
  const expires = input.expiresInMinutes ?? 5;
  return renderEmail({
    subject: "Sign in to Marfa",
    heading: "Sign in to Marfa",
    intro: [
      `Use the button below to sign in to Marfa. The link works once and expires in ${String(expires)} minutes.`,
    ],
    button: { label: "Sign in", url: input.url },
    outro: [
      "If you didn't try to sign in, you can ignore this email — your account is safe.",
    ],
  });
}
