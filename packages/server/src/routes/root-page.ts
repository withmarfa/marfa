/**
 * What a person sees when they open the server's address in a browser. A
 * program asking the same address gets the instance's JSON description, which
 * is what the address is for.
 */

import { renderAuthLayout } from "./auth-layout.js";
import { DEFAULT_INSTANCE_NAME } from "../instance-name.js";
import { confirmIcon, escapeHtml } from "./auth-html.js";

/** Renders the page a browser gets at the server's root. */
export function renderRootPage(
  nonce: string,
  instanceName = DEFAULT_INSTANCE_NAME,
): string {
  const bodyHtml = `
    ${confirmIcon("check")}
    <h1 class="title">${escapeHtml(instanceName)} is running</h1>
    <p class="sub">This is a Marfa server. To use it, open an app and connect it to this address.</p>
    <div class="actions"><a class="btn btn--primary" href="/auth/sign-in">Sign in</a></div>
  `;

  return renderAuthLayout({
    title: instanceName,
    bodyHtml,
    centered: true,
    nonce,
  });
}
