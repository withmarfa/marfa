/**
 * Email-verification template.
 *
 * Sent on sign-up. Renders through the shared email layout so it shares
 * the Marfa brand chrome with every other transactional mail. Subject
 * intentionally specific so a busy inbox can scan it.
 */
import { renderEmail, type RenderedEmail } from "./email-layout.js";

export interface VerifyEmailRenderInput {
  /** The verification URL the user clicks. Built by better-auth as
   *  `${baseURL}/verify-email?token=X&callbackURL=Y`. */
  url: string;
  /** Optional friendly minutes-until-expiry. Defaults to 60 (matches
   *  better-auth's default `expiresIn: 3600` we set on the auth
   *  instance). */
  expiresInMinutes?: number;
  /** Optional display name from `auth_user.name`. Used to greet the
   *  user. Falls back to "there" when absent. */
  name?: string | null;
}

export function renderVerifyEmailEmail(
  input: VerifyEmailRenderInput,
): RenderedEmail {
  const expires = input.expiresInMinutes ?? 60;
  const greeting = input.name?.trim() ? `Hi ${input.name.trim()}` : "Hi there";
  return renderEmail({
    subject: "Verify your email",
    heading: "Verify your email",
    intro: [
      `${greeting}, confirm your email to finish setting up your Marfa account.`,
    ],
    note: `This link expires in ${String(expires)} minutes.`,
    button: { label: "Verify email", url: input.url },
    outro: ["If you didn't create a Marfa account, you can ignore this email."],
  });
}
