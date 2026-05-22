/**
 * Account pending-deletion notification (T-116).
 *
 * Sent immediately after the confirm-deletion link is clicked. The
 * account is now in `pending_deletion` and will be hard-deleted at the
 * end of the grace window. The included URL is a single cancel-by-link
 * token valid for the full grace window — clicking it restores the
 * account without needing to sign in.
 *
 * The body summarises what will be deleted and what's preserved
 * (audit row count + actor chain, with PII scrubbed) so the user can
 * make an informed call about cancelling.
 */
const ACCENT = "#1f6feb";
const DANGER = "#a40e26";
const TEXT = "#1f2328";
const MUTED = "#57606a";
const BORDER = "#d0d7de";

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

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderAccountPendingDeletionEmail(
  input: AccountPendingDeletionRenderInput,
): RenderedEmail {
  const greeting = input.name?.trim() ? `Hi ${input.name.trim()}` : "Hi there";
  const subject = "Your Myme account is scheduled for deletion";
  const text = [
    "Your Myme account is scheduled for deletion",
    "",
    `${greeting},`,
    "",
    `We've received and confirmed your account-deletion request. Your account will be permanently deleted in ${String(input.graceDays)} days, on ${input.deletionDate}.`,
    "",
    "What will be deleted:",
    "  - Every item, edge, tag, and version in your space",
    "  - Every API key and OAuth grant on the account",
    "  - Every uploaded blob",
    "  - Your user record (sessions, passkeys, accounts)",
    "",
    "What's preserved:",
    "  - Audit-log rows (with all personal identifiers redacted)",
    "",
    "To cancel, click the link below — valid until the deletion date.",
    "",
    input.url,
    "",
    "— Myme",
  ].join("\n");
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f8fa;color:${TEXT};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f6f8fa;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid ${BORDER};border-radius:8px;">
<tr><td style="padding:32px;">
<h1 style="margin:0 0 16px 0;font-size:20px;font-weight:600;color:${TEXT};">Account scheduled for deletion</h1>
<p style="margin:0 0 12px 0;color:${TEXT};">${escapeHtml(greeting)},</p>
<p style="margin:0 0 24px 0;color:${MUTED};">Your account will be permanently deleted in <strong style="color:${DANGER};">${String(input.graceDays)} days</strong>, on ${escapeHtml(input.deletionDate)}.</p>
<h2 style="margin:24px 0 8px 0;font-size:15px;font-weight:600;color:${TEXT};">What will be deleted</h2>
<ul style="margin:0 0 24px 0;padding-left:20px;color:${MUTED};">
<li>Every item, edge, tag, and version in your space</li>
<li>Every API key and OAuth grant on the account</li>
<li>Every uploaded blob</li>
<li>Your user record (sessions, passkeys, accounts)</li>
</ul>
<h2 style="margin:24px 0 8px 0;font-size:15px;font-weight:600;color:${TEXT};">What's preserved</h2>
<ul style="margin:0 0 24px 0;padding-left:20px;color:${MUTED};">
<li>Audit-log rows with all personal identifiers redacted</li>
</ul>
<p style="margin:0 0 16px 0;color:${TEXT};">Changed your mind? Cancel deletion below — valid until the deletion date.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr><td style="border-radius:6px;background:${ACCENT};">
<a href="${escapeAttr(input.url)}" style="display:inline-block;padding:12px 24px;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;line-height:20px;border-radius:6px;min-height:44px;box-sizing:border-box;">Cancel deletion</a>
</td></tr>
</table>
<p style="margin:24px 0 0 0;color:${MUTED};font-size:14px;">Or paste this URL into your browser:</p>
<p style="margin:8px 0 0 0;word-break:break-all;font-size:13px;color:${MUTED};">${escapeHtml(input.url)}</p>
</td></tr>
</table>
<p style="margin:24px 0 0 0;color:${MUTED};font-size:12px;">— Myme</p>
</td></tr>
</table>
</body>
</html>`;
  return { subject, html, text };
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(input: string): string {
  return escapeHtml(input);
}
