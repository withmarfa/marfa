/**
 * The show and hide control on a password field.
 *
 * The server renders the button hidden; this module reveals it once the field
 * has a value, because there is nothing to show in an empty one, and flips the
 * input between `password` and `text`. A browser that runs no script never
 * sees a button that does nothing.
 */
export function initPasswordFields(root: ParentNode = document): void {
  for (const wrap of root.querySelectorAll<HTMLElement>("[data-password]")) {
    const input = wrap.querySelector<HTMLInputElement>("input");
    const button = wrap.querySelector<HTMLButtonElement>(
      "[data-password-toggle]",
    );
    if (!input || !button) continue;
    const show = button.querySelector<SVGElement>("[data-icon-show]");
    const hide = button.querySelector<SVGElement>("[data-icon-hide]");
    const sync = (): void => {
      button.hidden = input.value.length === 0;
    };
    sync();
    input.addEventListener("input", sync);

    button.addEventListener("click", () => {
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      const label = reveal ? "Hide password" : "Show password";
      button.setAttribute("aria-pressed", String(reveal));
      button.setAttribute("aria-label", label);
      button.title = label;
      show?.toggleAttribute("hidden", reveal);
      hide?.toggleAttribute("hidden", !reveal);
      // Flipping the type can drop focus and move the caret to the end.
      const end = input.value.length;
      input.focus();
      try {
        input.setSelectionRange(end, end);
      } catch {
        // A type that takes no selection leaves the caret where it is.
      }
    });
  }
}
