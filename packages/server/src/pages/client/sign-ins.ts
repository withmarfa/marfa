/**
 * The Connected apps and Browsers pages: disconnecting an app and signing a
 * browser out.
 *
 * The server draws every page and writes every word a person can be told into
 * the markup. This module sends the change through the public doors
 * (`DELETE /owner/sign-ins/{id}` for an app or one browser, and Better Auth's
 * `POST /auth/revoke-other-sessions` for the other browsers) and shows what
 * came back. A change that needs a recent sign-in goes through
 * `sendConfirmed`, which asks the person to confirm it's them and sends the
 * change once more.
 */
import { SETUP_WORDS } from "../setup-words.js";
import { sendConfirmed, signInAgain } from "./confirm.js";
import { hideNotices, showNotice } from "./notice.js";
import { busy, hook, keepFlash, refusalText, showFlash } from "./page-state.js";

const APPS_HREF = "/auth/owner/apps";
const FLASH = "marfa-sign-ins-flash";

const endHref = (id: string, revokeKeys: boolean): string =>
  `/owner/sign-ins/${encodeURIComponent(id)}${revokeKeys ? "?revoke_keys=true" : ""}`;

/** How a change went, for the page to act on. */
type Outcome =
  | { state: "done" }
  | { state: "gone" }
  | { state: "cancelled" }
  | { state: "signed-out" }
  | { state: "refused"; text: string }
  | { state: "failed" };

/**
 * Sends `send`, asking the person to confirm it's them if the sign-in is too
 * old. A `404` means the sign-in or browser was already gone, which is the
 * state the person asked for, but nothing was changed by this send.
 */
async function sendChange(
  send: () => Promise<Response>,
  why: string,
  opener: Element,
): Promise<Outcome> {
  try {
    const response = await sendConfirmed(send, why, opener);
    if (response === null) return { state: "cancelled" };
    if (response.ok) return { state: "done" };
    if (response.status === 404) return { state: "gone" };
    if (response.status === 401) return { state: "signed-out" };
    return { state: "refused", text: await refusalText(response) };
  } catch {
    return { state: "failed" };
  }
}

const finished = (outcome: Outcome): boolean =>
  outcome.state === "done" || outcome.state === "gone";

/** Shows an outcome that is not a success, in `slot` under `root`. Answers whether the page is on its way elsewhere. */
function report(outcome: Outcome, root: ParentNode, slot: string): boolean {
  switch (outcome.state) {
    case "signed-out":
      signInAgain();
      return true;
    case "refused":
      showNotice(root, slot, outcome.text);
      return false;
    case "failed":
      showNotice(root, slot, SETUP_WORDS.network);
      return false;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Disconnect an app
// ---------------------------------------------------------------------------

async function disconnect(dialog: HTMLDialogElement): Promise<void> {
  const button = hook(dialog, "app-disconnect");
  if (!button || dialog.dataset.sending === "1") return;
  const id = dialog.dataset.appId ?? "";
  const name = dialog.dataset.appName ?? "the app";
  const revokeKeys =
    dialog.querySelector<HTMLInputElement>("#app-revoke-keys")?.checked ===
    true;
  hideNotices(dialog);
  dialog.dataset.sending = "1";
  // The shared dialog script refuses Escape and the backdrop while its card is busy.
  dialog.querySelector(".card")?.setAttribute("aria-busy", "true");
  busy(button, true);
  let leaving = false;
  try {
    const outcome = await sendChange(
      () =>
        fetch(endHref(id, revokeKeys), {
          method: "DELETE",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        }),
      dialog.dataset.confirmWhy ?? "Confirm it's you.",
      button,
    );
    // The keys are revoked in the same step as the sign-in, so a sign-in that
    // was already gone revoked none of them.
    if (outcome.state === "gone" && revokeKeys) {
      showNotice(dialog, "disconnect-gone");
      return;
    }
    if (finished(outcome)) {
      keepFlash(FLASH, `Disconnected ${name}`);
      leaving = true;
      location.assign(APPS_HREF);
      return;
    }
    leaving = report(outcome, dialog, "disconnect-problem");
  } finally {
    delete dialog.dataset.sending;
    dialog.querySelector(".card")?.removeAttribute("aria-busy");
    if (!leaving) busy(button, false);
  }
}

// ---------------------------------------------------------------------------
// Sign a browser out
// ---------------------------------------------------------------------------

async function signOutOne(
  button: HTMLButtonElement,
  page: HTMLElement,
): Promise<void> {
  if (button.dataset.sending === "1") return;
  const id = button.dataset.signInId ?? "";
  const name = button.dataset.signInName ?? "the browser";
  hideNotices(page, ["problem"]);
  button.dataset.sending = "1";
  busy(button, true);
  let leaving = false;
  try {
    const outcome = await sendChange(
      () =>
        fetch(endHref(id, false), {
          method: "DELETE",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        }),
      page.dataset.signOutWhy ?? "Confirm it's you.",
      button,
    );
    if (finished(outcome)) {
      keepFlash(FLASH, `Signed out ${name}`);
      leaving = true;
      location.reload();
      return;
    }
    leaving = report(outcome, page, "problem");
  } finally {
    delete button.dataset.sending;
    if (!leaving) busy(button, false);
  }
}

async function signOutOthers(dialog: HTMLDialogElement): Promise<void> {
  const button = hook(dialog, "browsers-others");
  if (!button || dialog.dataset.sending === "1") return;
  hideNotices(dialog);
  dialog.dataset.sending = "1";
  dialog.querySelector(".card")?.setAttribute("aria-busy", "true");
  busy(button, true);
  let leaving = false;
  try {
    const outcome = await sendChange(
      () =>
        fetch("/auth/revoke-other-sessions", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: "{}",
        }),
      dialog.dataset.confirmWhy ?? "Confirm it's you.",
      button,
    );
    if (finished(outcome)) {
      keepFlash(FLASH, "Signed out the other browsers");
      leaving = true;
      location.reload();
      return;
    }
    leaving = report(outcome, dialog, "others-problem");
  } finally {
    delete dialog.dataset.sending;
    dialog.querySelector(".card")?.removeAttribute("aria-busy");
    if (!leaving) busy(button, false);
  }
}

// ---------------------------------------------------------------------------

export function initSignIns(): void {
  if (document.querySelector('[data-notice="flash"]')) showFlash(FLASH);
  const appDialog = document.getElementById("app-disconnect-dialog");
  if (appDialog instanceof HTMLDialogElement)
    hook(appDialog, "app-disconnect")?.addEventListener("click", () => {
      void disconnect(appDialog);
    });
  const page = document.querySelector<HTMLElement>("[data-sign-out-why]");
  if (!page) return;
  for (const button of page.querySelectorAll<HTMLButtonElement>(
    '[data-hook="browser-sign-out"]',
  ))
    button.addEventListener("click", () => {
      void signOutOne(button, page);
    });
  const others = document.getElementById("browsers-others-dialog");
  if (others instanceof HTMLDialogElement)
    hook(others, "browsers-others")?.addEventListener("click", () => {
      void signOutOthers(others);
    });
}
