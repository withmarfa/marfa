/**
 * Shared layout for Marfa's transactional emails, as a React component.
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
 * Rendering is synchronous `renderToStaticMarkup` from react-dom rather
 * than a React Email renderer: every consumer (Better Auth hooks, the
 * account routes, the gallery) calls these renderers synchronously, and the
 * upstream `render()` went Promise-only. The component-kit package is not
 * used either — `@react-email/components` is deprecated upstream, and its
 * successor bundles the preview tooling's dependency tree into production
 * installs; plain elements carry the email constraints just as well.
 *
 * `renderEmail` returns `{ subject, html, text }` so the transport wiring is
 * unchanged. The plain-text part is assembled from the same content so it
 * never drifts from the HTML. The <title> carries the subject; the dev
 * gallery reads it back from the rendered document.
 */
import type { CSSProperties } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/* `mso-hide` is Outlook's proprietary hide-from-rendering property; it is
 * not in React's CSSProperties, so the preheader style needs the cast. */
const PREHEADER_STYLE = {
  display: "none",
  maxHeight: 0,
  overflow: "hidden",
  opacity: 0,
  msoHide: "all",
} as CSSProperties;

/* Non-breaking space: an empty spacer cell collapses in some clients. */
const NBSP = " ";

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

function EmailLayout({ content }: { content: EmailContent }) {
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

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <title>{subject}</title>
        <style dangerouslySetInnerHTML={{ __html: DARK_STYLE }} />
      </head>
      <body
        className="m-canvas"
        style={{
          margin: 0,
          padding: 0,
          background: BG,
          color: HEADING,
          fontFamily:
            "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif",
          fontSize: "15px",
          lineHeight: 1.6,
          WebkitFontSmoothing: "antialiased",
        }}
      >
        <div style={PREHEADER_STYLE}>{intro[0] ?? subject}</div>
        <table
          role="presentation"
          className="m-canvas"
          cellPadding={0}
          cellSpacing={0}
          border={0}
          width="100%"
          style={{ background: BG, padding: "40px 16px" }}
        >
          <tbody>
            <tr>
              <td align="center">
                <table
                  role="presentation"
                  cellPadding={0}
                  cellSpacing={0}
                  border={0}
                  style={{ maxWidth: "600px", width: "100%" }}
                >
                  <tbody>
                    <tr>
                      <td
                        className="m-card"
                        style={{
                          background: CARD,
                          borderRadius: "10px",
                          padding: "36px",
                        }}
                      >
                        <div
                          className="m-wordmark"
                          style={{
                            fontSize: "16px",
                            fontWeight: 600,
                            letterSpacing: "-0.01em",
                            color: HEADING,
                            lineHeight: 1,
                          }}
                        >
                          Marfa
                        </div>
                        <h1
                          className="m-heading"
                          style={{
                            margin: "24px 0 0 0",
                            fontSize: "22px",
                            fontWeight: 600,
                            letterSpacing: "-0.015em",
                            lineHeight: 1.3,
                            color: HEADING,
                          }}
                        >
                          {heading}
                        </h1>
                        <div
                          style={{
                            height: "14px",
                            lineHeight: "14px",
                            fontSize: 0,
                          }}
                        >
                          {NBSP}
                        </div>
                        {intro.map((p, i) => (
                          <p
                            key={i}
                            className="m-body"
                            style={{
                              margin: "0 0 16px 0",
                              color: BODY,
                              fontSize: "15px",
                              lineHeight: 1.65,
                            }}
                          >
                            {p}
                          </p>
                        ))}
                        {callout !== undefined && (
                          <table
                            role="presentation"
                            cellPadding={0}
                            cellSpacing={0}
                            border={0}
                            width="100%"
                            style={{ margin: "12px 0 20px 0" }}
                          >
                            <tbody>
                              <tr>
                                <td
                                  className="m-callout"
                                  style={{
                                    background: DANGER_BG,
                                    border: `1px solid ${DANGER_BORDER}`,
                                    borderRadius: "12px",
                                    padding: "13px 15px",
                                    color: DANGER_FG,
                                    fontSize: "14px",
                                    lineHeight: 1.5,
                                  }}
                                >
                                  {callout}
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        )}
                        {note !== undefined && (
                          <p
                            className="m-muted"
                            style={{
                              margin: 0,
                              color: MUTED,
                              fontSize: "13.5px",
                              lineHeight: 1.55,
                            }}
                          >
                            {note}
                          </p>
                        )}
                        {button && (
                          <table
                            role="presentation"
                            cellPadding={0}
                            cellSpacing={0}
                            border={0}
                            style={{ margin: "24px 0 0 0" }}
                          >
                            <tbody>
                              <tr>
                                <td
                                  className="m-btn-cell"
                                  style={{
                                    borderRadius: "999px",
                                    background: PRIMARY,
                                  }}
                                >
                                  <a
                                    className="m-btn"
                                    href={button.url}
                                    style={{
                                      display: "inline-block",
                                      padding: "12px 28px",
                                      color: PRIMARY_FG,
                                      textDecoration: "none",
                                      fontWeight: 500,
                                      fontSize: "15px",
                                      lineHeight: "20px",
                                      borderRadius: "999px",
                                    }}
                                  >
                                    {button.label}
                                  </a>
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        )}
                        {button && showFallbackLink && (
                          <p
                            className="m-muted"
                            style={{
                              margin: "18px 0 0 0",
                              color: MUTED,
                              fontSize: "13px",
                              lineHeight: 1.55,
                            }}
                          >
                            {"Button not working? "}
                            <a
                              className="m-link"
                              href={button.url}
                              style={{
                                color: HEADING,
                                fontWeight: 500,
                                textDecoration: "underline",
                              }}
                            >
                              Open the link directly
                            </a>
                            .
                          </p>
                        )}
                        {outro.length > 0 && (
                          <>
                            <table
                              role="presentation"
                              cellPadding={0}
                              cellSpacing={0}
                              border={0}
                              width="100%"
                              style={{ margin: "28px 0 0 0" }}
                            >
                              <tbody>
                                <tr>
                                  <td
                                    className="m-divider"
                                    style={{
                                      borderTop: `1px solid ${HAIRLINE}`,
                                      fontSize: 0,
                                      lineHeight: 0,
                                      height: "1px",
                                    }}
                                  >
                                    {NBSP}
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                            {outro.map((p, i) => (
                              <p
                                key={i}
                                className="m-outro"
                                style={{
                                  margin: "18px 0 0 0",
                                  color: MUTED,
                                  fontSize: "13px",
                                  lineHeight: 1.6,
                                }}
                              >
                                {p}
                              </p>
                            ))}
                          </>
                        )}
                      </td>
                    </tr>
                    <tr>
                      <td
                        className="m-footer"
                        style={{
                          padding: "18px 2px 0 2px",
                          textAlign: "center",
                          color: FAINT,
                          fontSize: "12px",
                          lineHeight: 1.5,
                        }}
                      >
                        Sent by Marfa
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  );
}

export function renderEmail(content: EmailContent): RenderedEmail {
  const html = `<!DOCTYPE html>\n${renderToStaticMarkup(
    <EmailLayout content={content} />,
  )}`;

  const {
    subject,
    heading,
    intro,
    button,
    callout,
    note,
    outro = [],
  } = content;
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
