/**
 * Shared layout for Marfa's transactional emails.
 *
 * Every template (verify-email, magic-link, reset-password, the three
 * account-deletion mails) renders through `renderEmail` so they share one
 * look: a Marfa brand lockup (a near-black rounded logo square + wordmark,
 * pure inline HTML — no external image to block or break), a white card on
 * a soft grey canvas, a 22px heading, readable body paragraphs, an optional
 * danger-tinted callout, a rounded call-to-action, a quiet fallback link,
 * and a small centred footer.
 *
 * Email HTML constraints drive the shape: table layout + inline styles only
 * (Gmail/Outlook strip <style> and class selectors), a bulletproof CTA
 * (background on the <td>, radius on both <td> and <a> so it degrades in
 * clients that ignore one), a hidden preheader for the inbox preview line,
 * light-only (clients invert dark unpredictably). The full action URL is
 * never printed in the HTML body — long tokens wrap badly and trip some
 * clients — so it lives only as the button/fallback href and in the
 * plain-text part, which always carries the pasteable URL.
 *
 * `renderEmail` returns `{ subject, html, text }` — the shape every template
 * exported before — so the transport wiring is unchanged. The plain-text
 * part is assembled from the same content so it never drifts from the HTML.
 */

const BG = "#f5f5f5";
const CARD = "#ffffff";
const HEADING = "#0a0a0a";
const BODY = "#3f3f46";
const MUTED = "#71717a";
const FAINT = "#a1a1aa";
const BORDER = "#e8e8e8";
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
  /** Body paragraphs shown before the call-to-action. */
  intro: string[];
  /** Primary action button. Omit for an information-only email. */
  button?: EmailButton;
  /**
   * Optional danger-tinted warning box (e.g. the scheduled-deletion
   * notice). Rendered between the intro and the button.
   */
  callout?: string;
  /**
   * A muted fine-print line (e.g. "This link expires in N minutes")
   * shown just above the button, lighter than the body so it reads as
   * secondary detail rather than a second instruction.
   */
  note?: string;
  /** Smaller, muted notes shown after the button, under a divider. */
  outro?: string[];
  /**
   * Whether to render the "Button not working? Open the link directly"
   * fallback under the button. Defaults to true when a button is present.
   */
  showFallbackLink?: boolean;
}

export function renderEmail(content: EmailContent): RenderedEmail {
  const {
    subject,
    heading,
    intro,
    button,
    callout,
    note,
    outro = [],
    showFallbackLink = true,
  } = content;

  const introHtml = intro
    .map(
      (p) =>
        `<p style="margin:0 0 16px 0;color:${BODY};font-size:15px;line-height:1.6;">${escapeHtml(
          p,
        )}</p>`,
    )
    .join("\n");

  const calloutHtml = callout
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:12px 0 20px 0;"><tr><td style="background:${DANGER_BG};border:1px solid ${DANGER_BORDER};border-radius:12px;padding:13px 15px;color:${DANGER_FG};font-size:14px;line-height:1.5;">${escapeHtml(
        callout,
      )}</td></tr></table>`
    : "";

  const noteHtml = note
    ? `<p style="margin:0;color:${MUTED};font-size:13.5px;line-height:1.55;">${escapeHtml(
        note,
      )}</p>`
    : "";

  const buttonHtml = button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0 0;"><tr><td style="border-radius:999px;background:${PRIMARY};"><a href="${escapeAttr(
        button.url,
      )}" style="display:inline-block;padding:14px 34px;color:${PRIMARY_FG};text-decoration:none;font-weight:600;font-size:15px;line-height:20px;border-radius:999px;">${escapeHtml(
        button.label,
      )}</a></td></tr></table>`
    : "";

  const fallbackHtml =
    button && showFallbackLink
      ? `<p style="margin:18px 0 0 0;color:${MUTED};font-size:13px;line-height:1.55;">Button not working? <a href="${escapeAttr(
          button.url,
        )}" style="color:${HEADING};font-weight:500;text-decoration:underline;">Open the link directly</a>.</p>`
      : "";

  const outroHtml = outro.length
    ? `<hr style="margin:28px 0 0 0;border:0;border-top:1px solid ${HAIRLINE};">
${outro
  .map(
    (p) =>
      `<p style="margin:18px 0 0 0;color:${MUTED};font-size:13px;line-height:1.6;">${escapeHtml(
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
<body style="margin:0;padding:0;background:${BG};color:${HEADING};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(
    intro[0] ?? subject,
  )}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BG};padding:40px 16px;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;width:100%;">
<tr><td style="padding:0 2px 20px 2px;">
<span style="display:inline-block;width:30px;height:30px;background:${PRIMARY};border-radius:8px;text-align:center;line-height:30px;color:${PRIMARY_FG};font-weight:700;font-size:16px;vertical-align:middle;">M</span>
<span style="vertical-align:middle;margin-left:10px;font-size:16px;font-weight:600;letter-spacing:-0.01em;color:${HEADING};">Marfa</span>
</td></tr>
<tr><td style="background:${CARD};border:1px solid ${BORDER};border-radius:16px;padding:32px;">
<h1 style="margin:0 0 16px 0;font-size:22px;font-weight:600;letter-spacing:-0.015em;line-height:1.3;color:${HEADING};">${escapeHtml(
    heading,
  )}</h1>
${introHtml}
${calloutHtml}
${noteHtml}
${buttonHtml}
${fallbackHtml}
${outroHtml}
</td></tr>
<tr><td style="padding:20px 2px 0 2px;text-align:center;color:${FAINT};font-size:12px;line-height:1.5;">Sent by Marfa · marfa.so</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const textParts: string[] = [heading, ""];
  for (const p of intro) textParts.push(p, "");
  if (callout) textParts.push(callout, "");
  if (note) textParts.push(note, "");
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
