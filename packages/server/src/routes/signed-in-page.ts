/**
 * What a person sees when they are signed in and there is nowhere further to
 * send them: at the server's address after signing in with no app waiting,
 * and when they open the sign-in page while a session already exists and no
 * authorization sent them.
 */

import { renderAuthLayout } from "./auth-layout.js";
import { confirmIcon, escapeHtml } from "./auth-html.js";

interface SignedInPageParams {
  /** The nonce the response's content security policy names. */
  nonce: string;
  /** The signed-in person's email, so the page says who. */
  email: string;
  /**
   * Where the person was headed when they arrived, already passed through
   * `validateReturnTo`. Offered as a link when it is somewhere other than the
   * instance's root.
   */
  continueTo?: string;
}

/** Renders the signed-in page as a full HTML document. */
export function renderSignedInPage(params: SignedInPageParams): string {
  const next =
    params.continueTo !== undefined && params.continueTo !== "/"
      ? `<div class="actions"><a class="btn btn--primary" href="${escapeHtml(params.continueTo)}">Continue</a></div>`
      : "";
  const bodyHtml = `
    ${confirmIcon("check")}
    <h1 class="title">You're signed in</h1>
    <p class="sub" role="status">You're signed in to Marfa as <b>${escapeHtml(params.email)}</b>. To use your data, open an app and connect it to this server.</p>
    ${next}
  `;

  return renderAuthLayout({
    title: "You're signed in",
    bodyHtml,
    centered: true,
    nonce: params.nonce,
  });
}
