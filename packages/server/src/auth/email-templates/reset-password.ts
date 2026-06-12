/**
 * Password-reset email template.
 *
 * Renders through the shared email layout. Subject specific so a busy
 * inbox can scan it. Token expiry stated inline to set user expectations.
 */
import { renderEmail, type RenderedEmail } from "./email-layout.js";

export interface ResetPasswordRenderInput {
  /** The reset URL the user clicks. Built by better-auth as
   *  `${baseURL}/reset-password?token=X` (we add `&return_to=...` if
   *  the original request carried one). */
  url: string;
  /** Optional friendly minutes-until-expiry. Defaults to 60. */
  expiresInMinutes?: number;
  /** Optional display name. Falls back to "there" when absent. */
  name?: string | null;
}

export function renderResetPasswordEmail(
  input: ResetPasswordRenderInput,
): RenderedEmail {
  const expires = input.expiresInMinutes ?? 60;
  const greeting = input.name?.trim() ? `Hi ${input.name.trim()}` : "Hi there";
  return renderEmail({
    subject: "Reset your password for Marfa",
    heading: "Reset your password",
    intro: [
      `${greeting},`,
      "We got a request to reset your password. Click the button below to choose a new one.",
      `This link expires in ${String(expires)} minutes and can only be used once.`,
    ],
    button: { label: "Reset password", url: input.url },
    outro: [
      "If you didn't request this, you can safely ignore this email — your current password will keep working.",
    ],
  });
}
