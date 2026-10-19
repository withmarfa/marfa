/**
 * The command search: a field and grouped one-line results over every page
 * and setting, opened from anywhere with Command-K, or Control-K where the
 * platform is not Apple's.
 *
 * The server writes every result into the dialog; this module only filters
 * them as the person types, so no search runs on the server and a page that
 * has no script still carries the links.
 */
import { rankMatches, stepIndex } from "../navigation.js";
import { openDialog } from "./dialog.js";

const PER_GROUP = 5;

function isApplePlatform(): boolean {
  const data = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData;
  return /mac|iphone|ipad|ipod/i.test(data?.platform ?? navigator.platform);
}

export function initCommandSearch(): void {
  const dialog = document.querySelector<HTMLDialogElement>(
    "[data-command-search]",
  );
  const input = dialog?.querySelector<HTMLInputElement>("[data-search-input]");
  const none = dialog?.querySelector<HTMLElement>("[data-search-none]");
  if (!dialog || !input || !none) return;
  const searchDialog = dialog;
  const searchInput = input;
  const noMatch = none;
  const apple = isApplePlatform();

  for (const hint of document.querySelectorAll<HTMLElement>(
    "[data-shortcut-hint]",
  )) {
    hint.textContent = apple ? "⌘K" : "Ctrl K";
    hint.hidden = false;
  }

  const groups = [
    ...searchDialog.querySelectorAll<HTMLElement>("[data-search-group]"),
  ];
  const optionsOf = (group: HTMLElement): HTMLAnchorElement[] => [
    ...group.querySelectorAll<HTMLAnchorElement>("[role=option]"),
  ];
  let visible: HTMLAnchorElement[] = [];
  let selected = 0;

  function select(index: number): void {
    selected = index;
    visible.forEach((option, i) => {
      option.setAttribute("aria-selected", String(i === index));
    });
    const current = visible[index];
    if (current) {
      searchInput.setAttribute("aria-activedescendant", current.id);
      current.scrollIntoView({ block: "nearest" });
    } else {
      searchInput.removeAttribute("aria-activedescendant");
    }
  }

  /** The title with the part that matched in front and the rest dimmed. */
  function mark(option: HTMLElement, query: string): void {
    const label = option.querySelector<HTMLElement>("[data-title-text]");
    if (!label) return;
    const title = option.dataset.title ?? "";
    const at = query === "" ? -1 : title.toLowerCase().indexOf(query);
    label.replaceChildren();
    const piece = (text: string, dim: boolean): void => {
      if (text === "") return;
      if (!dim) {
        label.append(text);
        return;
      }
      const span = document.createElement("span");
      span.className = "dim";
      span.textContent = text;
      label.append(span);
    };
    if (at < 0) {
      label.append(title);
      return;
    }
    piece(title.slice(0, at), true);
    piece(title.slice(at, at + query.length), false);
    piece(title.slice(at + query.length), true);
  }

  function filter(): void {
    const query = searchInput.value.trim().toLowerCase();
    visible = [];
    for (const group of groups) {
      const options = optionsOf(group);
      const suggested = group.dataset.searchGroup === "suggested";
      let shown: HTMLAnchorElement[];
      if (suggested) {
        shown = query === "" ? options : [];
      } else if (query === "") {
        shown = [];
      } else {
        const order = rankMatches(
          query,
          options.map((option) => ({
            title: option.dataset.title ?? "",
            haystack: option.dataset.haystack ?? "",
          })),
        ).slice(0, PER_GROUP);
        shown = order.flatMap((i) => options[i] ?? []);
        group.append(...shown, ...options.filter((o) => !shown.includes(o)));
      }
      for (const option of options) {
        option.hidden = !shown.includes(option);
        mark(option, query);
      }
      group.hidden = shown.length === 0;
      visible.push(...shown);
    }
    noMatch.hidden = visible.length > 0;
    select(0);
  }

  function show(): void {
    searchInput.value = "";
    filter();
    openDialog(searchDialog);
    searchInput.focus();
  }

  document.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() !== "k") return;
    if (event.altKey || event.shiftKey) return;
    const chord = apple
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    if (!chord) return;
    event.preventDefault();
    if (searchDialog.open) searchDialog.close();
    else show();
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest("[data-command-search-open]")) return;
    event.preventDefault();
    if (!searchDialog.open) show();
  });

  searchInput.addEventListener("input", filter);

  searchDialog.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      select(
        stepIndex(selected, event.key === "ArrowDown" ? 1 : -1, visible.length),
      );
    } else if (event.key === "Enter") {
      const current = visible[selected];
      if (!current) return;
      event.preventDefault();
      current.click();
    }
  });

  searchDialog.addEventListener("mousemove", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const option = target.closest<HTMLAnchorElement>("[role=option]");
    const index = option ? visible.indexOf(option) : -1;
    if (index >= 0 && index !== selected) select(index);
  });

  filter();
}
