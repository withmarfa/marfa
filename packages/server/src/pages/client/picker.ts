/**
 * The breadcrumb's page picker: a menu of every page, and beside it, one level
 * down, the items inside the page you are in.
 *
 * Down and up move, right opens a page's items, left goes back, Escape closes
 * and returns focus to the button, and Tab leaves. Pointing at a page that has
 * items opens them beside it.
 */
import { matchesQuery, stepIndex } from "../navigation.js";

const WIDE = "(min-width: 641px)";

export function initPicker(): void {
  const button = document.querySelector<HTMLButtonElement>(
    "[data-picker-button]",
  );
  const menu = document.getElementById(
    button?.getAttribute("aria-controls") ?? "",
  );
  if (!button || !menu) return;
  const pickerButton = button;
  const pickerMenu = menu;
  pickerButton.hidden = false;

  const panels = (): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>("[data-picker-panel]"),
  ];
  const pages = (): HTMLAnchorElement[] => [
    ...pickerMenu.querySelectorAll<HTMLAnchorElement>(
      "[data-picker-list] > .menu-group > [role=menuitem]",
    ),
  ];
  const itemsOf = (panel: HTMLElement): HTMLElement[] => [
    ...panel.querySelectorAll<HTMLElement>("[role=menuitem]:not([hidden])"),
  ];
  const ownerOf = (panel: HTMLElement): HTMLAnchorElement | undefined =>
    pages().find((page) => page.dataset.panel === panel.id);

  function closePanels(): void {
    for (const panel of panels()) panel.hidden = true;
    for (const page of pages()) page.classList.remove("on");
  }

  function openPanel(owner: HTMLAnchorElement): HTMLElement | null {
    if (!window.matchMedia(WIDE).matches) return null;
    const panel = document.getElementById(owner.dataset.panel ?? "");
    if (!panel) return null;
    closePanels();
    panel.hidden = false;
    owner.classList.add("on");
    const column = owner.closest<HTMLElement>(".menu-col");
    panel.style.top = `${String(28 + owner.offsetTop - (column?.scrollTop ?? 0))}px`;
    return panel;
  }

  function focusIn(panel: HTMLElement): void {
    const current = panel.querySelector<HTMLElement>("[aria-current=page]");
    (current ?? itemsOf(panel)[0])?.focus();
    current?.scrollIntoView({ block: "center" });
  }

  function open(): void {
    pickerMenu.hidden = false;
    pickerButton.setAttribute("aria-expanded", "true");
    const here = pickerMenu.querySelector<HTMLAnchorElement>(
      "[data-picker-list] [aria-current=page]",
    );
    if (here?.dataset.panel) {
      const panel = openPanel(here);
      if (panel) {
        focusIn(panel);
        return;
      }
    }
    (here ?? pages()[0])?.focus();
  }

  function close(returnFocus: boolean): void {
    pickerMenu.hidden = true;
    closePanels();
    pickerButton.setAttribute("aria-expanded", "false");
    if (returnFocus) pickerButton.focus();
  }

  const isOpen = (): boolean => !pickerMenu.hidden;
  // The menu and its side panels are siblings, so events are heard on their parent.
  const root = pickerMenu.parentElement ?? pickerMenu;
  const inside = (node: Node): boolean =>
    root.contains(node) || pickerButton.contains(node);

  pickerButton.addEventListener("click", () => {
    if (isOpen()) close(false);
    else open();
  });

  root.addEventListener("mouseover", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const page = target.closest<HTMLAnchorElement>(
      "[data-picker-list] [role=menuitem]",
    );
    if (!page) return;
    if (page.dataset.panel) openPanel(page);
    else closePanels();
  });

  function navigable(from: HTMLElement): HTMLElement[] {
    const panel = from.closest<HTMLElement>("[data-picker-panel]");
    if (!panel) return pages();
    const filter = panel.querySelector<HTMLElement>("[data-picker-filter]");
    return [...(filter ? [filter] : []), ...itemsOf(panel)];
  }

  root.addEventListener("keydown", (event) => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    const inPanel = active.closest("[data-picker-panel]") !== null;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        const list = navigable(active);
        const next = stepIndex(
          list.indexOf(active),
          event.key === "ArrowDown" ? 1 : -1,
          list.length,
        );
        list[next]?.focus();
        break;
      }
      case "Home":
      case "End": {
        if (active instanceof HTMLInputElement) return;
        event.preventDefault();
        const list = navigable(active);
        (event.key === "Home" ? list[0] : list[list.length - 1])?.focus();
        break;
      }
      case "ArrowRight": {
        if (inPanel || active instanceof HTMLInputElement) return;
        if (!(active instanceof HTMLAnchorElement) || !active.dataset.panel)
          return;
        event.preventDefault();
        const panel = openPanel(active);
        if (panel) focusIn(panel);
        break;
      }
      case "ArrowLeft": {
        if (!inPanel) return;
        if (active instanceof HTMLInputElement && active.selectionStart) return;
        event.preventDefault();
        const panel = active.closest<HTMLElement>("[data-picker-panel]");
        const owner = panel ? ownerOf(panel) : undefined;
        closePanels();
        owner?.focus();
        break;
      }
      case "Escape":
        event.preventDefault();
        close(true);
        break;
    }
  });

  root.addEventListener("input", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const panel = input.closest<HTMLElement>("[data-picker-panel]");
    if (!panel) return;
    let shown = 0;
    for (const item of panel.querySelectorAll<HTMLElement>("[role=menuitem]")) {
      const match = matchesQuery(input.value, item.textContent);
      item.hidden = !match;
      if (match) shown += 1;
    }
    const none = panel.querySelector<HTMLElement>("[data-picker-none]");
    if (none) none.hidden = shown > 0;
  });

  document.addEventListener("click", (event) => {
    if (!isOpen()) return;
    const target = event.target;
    if (target instanceof Node && inside(target)) return;
    close(false);
  });

  document.addEventListener("focusin", (event) => {
    if (!isOpen()) return;
    const target = event.target;
    if (target instanceof Node && !inside(target)) close(false);
  });
}
