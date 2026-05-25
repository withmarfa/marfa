/**
 * Password-reset email template (Wave C PR3 / T-033).
 *
 * Same shape as the magic-link / verify-email templates: mobile-first,
 * 16px body, 44px tap target, inline styles only. Plain-text fallback.
 *
 * Subject specific so a busy inbox can scan it. Token expiry stated
 * inline ("This link expires in 1 hour") to set user expectations.
 */
const ACCENT = "#1f6feb";
const TEXT = "#1f2328";
const MUTED = "#57606a";
const BORDER = "#d0d7de";

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

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderResetPasswordEmail(
  input: ResetPasswordRenderInput,
): RenderedEmail {
  const expires = input.expiresInMinutes ?? 60;
  const greeting = input.name?.trim() ? `Hi ${input.name.trim()}` : "Hi there";
  const subject = "Reset your password for Marfa";
  const text = [
    "Reset your password for Marfa",
    "",
    `${greeting},`,
    "",
    "We got a request to reset your password. Click the link below to choose a new one.",
    "",
    `This link expires in ${String(expires)} minutes and can only be used once.`,
    "",
    input.url,
    "",
    "If you didn't request this, you can safely ignore this email — your current password will keep working.",
    "",
    "— Marfa",
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
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;width:100%;background:#ffffff;border:1px solid ${BORDER};border-radius:8px;">
<tr><td style="padding:32px;">
<h1 style="margin:0 0 16px 0;font-size:20px;font-weight:600;color:${TEXT};">Reset your password</h1>
<p style="margin:0 0 12px 0;color:${TEXT};">${escapeHtml(greeting)},</p>
<p style="margin:0 0 24px 0;color:${MUTED};">We got a request to reset your password. Click the button below to choose a new one. This link expires in ${String(expires)} minutes and can only be used once.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr><td style="border-radius:6px;background:${ACCENT};">
<a href="${escapeAttr(input.url)}" style="display:inline-block;padding:12px 24px;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;line-height:20px;border-radius:6px;min-height:44px;box-sizing:border-box;">Reset password</a>
</td></tr>
</table>
<p style="margin:24px 0 0 0;color:${MUTED};font-size:14px;">Or paste this URL into your browser:</p>
<p style="margin:8px 0 0 0;word-break:break-all;font-size:13px;color:${MUTED};">${escapeHtml(input.url)}</p>
<hr style="margin:32px 0;border:0;border-top:1px solid ${BORDER};">
<p style="margin:0;color:${MUTED};font-size:13px;">If you didn't request this, you can safely ignore this email — your current password will keep working.</p>
</td></tr>
</table>
<p style="margin:24px 0 0 0;color:${MUTED};font-size:12px;">— Marfa</p>
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
