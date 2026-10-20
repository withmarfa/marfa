/**
 * A connector's page: clearing its saved state and removing it.
 *
 * The server draws the page and writes every word into the markup. This
 * module sends the change through the public doors
 * (`DELETE /connectors/{id}/state` and `DELETE /connectors/{id}`) and shows
 * what came back. A change that needs a recent sign-in goes through
 * `sendConfirmed`.
 */
import { SETUP_WORDS } from "../setup-words.js";
import { sendConfirmed, signInAgain } from "./confirm.js";
import { hideNotices, showNotice } from "./notice.js";
import { busy, hook, keepFlash, refusalText, showFlash } from "./page-state.js";

const CONNECTORS_HREF = "/auth/owner/connectors";
const FLASH = "marfa-connectors-flash";

interface Change {
  dialog: string;
  hook: string;
  /** The path of the door, after the connector's id. */
  path: string;
  /** Where the person goes once it is done; the page again if none. */
  then: string | null;
  said: (name: string) => string;
}

const CHANGES: readonly Change[] = [
  {
    dialog: "connector-clear-dialog",
    hook: "connector-clear",
    path: "/state",
    then: null,
    said: (name) => `Cleared the saved state for ${name}`,
  },
  {
    dialog: "connector-remove-dialog",
    hook: "connector-remove",
    path: "",
    then: CONNECTORS_HREF,
    said: (name) => `Removed ${name}`,
  },
];

async function send(change: Change): Promise<void> {
  const dialog = document.getElementById(change.dialog);
  if (!(dialog instanceof HTMLDialogElement)) return;
  const button = hook(dialog, change.hook);
  if (!(button instanceof HTMLButtonElement) || dialog.dataset.sending === "1")
    return;
  const id = dialog.dataset.connectorId ?? "";
  const name = dialog.dataset.connectorName ?? "the connector";
  const slot = `${change.hook}-problem`;
  hideNotices(dialog);
  dialog.dataset.sending = "1";
  // The shared dialog script refuses Escape and the backdrop while its card is busy.
  dialog.querySelector(".card")?.setAttribute("aria-busy", "true");
  busy(button, true);
  let leaving = false;
  try {
    const response = await sendConfirmed(
      () =>
        fetch(`/connectors/${encodeURIComponent(id)}${change.path}`, {
          method: "DELETE",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        }),
      dialog.dataset.confirmWhy ?? "Confirm it's you.",
      button,
    );
    if (response === null) return;
    // A connector that is already gone is the state the person asked for.
    if (response.ok || response.status === 404) {
      keepFlash(FLASH, change.said(name));
      leaving = true;
      if (change.then === null) location.reload();
      else location.assign(change.then);
      return;
    }
    if (response.status === 401) {
      signInAgain();
      leaving = true;
      return;
    }
    showNotice(dialog, slot, await refusalText(response));
  } catch {
    showNotice(dialog, slot, SETUP_WORDS.network);
  } finally {
    delete dialog.dataset.sending;
    dialog.querySelector(".card")?.removeAttribute("aria-busy");
    if (!leaving) busy(button, false);
  }
}

export function initConnectors(): void {
  if (!location.pathname.startsWith(CONNECTORS_HREF)) return;
  showFlash(FLASH);
  for (const change of CHANGES) {
    const dialog = document.getElementById(change.dialog);
    if (!dialog) continue;
    hook(dialog, change.hook)?.addEventListener("click", () => {
      void send(change);
    });
  }
}
