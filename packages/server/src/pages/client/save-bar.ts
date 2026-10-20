/**
 * The save bar of an edit page (`SaveBar`): shown while the form differs from
 * what the page loaded, with how many controls differ, and hidden again when
 * the form is back as it loaded or has been saved.
 *
 * A control has changed when it stands anywhere but at the value the server
 * wrote into its markup, which is also what `form.reset()` puts back, so
 * Discard and the count cannot disagree. A page that has controls which do
 * not count in some state (a list that is hidden, say) names them in `counts`.
 */

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export interface SaveBarOptions {
  /** Whether a control counts toward the changes. Defaults to all of them. */
  counts?: (control: Control) => boolean;
}

export interface SaveBar {
  /** The Save button, for a page that shows it is busy. */
  readonly save: HTMLButtonElement;
  /** How many controls differ from what the page loaded. */
  count(): number;
  /** Counts again and shows or hides the bar. */
  sync(): void;
  /** The page saved: the bar goes. */
  saved(): void;
}

const NOT_VALUES = new Set(["hidden", "submit", "button", "reset", "image"]);

function isControl(element: Element): element is Control {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  );
}

/** The index a select stands at when the page loads: the one marked, else the first. */
function loadedIndex(select: HTMLSelectElement): number {
  const marked = [...select.options].findIndex(
    (option) => option.defaultSelected,
  );
  return marked >= 0 ? marked : 0;
}

function differs(control: Control): boolean {
  if (control instanceof HTMLSelectElement)
    return control.multiple
      ? [...control.options].some(
          (option) => option.selected !== option.defaultSelected,
        )
      : control.selectedIndex !== loadedIndex(control);
  if (control instanceof HTMLTextAreaElement)
    return control.value !== control.defaultValue;
  if (control.type === "checkbox" || control.type === "radio")
    return control.checked !== control.defaultChecked;
  return control.value !== control.defaultValue;
}

/** The controls of a form that differ from what the page loaded, one for each control (a group of radios is one). */
export function changedControls(
  form: HTMLFormElement,
  counts: (control: Control) => boolean = () => true,
): Control[] {
  const changed: Control[] = [];
  const radios = new Set<string>();
  for (const element of form.elements) {
    if (!isControl(element) || element.name === "" || element.disabled)
      continue;
    if (NOT_VALUES.has(element.type) || !counts(element)) continue;
    if (element.type === "radio") {
      if (radios.has(element.name)) continue;
      const group = [...form.elements].filter(
        (other): other is HTMLInputElement =>
          other instanceof HTMLInputElement &&
          other.type === "radio" &&
          other.name === element.name,
      );
      radios.add(element.name);
      const first = group.find(differs);
      if (first) changed.push(first);
      continue;
    }
    if (differs(element)) changed.push(element);
  }
  return changed;
}

export const changeWords = (count: number): string =>
  count === 1 ? "1 change" : `${String(count)} changes`;

/**
 * Wires the bar that belongs to `form` (its `SaveBar` names the form's id).
 * Returns `null` when the page has none.
 */
export function initSaveBar(
  form: HTMLFormElement,
  options: SaveBarOptions = {},
): SaveBar | null {
  if (form.id === "") return null;
  const host = document.querySelector<HTMLElement>(
    `[data-save-bar-form="${CSS.escape(form.id)}"]`,
  );
  const bar = host?.querySelector<HTMLElement>("[data-save-bar]");
  const label = host?.querySelector<HTMLElement>("[data-save-bar-count]");
  const status = host?.querySelector<HTMLElement>("[data-save-bar-status]");
  const save = host?.querySelector<HTMLButtonElement>(
    '[data-hook="save-submit"]',
  );
  const discard = host?.querySelector<HTMLButtonElement>(
    '[data-hook="save-discard"]',
  );
  if (!bar || !label || !status || !save || !discard) return null;

  const changed = (): Control[] => changedControls(form, options.counts);
  let announced = "";
  const show = (words: string | null): void => {
    bar.hidden = words === null;
    label.textContent = words ?? "";
    // A reader hears the bar appear and the count change, and nothing when it goes.
    const heard = words === null ? "" : `${words}. Save or discard.`;
    if (heard !== announced) status.textContent = heard;
    announced = heard;
  };
  const sync = (): void => {
    const count = changed().length;
    show(count === 0 ? null : changeWords(count));
  };

  discard.addEventListener("click", () => {
    if (form.dataset.sending === "1") return;
    const first = changed()[0];
    form.reset();
    // Whatever listens for a change (the lines under access rows, the lists
    // shown for a choice) follows the controls put back.
    form.dispatchEvent(new Event("change", { bubbles: true }));
    sync();
    // The pressed button has gone with the bar, so the focus goes to the
    // first control that had changed, or else to the page.
    const target = first?.checkVisibility() ? first : null;
    (target ?? document.getElementById("main"))?.focus();
  });

  form.addEventListener("input", sync);
  form.addEventListener("change", sync);
  // A page the browser kept for the back button holds the controls as they were left.
  window.addEventListener("pageshow", sync);
  sync();

  return {
    save,
    count: () => changed().length,
    sync,
    saved: () => {
      show(null);
    },
  };
}
