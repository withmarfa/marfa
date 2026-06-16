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
    subject: "Reset your Marfa password",
    heading: "Reset your password",
    intro: [
      `${greeting}, we got a request to reset your Marfa password. Choose a new one with the button below.`,
    ],
    note: `This link expires in ${String(expires)} minutes and works once.`,
    button: { label: "Reset password", url: input.url },
    outro: [
      "If you didn't ask for this, you can ignore this email. Your current password still works.",
    ],
  });
}
