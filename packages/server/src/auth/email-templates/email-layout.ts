/**
 * Shared layout for Marfa's transactional emails.
 *
 * Every template (verify-email, magic-link, reset-password, the three
 * account-deletion mails) renders through `renderEmail` so they share one
 * look: the "Marfa" wordmark, a clean borderless message block on a light
 * canvas, a heading, readable body paragraphs, an optional danger-tinted
 * callout, a small pill call-to-action, a quiet fallback link, and a muted
 * footer.
 *
 * Email HTML constraints drive the shape: table layout + inline styles
 * (Gmail/Outlook strip class selectors), a bulletproof CTA (background on
 * the <td>, radius on both <td> and <a> so it degrades when a client ignores
 * one), and a hidden preheader for the inbox preview line. The full action
 * URL is never printed in the body (long tokens wrap badly and trip some
 * clients), so it lives only as the button/fallback href and in the
 * plain-text part, which always carries the pasteable URL.
 *
 * Dark mode is best-effort. The inline styles are the light defaults; a
 * `color-scheme` declaration plus a `prefers-color-scheme: dark` block in
 * <head> (targeting classes, with `!important` so it wins over the inline
 * light values) flips the palette in clients that keep <style> and honor
 * the query (Apple Mail, iOS Mail, and similar). Clients that strip <style>
 * (notably Gmail) simply keep the clean light version.
 *
 * `renderEmail` returns `{ subject, html, text }` so the transport wiring is
 * unchanged. The plain-text part is assembled from the same content so it
 * never drifts from the HTML.
 */

/* Light palette (inline defaults). */
const BG = "#f5f5f5";
const CARD = "#ffffff";
const HEADING = "#0a0a0a";
const BODY = "#3f3f46";
const MUTED = "#71717a";
const FAINT = "#a1a1aa";
const HAIRLINE = "#ededed";
const PRIMARY = "#171717";
const PRIMARY_FG = "#fafafa";
const DANGER_FG = "#b42318";
const DANGER_BG = "#fef3f2";
const DANGER_BORDER = "#fecdca";

/* Dark palette (applied via the prefers-color-scheme block below). */
const D_BG = "#050505";
const D_CARD = "#161616";
const D_HEADING = "#fafafa";
const D_BODY = "#d4d4d8";
const D_MUTED = "#a1a1aa";
const D_FAINT = "#8a8a8a";
const D_HAIRLINE = "#2a2a2a";
const D_PRIMARY = "#fafafa";
const D_PRIMARY_FG = "#111111";
const D_DANGER_FG = "#f5b5ad";
const D_DANGER_BG = "#241312";
const D_DANGER_BORDER = "#5a2a26";

/* Best-effort dark mode. Inline styles stay light; these class rules win
 * (via !important) only in clients that keep <style> and honor the query. */
const DARK_STYLE = `@media (prefers-color-scheme: dark) {
  .m-canvas { background: ${D_BG} !important; }
  .m-card { background: ${D_CARD} !important; }
  .m-wordmark, .m-heading { color: ${D_HEADING} !important; }
  .m-body { color: ${D_BODY} !important; }
  .m-muted { color: ${D_MUTED} !important; }
  .m-link { color: ${D_HEADING} !important; }
  .m-callout { background: ${D_DANGER_BG} !important; border-color: ${D_DANGER_BORDER} !important; color: ${D_DANGER_FG} !important; }
  .m-btn-cell { background: ${D_PRIMARY} !important; }
  .m-btn { color: ${D_PRIMARY_FG} !important; }
  .m-divider { border-color: ${D_HAIRLINE} !important; }
  .m-footer, .m-outro { color: ${D_FAINT} !important; }
}`;

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
  /** Subject line, passed straight through, unchanged. */
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
        `<p class="m-body" style="margin:0 0 16px 0;color:${BODY};font-size:15px;line-height:1.65;">${escapeHtml(
          p,
        )}</p>`,
    )
    .join("\n");

  const calloutHtml = callout
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:12px 0 20px 0;"><tr><td class="m-callout" style="background:${DANGER_BG};border:1px solid ${DANGER_BORDER};border-radius:12px;padding:13px 15px;color:${DANGER_FG};font-size:14px;line-height:1.5;">${escapeHtml(
        callout,
      )}</td></tr></table>`
    : "";

  const noteHtml = note
    ? `<p class="m-muted" style="margin:0;color:${MUTED};font-size:13.5px;line-height:1.55;">${escapeHtml(
        note,
      )}</p>`
    : "";

  const buttonHtml = button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0 0;"><tr><td class="m-btn-cell" style="border-radius:999px;background:${PRIMARY};"><a class="m-btn" href="${escapeAttr(
        button.url,
      )}" style="display:inline-block;padding:12px 28px;color:${PRIMARY_FG};text-decoration:none;font-weight:500;font-size:15px;line-height:20px;border-radius:999px;">${escapeHtml(
        button.label,
      )}</a></td></tr></table>`
    : "";

  const fallbackHtml =
    button && showFallbackLink
      ? `<p class="m-muted" style="margin:18px 0 0 0;color:${MUTED};font-size:13px;line-height:1.55;">Button not working? <a class="m-link" href="${escapeAttr(
          button.url,
        )}" style="color:${HEADING};font-weight:500;text-decoration:underline;">Open the link directly</a>.</p>`
      : "";

  const outroHtml = outro.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:28px 0 0 0;"><tr><td class="m-divider" style="border-top:1px solid ${HAIRLINE};font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>
${outro
  .map(
    (p) =>
      `<p class="m-outro" style="margin:18px 0 0 0;color:${MUTED};font-size:13px;line-height:1.6;">${escapeHtml(
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
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(subject)}</title>
<style>${DARK_STYLE}</style>
</head>
<body class="m-canvas" style="margin:0;padding:0;background:${BG};color:${HEADING};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(
    intro[0] ?? subject,
  )}</div>
<table role="presentation" class="m-canvas" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BG};padding:40px 16px;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
<tr><td class="m-card" style="background:${CARD};border-radius:10px;padding:36px;">
<div class="m-wordmark" style="font-size:16px;font-weight:600;letter-spacing:-0.01em;color:${HEADING};line-height:1;">Marfa</div>
<h1 class="m-heading" style="margin:24px 0 0 0;font-size:22px;font-weight:600;letter-spacing:-0.015em;line-height:1.3;color:${HEADING};">${escapeHtml(
    heading,
  )}</h1>
<div style="height:14px;line-height:14px;font-size:0;">&nbsp;</div>
${introHtml}
${calloutHtml}
${noteHtml}
${buttonHtml}
${fallbackHtml}
${outroHtml}
</td></tr>
<tr><td class="m-footer" style="padding:18px 2px 0 2px;text-align:center;color:${FAINT};font-size:12px;line-height:1.5;">Sent by Marfa</td></tr>
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
  textParts.push("Marfa");
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
