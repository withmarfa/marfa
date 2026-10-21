/**
 * The command search: a field and grouped one-line results over every page
 * and setting, opened from anywhere with Command-K, or Control-K where the
 * platform is not Apple's.
 *
 * The server writes the pages into the dialog and this module only filters
 * them as the person types, so no search runs on the server and a page that
 * has no script still carries the links. The settings are too many to send
 * with every page: the first time the dialog opens, this module reads them
 * from the owner-only answer named in `data-settings-source`.
 */
import { rankMatches, stepIndex } from "../navigation.js";
import { firstSentence, groupSlug } from "../settings-links.js";
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
  const status = dialog?.querySelector<HTMLElement>("[data-search-status]");
  if (!dialog || !input || !none || !status) return;
  const searchDialog = dialog;
  const searchInput = input;
  const noMatch = none;
  const settingsStatus = status;
  const apple = isApplePlatform();

  for (const hint of document.querySelectorAll<HTMLElement>(
    "[data-shortcut-hint]",
  )) {
    hint.textContent = apple ? "⌘K" : "Ctrl K";
    hint.hidden = false;
  }
  for (const trigger of document.querySelectorAll<HTMLElement>(
    "[data-command-search-open]",
  ))
    trigger.hidden = false;

  const groups = [
    ...searchDialog.querySelectorAll<HTMLElement>("[data-search-group]"),
  ];
  const optionsOf = (group: HTMLElement): HTMLAnchorElement[] => [
    ...group.querySelectorAll<HTMLAnchorElement>("[role=option]"),
  ];
  let visible: HTMLAnchorElement[] = [];
  let selected = 0;
  let settingsState: "waiting" | "loading" | "loaded" | "failed" = "waiting";

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
    const pending = settingsState === "loading" || settingsState === "failed";
    settingsStatus.hidden = !pending;
    settingsStatus.textContent =
      settingsState === "loading"
        ? "Loading settings…"
        : "Settings could not be loaded.";
    noMatch.hidden = visible.length > 0 || pending;
    select(0);
  }

  /** The settings group's options, made from the settings answer with text set as text. */
  function addSettings(source: string, entries: unknown): void {
    if (!Array.isArray(entries)) throw new Error("not a list");
    const group = searchDialog.querySelector<HTMLElement>(
      "[data-search-group=settings]",
    );
    if (!group) return;
    const base = source.replace(/\.json$/, "");
    const options: HTMLAnchorElement[] = [];
    for (const entry of entries as Record<string, unknown>[]) {
      const { name, label, group: kind, description } = entry;
      if (
        typeof name !== "string" ||
        typeof label !== "string" ||
        typeof kind !== "string" ||
        typeof description !== "string"
      )
        throw new Error("not a setting");
      const option = document.createElement("a");
      option.className = "pal-row";
      option.setAttribute("role", "option");
      option.id = `cs-setting-${name}`;
      option.href = `${base}/${groupSlug(kind)}#${name}`;
      option.tabIndex = -1;
      option.setAttribute("aria-selected", "false");
      option.dataset.title = label;
      option.dataset.haystack = `${label} ${firstSentence(description)} ${name} ${kind}`;
      option.hidden = true;
      const title = document.createElement("span");
      title.className = "grow";
      title.dataset.titleText = "";
      title.textContent = label;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = kind;
      option.append(title, meta);
      options.push(option);
    }
    group.append(...options);
  }

  async function loadSettings(): Promise<void> {
    const source = searchDialog.dataset.settingsSource;
    if (source === undefined) return;
    if (settingsState === "loaded" || settingsState === "loading") return;
    settingsState = "loading";
    filter();
    try {
      const response = await fetch(source, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { data?: unknown };
      addSettings(source, body.data);
      settingsState = "loaded";
    } catch {
      settingsState = "failed";
    }
    filter();
  }

  function show(): void {
    searchInput.value = "";
    filter();
    openDialog(searchDialog);
    searchInput.focus();
    void loadSettings();
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
