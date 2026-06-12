/**
 * Shared layout for Marfa's transactional emails.
 *
 * Every template (verify-email, magic-link, reset-password, the three
 * account-deletion mails) renders through `renderEmail` so they share one
 * look: a Marfa brand header (a near-black rounded logo square + wordmark,
 * pure inline HTML — no external image to block or break), a white card on
 * a soft grey canvas, a 20px heading, muted body paragraphs, a full-width
 * monochrome call-to-action, and a muted footer. Colours are the same Luma
 * neutral ramp the auth pages use.
 *
 * Email HTML constraints drive the shape: table layout + inline styles only
 * (Gmail/Outlook strip <style> and class selectors), a bulletproof CTA
 * (background on the <td>, radius on both <td> and <a> so it degrades in
 * clients that ignore one), a hidden preheader for the inbox preview line,
 * and light-only (no dark variant — many clients invert unpredictably).
 *
 * `renderEmail` returns `{ subject, html, text }` — the same shape every
 * template exported before, so the transport wiring is unchanged. The
 * plain-text part is assembled from the same content so it never drifts
 * from the HTML.
 */

const BG = "#f5f5f5";
const CARD = "#ffffff";
const FG = "#0a0a0a";
const MUTED = "#737373";
const FAINT = "#a3a3a3";
const BORDER = "#e5e5e5";
const HAIRLINE = "#ededed";
const PRIMARY = "#171717";
const PRIMARY_FG = "#fafafa";

/* Danger tints — for the warning callout on the pending-deletion mail. */
const DANGER_FG = "#b42318";
const DANGER_BG = "#fef3f2";
const DANGER_BORDER = "#fecdca";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface EmailButton {
  label: string;
  url: string;
}

export interface EmailContent {
  /** Subject line — passed straight through, unchanged. */
  subject: string;
  /** Card heading (h1). */
  heading: string;
  /** Muted paragraphs shown before the call-to-action. */
  intro: string[];
  /** Primary action button. Omit for an information-only email. */
  button?: EmailButton;
  /**
   * Optional danger-tinted warning box (e.g. the scheduled-deletion
   * notice). Rendered between the intro and the button.
   */
  callout?: string;
  /** Muted paragraphs shown after the call-to-action. */
  outro?: string[];
  /**
   * Whether to render the "or paste this URL" fallback under the button.
   * Defaults to true when a button is present.
   */
  showRawUrl?: boolean;
}

export function renderEmail(content: EmailContent): RenderedEmail {
  const {
    subject,
    heading,
    intro,
    button,
    callout,
    outro = [],
    showRawUrl = true,
  } = content;

  const introHtml = intro
    .map(
      (p) =>
        `<p style="margin:0 0 16px 0;color:${MUTED};font-size:15px;line-height:1.55;">${escapeHtml(
          p,
        )}</p>`,
    )
    .join("\n");

  const calloutHtml = callout
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px 0;"><tr><td style="background:${DANGER_BG};border:1px solid ${DANGER_BORDER};border-radius:10px;padding:12px 14px;color:${DANGER_FG};font-size:14px;line-height:1.5;">${escapeHtml(
        callout,
      )}</td></tr></table>`
    : "";

  const buttonHtml = button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 0 0;"><tr><td style="border-radius:10px;background:${PRIMARY};"><a href="${escapeAttr(
        button.url,
      )}" style="display:inline-block;padding:13px 26px;color:${PRIMARY_FG};text-decoration:none;font-weight:600;font-size:15px;line-height:20px;border-radius:10px;">${escapeHtml(
        button.label,
      )}</a></td></tr></table>`
    : "";

  const rawUrlHtml =
    button && showRawUrl
      ? `<p style="margin:24px 0 0 0;color:${MUTED};font-size:13px;">Or paste this URL into your browser:</p>
<p style="margin:6px 0 0 0;word-break:break-all;font-size:13px;color:${FAINT};">${escapeHtml(
          button.url,
        )}</p>`
      : "";

  const outroHtml = outro.length
    ? `<hr style="margin:28px 0;border:0;border-top:1px solid ${HAIRLINE};">
${outro
  .map(
    (p) =>
      `<p style="margin:0 0 10px 0;color:${MUTED};font-size:13px;line-height:1.55;">${escapeHtml(
        p,
      )}</p>`,
  )
  .join("\n")}`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${BG};color:${FG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(
    intro[0] ?? subject,
  )}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BG};padding:32px 16px;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;width:100%;">
<tr><td style="padding:0 4px 18px 4px;">
<span style="display:inline-block;width:28px;height:28px;background:${PRIMARY};border-radius:8px;text-align:center;line-height:28px;color:${PRIMARY_FG};font-weight:700;font-size:15px;vertical-align:middle;">M</span>
<span style="vertical-align:middle;margin-left:10px;font-size:16px;font-weight:600;color:${FG};">Marfa</span>
</td></tr>
<tr><td style="background:${CARD};border:1px solid ${BORDER};border-radius:16px;padding:32px;">
<h1 style="margin:0 0 16px 0;font-size:20px;font-weight:600;letter-spacing:-0.01em;color:${FG};">${escapeHtml(
    heading,
  )}</h1>
${introHtml}
${calloutHtml}
${buttonHtml}
${rawUrlHtml}
${outroHtml}
</td></tr>
<tr><td style="padding:18px 4px 0 4px;color:${FAINT};font-size:12px;line-height:1.5;">Sent by Marfa. If this wasn't you, you can ignore this email.</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const textParts: string[] = [heading, ""];
  for (const p of intro) textParts.push(p, "");
  if (callout) textParts.push(callout, "");
  if (button) textParts.push(button.url, "");
  for (const p of outro) textParts.push(p, "");
  textParts.push("— Marfa");
  const text = textParts.join("\n");

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
