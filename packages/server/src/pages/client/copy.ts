/**
 * The Copy button beside a command. The server renders it hidden, because it
 * needs the clipboard, which a page gets only at a secure address.
 */
const COPIED_MS = 2000;

export function initCopy(): void {
  if (!("clipboard" in navigator)) return;
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-copy]",
  )) {
    button.hidden = false;
    const label = button.textContent;
    button.addEventListener("click", () => {
      void navigator.clipboard
        .writeText(button.dataset.copy ?? "")
        .then(() => {
          button.textContent = "Copied";
          setTimeout(() => {
            button.textContent = label;
          }, COPIED_MS);
        })
        .catch(() => {
          // A refused write leaves the command on the screen to select by hand.
        });
    });
  }
}
