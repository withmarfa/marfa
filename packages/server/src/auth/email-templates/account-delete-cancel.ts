/**
 * Cancel-link email for a sign-in attempt on a pending-delete account
 * (T-116).
 *
 * The middleware blocks the sign-in and dispatches this email. The
 * cancel link is valid for the full grace window — clicking it
 * restores the account.
 */
const ACCENT = "#1f6feb";
const TEXT = "#1f2328";
const MUTED = "#57606a";
const BORDER = "#d0d7de";

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

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderAccountDeleteCancelEmail(
  input: AccountDeleteCancelRenderInput,
): RenderedEmail {
  const greeting = input.name?.trim() ? `Hi ${input.name.trim()}` : "Hi there";
  const subject = "Cancellation link for your Myme account deletion";
  const deadline = input.deletionDate ?? "";
  const text = [
    "Cancellation link for your Myme account deletion",
    "",
    `${greeting},`,
    "",
    "We received a sign-in attempt on an account scheduled for deletion.",
    deadline ? `Deletion is currently scheduled for ${deadline}.` : "",
    "",
    "To restore your account and sign in normally, click the link below — valid until the deletion date.",
    "",
    input.url,
    "",
    "If you didn't try to sign in, you can safely ignore this email.",
    "",
    "— Myme",
  ]
    .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""))
    .join("\n");
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
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;width:100%;background:#ffffff;border:1px solid ${BORDER};border-radius:8px;">
<tr><td style="padding:32px;">
<h1 style="margin:0 0 16px 0;font-size:20px;font-weight:600;color:${TEXT};">Restore your account</h1>
<p style="margin:0 0 12px 0;color:${TEXT};">${escapeHtml(greeting)},</p>
<p style="margin:0 0 24px 0;color:${MUTED};">We received a sign-in attempt on an account scheduled for deletion${deadline ? ` on ${escapeHtml(deadline)}` : ""}. Click below to restore the account — valid until the deletion date.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr><td style="border-radius:6px;background:${ACCENT};">
<a href="${escapeAttr(input.url)}" style="display:inline-block;padding:12px 24px;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;line-height:20px;border-radius:6px;min-height:44px;box-sizing:border-box;">Restore account</a>
</td></tr>
</table>
<p style="margin:24px 0 0 0;color:${MUTED};font-size:14px;">Or paste this URL into your browser:</p>
<p style="margin:8px 0 0 0;word-break:break-all;font-size:13px;color:${MUTED};">${escapeHtml(input.url)}</p>
<hr style="margin:32px 0;border:0;border-top:1px solid ${BORDER};">
<p style="margin:0;color:${MUTED};font-size:13px;">If you didn't try to sign in, you can safely ignore this email.</p>
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
