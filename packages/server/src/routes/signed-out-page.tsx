/**
 * What a person sees at the end of a browser logout.
 *
 * The OAuth Provider plugin's RP-initiated logout ends the session and then
 * redirects, but only when the app's `post_logout_redirect_uri` exactly
 * matches one it registered. On any other outcome it falls off the end of its
 * handler and returns undefined, which serializes as an empty 200: the
 * session really is gone, and the person is looking at a blank document with
 * no indication that anything worked or any way onward.
 *
 * So this is the floor rather than the happy path. A correctly registered
 * client still gets its redirect and never arrives here. A deployment that
 * has misregistered one gets a page that tells the truth instead of a blank
 * tab, which is the difference between a small configuration bug and a
 * logout that looks broken.
 */
import { renderDocument } from "../pages/render.js";
import { Button } from "../pages/parts/controls.js";
import { MomentCard } from "../pages/parts/layout.js";
import { PageShell } from "../pages/parts/shell.js";

const TITLE = "You're signed out";

/** Renders the end-of-logout page as a full HTML document. */
export function renderSignedOutPage(nonce: string): string {
  return renderDocument(
    <PageShell title={TITLE} nonce={nonce}>
      <MomentCard
        title={TITLE}
        lede="Your session on this device has ended. Sign in again to carry on."
        ledeRole="status"
      >
        <Button kind="primary" wide href="/auth/sign-in">
          Sign in
        </Button>
      </MomentCard>
    </PageShell>,
  );
}
