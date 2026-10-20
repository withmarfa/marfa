/**
 * What the pages that save and reload share: a word that carries over to the
 * next page, and a button that is busy.
 */
import { parseWaitSeconds, waitInMinutes } from "../lockout.js";
import { SETUP_WORDS } from "../setup-words.js";
import { messageOf } from "./confirm.js";
import { showNotice } from "./notice.js";

/** Keeps `message` for the page that loads next, under the page family's `key`. */
export function keepFlash(key: string, message: string): void {
  try {
    sessionStorage.setItem(key, message);
  } catch {
    // Without storage the next page simply says nothing.
  }
}

/** Shows, once, what the page before it left to say. */
export function showFlash(key: string): void {
  try {
    const message = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    if (message !== null) showNotice(document, "flash", message);
  } catch {
    // Without storage there is nothing to say.
  }
}

/** Shows a button as working, with the label its markup names, or puts it back. */
export function busy(button: HTMLButtonElement, on: boolean): void {
  if (on) {
    button.dataset.idleLabel ??= button.textContent;
    button.textContent = button.dataset.loadingLabel ?? "Working...";
    button.classList.add("is-loading");
    button.setAttribute("aria-busy", "true");
  } else {
    if (button.dataset.idleLabel !== undefined)
      button.textContent = button.dataset.idleLabel;
    delete button.dataset.idleLabel;
    button.classList.remove("is-loading");
    button.removeAttribute("aria-busy");
  }
}

/** What a refusal says when it is not about one field. */
export async function refusalText(response: Response): Promise<string> {
  if (response.status === 429) {
    const wait = parseWaitSeconds(response.headers.get("retry-after"));
    return wait === undefined
      ? "Too many attempts. Try again later."
      : `Too many attempts. Try again in ${waitInMinutes(wait)}.`;
  }
  return response.status === 400 || response.status === 403
    ? (await messageOf(response)) || SETUP_WORDS.somethingWrong
    : SETUP_WORDS.somethingWrong;
}
