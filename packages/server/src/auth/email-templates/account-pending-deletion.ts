/**
 * Account pending-deletion notification.
 *
 * Sent immediately after the confirm-deletion link is clicked. The
 * account is now in `pending_deletion` and will be hard-deleted at the
 * end of the grace window. The included URL is a single cancel-by-link
 * token valid for the full grace window — clicking it restores the
 * account without needing to sign in. Renders through the shared email
 * layout; the scheduled-deletion warning rides the danger callout.
 */
import { renderEmail, type RenderedEmail } from "./email-layout.js";

export interface AccountPendingDeletionRenderInput {
  /** Cancel-by-link URL. Single-use; valid for the full grace window. */
  url: string;
  /** Deletion-effective ISO date string (display only). */
  deletionDate: string;
  /** Grace-window length in days (display only). */
  graceDays: number;
  /** Optional display name. */
  name?: string | null;
}

export function renderAccountPendingDeletionEmail(
  input: AccountPendingDeletionRenderInput,
): RenderedEmail {
  const greeting = input.name?.trim() ? `Hi ${input.name.trim()}` : "Hi there";
  return renderEmail({
    subject: "Your Marfa account is scheduled for deletion",
    heading: "Account scheduled for deletion",
    intro: [
      `${greeting} — you asked us to delete your Marfa account, and we've confirmed the request.`,
      "When the grace period ends, everything in your space is permanently removed — your items, edges, tags, version history, uploaded files, and every API key and OAuth connection — along with the account itself. This can't be undone.",
      "The one thing we keep is a redacted security audit record, with all personal details stripped out.",
    ],
    callout: `Your account and everything in it will be permanently deleted in ${String(input.graceDays)} days, on ${input.deletionDate}.`,
    button: { label: "Cancel deletion", url: input.url },
    outro: [
      "Changed your mind? Cancelling restores everything, and you can pick up right where you left off — no need to sign in.",
    ],
  });
}
