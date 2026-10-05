/**
 * What a person sees when they open the server's address in a browser. A
 * program asking the same address gets the instance's JSON description, which
 * is what the address is for.
 *
 * Nothing here is read from the instance: the JSON is public, but a page
 * built from it would have to be kept in step with it for no one's benefit.
 */

import { renderAuthLayout } from "./auth-layout.js";
import { confirmIcon } from "./auth-html.js";

/** Renders the page a browser gets at the server's root. */
export function renderRootPage(nonce: string): string {
  const bodyHtml = `
    ${confirmIcon("check")}
    <h1 class="title">Marfa is running</h1>
    <p class="sub">This is a Marfa server. To use it, open an app and connect it to this address.</p>
    <div class="actions"><a class="btn btn--primary" href="/auth/sign-in">Sign in</a></div>
  `;

  return renderAuthLayout({ title: "Marfa", bodyHtml, centered: true, nonce });
}
