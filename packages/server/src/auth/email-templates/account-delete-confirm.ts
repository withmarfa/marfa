/**
 * Account-delete confirmation email.
 *
 * Sent on `POST /auth/account/delete`. Single-use confirmation link;
 * clicking it flips the account into `pending_deletion` and starts the
 * grace window. Renders through the shared email layout. Subject is
 * deliberately specific so the recipient sees it isn't routine.
 */
import { renderEmail, type RenderedEmail } from "./email-layout.js";

export interface AccountDeleteConfirmRenderInput {
  /** Single-use confirmation URL. */
  url: string;
  /** Optional friendly minutes-until-expiry. Defaults to 60. */
  expiresInMinutes?: number;
  /** Optional display name. Falls back to "there" when absent. */
  name?: string | null;
}

export function renderAccountDeleteConfirmEmail(
  input: AccountDeleteConfirmRenderInput,
): RenderedEmail {
  const expires = input.expiresInMinutes ?? 60;
  const greeting = input.name?.trim() ? `Hi ${input.name.trim()}` : "Hi there";
  return renderEmail({
    subject: "Confirm your Marfa account deletion",
    heading: "Confirm account deletion",
    intro: [
      `${greeting},`,
      "We received a request to delete your Marfa account. Click the button below to confirm.",
      `This link expires in ${String(expires)} minutes.`,
    ],
    button: { label: "Confirm deletion", url: input.url },
    outro: [
      "If you didn't request deletion, ignore this email — your account stays active.",
    ],
  });
}
