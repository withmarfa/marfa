import type { Child } from "hono/jsx";
import { pageAssetUrl } from "../assets.js";

/** A nonce as the content security policy spells one: base64, never empty. */
const NONCE = /^[A-Za-z0-9+/_-]+={0,2}$/;

export interface PageShellProps {
  /** The document title: what a tab and a history entry show. */
  title: string;
  /** The nonce this response's content security policy names. */
  nonce: string;
  /**
   * Whether the page does anything with the script. Defaults to true. A page
   * that works in full without it sets this to false and then neither loads
   * the script nor tells a reader it needs one.
   */
  needsScript?: boolean;
  children?: Child;
}

/**
 * The document around every page: doctype and language, the viewport, the
 * title, the stylesheet and script that carry the page's nonce, and a line for
 * a browser that is not running scripts.
 *
 * A missing or malformed nonce throws. Without the right one the policy
 * blocks the stylesheet and script, so a page rendered with `nonce=""` would
 * look unstyled and do nothing, and say nothing about why.
 */
export function PageShell(props: PageShellProps) {
  if (typeof props.nonce !== "string" || !NONCE.test(props.nonce))
    throw new Error(
      "PageShell needs the nonce the response's content security policy names",
    );
  const needsScript = props.needsScript ?? true;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <meta name="color-scheme" content="light dark" />
        <title>{props.title}</title>
        <link
          rel="stylesheet"
          href={pageAssetUrl("pages.css")}
          nonce={props.nonce}
        />
      </head>
      <body>
        <a class="skip" href="#main">
          Skip to content
        </a>
        {needsScript && (
          <noscript>
            <p class="noscript">
              This page needs JavaScript. Turn it on to continue.
            </p>
          </noscript>
        )}
        {props.children}
        {needsScript && (
          <script src={pageAssetUrl("pages.js")} nonce={props.nonce} defer />
        )}
      </body>
    </html>
  );
}
