import { messageOf, sendConfirmed, signInAgain } from "./confirm.js";
import { busy, keepFlash, refusalText } from "./page-state.js";
const FLASH = "marfa-items-flash";
function problem(root: ParentNode, text: string) {
  const slot = root.querySelector<HTMLElement>("[data-item-problem]");
  const words = slot?.querySelector<HTMLElement>("[data-item-problem-text]");
  if (words) words.textContent = text;
  if (slot) slot.hidden = false;
}
async function change(button: HTMLButtonElement): Promise<void> {
  if (
    button.dataset.sending === "1" ||
    button.getAttribute("aria-disabled") === "true"
  )
    return;
  const action = button.dataset.itemChange;
  const id = button.dataset.itemId ?? "";
  const version = button.dataset.itemVersion ?? "";
  const dialog = button.closest<HTMLDialogElement>("dialog");
  const root =
    dialog ?? button.closest<HTMLElement>("[data-item-actions]") ?? document;
  root
    .querySelector<HTMLElement>("[data-item-problem]")
    ?.setAttribute("hidden", "");
  button.dataset.sending = "1";
  busy(button, true);
  dialog?.querySelector(".card")?.setAttribute("aria-busy", "true");
  let leaving = false;
  try {
    let cursor: string | null = null;
    let purged = 0;
    let failed = 0;
    do {
      const url =
        action === "type"
          ? `/types/${encodeURIComponent(id)}`
          : action === "empty"
            ? `/trash/empty${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`
            : `/items/summaries/${encodeURIComponent(id)}/${action ?? ""}?version=${encodeURIComponent(version)}`;
      const response = await sendConfirmed(
        () =>
          fetch(url, {
            method: action === "type" ? "DELETE" : "POST",
            credentials: "same-origin",
            headers: { accept: "application/json" },
          }),
        "To change these items, confirm it's you.",
        button,
      );
      if (response === null) {
        if (purged || failed)
          problem(
            root,
            `${String(purged)} items deleted; ${String(failed)} could not be deleted. The operation stopped. Refresh the page to see what remains.`,
          );
        return;
      }
      if (response.status === 401) {
        leaving = true;
        signInAgain();
        return;
      }
      if (!response.ok) {
        problem(
          root,
          response.status === 409 || response.status === 404
            ? await messageOf(response)
            : await refusalText(response),
        );
        return;
      }
      if (action !== "empty") break;
      const result = (await response.json()) as {
        purged: number;
        failures: unknown[];
        next_cursor: string | null;
      };
      purged += result.purged;
      failed += result.failures.length;
      cursor = result.next_cursor;
    } while (cursor);
    const message =
      action === "empty"
        ? `${String(purged)} items deleted.${failed ? ` ${String(failed)} could not be deleted. Refresh the page to see what remains.` : ""}`
        : action === "trash"
          ? "Moved to the trash"
          : action === "restore"
            ? "Restored from the trash"
            : action === "type"
              ? "Type removed"
              : "Item deleted for good";
    keepFlash(FLASH, message);
    leaving = true;
    if (action === "type") location.assign("/auth/owner/items");
    else location.reload();
  } catch {
    problem(
      root,
      "Marfa didn't answer, so the result isn't known. Refresh the page to see what remains before trying again.",
    );
  } finally {
    delete button.dataset.sending;
    dialog?.querySelector(".card")?.removeAttribute("aria-busy");
    if (!leaving) busy(button, false);
  }
}
export function initItems(): void {
  const flash = document.querySelector<HTMLElement>("[data-item-flash]");
  let message: string | null = null;
  try {
    message = sessionStorage.getItem(FLASH);
    sessionStorage.removeItem(FLASH);
  } catch {
    /* A page works without session storage. */
  }
  if (flash && message) {
    flash.textContent = message;
    flash.hidden = false;
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "button[data-item-change]",
  ))
    button.addEventListener("click", () => {
      void change(button);
    });
}
