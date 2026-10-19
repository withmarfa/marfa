/**
 * Native `<dialog>` elements, opened by a button that names one and closed by
 * a button inside it, Escape, or a click on the backdrop. The browser traps
 * focus inside a modal dialog and inerts the page behind it; this module
 * returns focus to whatever opened it, which the browser does not do for
 * every opener.
 */
const openers = new WeakMap<HTMLDialogElement, HTMLElement>();

export function openDialog(
  dialog: HTMLDialogElement,
  opener: Element | null = document.activeElement,
): void {
  if (dialog.open) return;
  if (opener instanceof HTMLElement) openers.set(dialog, opener);
  dialog.showModal();
}

export function initDialogs(): void {
  // Where the press began. A drag that starts in a field (to select text) and
  // ends on the backdrop produces a click on the dialog element, which must
  // not count as a click on the backdrop.
  let pressedOnBackdrop = false;
  document.addEventListener(
    "pointerdown",
    (event) => {
      pressedOnBackdrop =
        event.target instanceof HTMLDialogElement && event.target.open;
    },
    true,
  );

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const opener = target.closest<HTMLElement>("[data-dialog-open]");
    if (opener) {
      const dialog = document.getElementById(opener.dataset.dialogOpen ?? "");
      if (dialog instanceof HTMLDialogElement) {
        event.preventDefault();
        openDialog(dialog, opener);
      }
      return;
    }

    const closer = target.closest("[data-dialog-close]");
    if (closer) {
      const dialog = closer.closest("dialog");
      if (dialog) {
        event.preventDefault();
        dialog.close();
      }
      return;
    }

    // A click on the backdrop lands on the dialog element itself, because the
    // card inside it fills the box.
    if (target instanceof HTMLDialogElement && target.open && pressedOnBackdrop)
      target.close();
  });

  // `close` does not bubble, so it is heard on the way down.
  document.addEventListener(
    "close",
    (event) => {
      const dialog = event.target;
      if (!(dialog instanceof HTMLDialogElement)) return;
      const opener = openers.get(dialog);
      openers.delete(dialog);
      if (opener?.isConnected) opener.focus();
    },
    true,
  );
}
