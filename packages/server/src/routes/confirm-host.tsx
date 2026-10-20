/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { pageAssetUrl } from "../pages/assets.js";
import { ConfirmDialogHost } from "../pages/parts/index.js";

/**
 * The scripts and markup a page with its own stylesheet adds to open the
 * "Confirm it's you" dialog: the page system's script, which drives the
 * dialog, and the dialog in a shadow root so neither stylesheet reaches the
 * other. The page's own script then sends its changes through
 * `window.marfaConfirm.send`.
 */
export function confirmDialogMarkup(nonce: string): string {
  const host: { toString(): string | Promise<string> } = (
    <ConfirmDialogHost nonce={nonce} />
  );
  const markup = host.toString();
  if (typeof markup !== "string")
    throw new Error("The dialog renders synchronously");
  return `<script src="${pageAssetUrl("pages.js")}" nonce="${nonce}"></script>${markup}`;
}
