/**
 * Signing out from a console page. The button starts hidden, because it only
 * works with a script: it ends the browser's session at the server, then goes
 * to the page that says the person is signed out. If the server cannot be
 * reached or refuses, the page stays and says so.
 */
import { hideNotices, showNotice } from "./notice.js";

const SIGN_OUT = "/auth/sign-out";
const COULD_NOT =
  "Marfa couldn't sign you out. Check your connection and try again.";
const SIGNED_OUT = "/auth/oauth2/end-session";

async function endSession(): Promise<boolean> {
  try {
    const response = await fetch(SIGN_OUT, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: "{}",
    });
    // No session left is the state the person asked for.
    return response.ok || response.status === 401;
  } catch {
    return false;
  }
}

export function initSignOut(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-sign-out]",
  )) {
    button.hidden = false;
    button.addEventListener("click", () => {
      hideNotices(document);
      button.disabled = true;
      void endSession().then((done) => {
        if (done) {
          location.assign(SIGNED_OUT);
          return;
        }
        button.disabled = false;
        showNotice(document, "sign-out", COULD_NOT);
      });
    });
  }
}
