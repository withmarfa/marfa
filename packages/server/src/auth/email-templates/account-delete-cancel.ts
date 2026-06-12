/**
 * Cancel-link email for a sign-in attempt on a pending-delete account.
 *
 * The deletion-guard middleware blocks the sign-in with a generic 401 —
 * this email is the sole user-facing signal that something happened.
 * Copy is framed as "someone attempted sign-in" rather than "you got
 * blocked." The cancel link is valid for the full grace window; clicking
 * it restores the account so the user can sign in normally on the next
 * attempt. If the recipient didn't try to sign in, the email frames
 * "ignore this" as a first-class option — the deletion proceeds on
 * schedule. Renders through the shared email layout.
 */
import { renderEmail, type RenderedEmail } from "./email-layout.js";

export interface AccountDeleteCancelRenderInput {
  /** Cancel-by-link URL. Same single-use token as the
   *  pending-deletion email — reused so a user with multiple cancel
   *  emails in their inbox doesn't accumulate live tokens. */
  url: string;
  /** Optional friendly date string for the deletion deadline. */
  deletionDate?: string;
  /** Optional display name. */
  name?: string | null;
}

export function renderAccountDeleteCancelEmail(
  input: AccountDeleteCancelRenderInput,
): RenderedEmail {
  const greeting = input.name?.trim() ? `Hi ${input.name.trim()}` : "Hi there";
  const deadline = input.deletionDate ?? "";
  return renderEmail({
    subject: "Sign-in attempt on your Marfa account scheduled for deletion",
    heading: "Sign-in attempt on your Marfa account",
    intro: [
      `${greeting},`,
      `Someone tried to sign in to your Marfa account just now. Your account is currently scheduled for deletion${deadline ? ` on ${deadline}` : ""}, so the sign-in did not go through.`,
      "If you'd like to keep your account, restore it below. The deletion will be cancelled and you'll be able to sign in normally on the next attempt.",
    ],
    button: { label: "Restore account", url: input.url },
    outro: [
      "If that wasn't you, you can ignore this email — your account will be deleted on schedule and the sign-in attempt did not succeed.",
    ],
  });
}
