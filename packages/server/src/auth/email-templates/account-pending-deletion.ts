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
      `${greeting},`,
      "We've received and confirmed your account-deletion request.",
      "What will be deleted: every item, edge, tag, and version in your space; every API key and OAuth grant on the account; every uploaded blob; and your user record (sessions, passkeys, accounts).",
      "What's preserved: audit-log rows, with all personal identifiers redacted.",
      "Changed your mind? Cancel deletion below — valid until the deletion date.",
    ],
    callout: `Your account will be permanently deleted in ${String(input.graceDays)} days, on ${input.deletionDate}.`,
    button: { label: "Cancel deletion", url: input.url },
  });
}
