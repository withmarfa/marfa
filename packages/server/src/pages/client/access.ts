/**
 * Keeps an approval page's lines true as the person changes a control.
 *
 * Each row that opens (`data-access-group`) says in a line what the controls
 * beneath it give. The server renders the line for the choice the controls
 * start at; this module writes it again, with the same wording functions the
 * server calls, whenever a control changes. It also hides "If everything is
 * off, approving denies the request." while something is on. The page works in
 * full without it: the server shows that line to a browser that runs no
 * script, and the form posts the same.
 */
import {
  addsAccess,
  CHOOSE_TYPES,
  dataSummary,
  LEVEL_RANK,
  levelOfValue,
  MANY_TYPES,
  powersSummary,
  profileSummary,
  SHOWN_TYPES,
  type Level,
  type LevelPick,
  type Nameable,
} from "../access-summary.js";
import { extensionFollowing } from "../key-body.js";

const asLevel = (value: string | undefined): Level =>
  value === "read" || value === "write" ? value : "none";

/** Whether the person chose types in place of all data. */
const choosingTypes = (root: ParentNode): boolean =>
  root.querySelector<HTMLSelectElement>("select[data-all]")?.value ===
  CHOOSE_TYPES;

/**
 * The level controls that decide what is granted: the type controls while
 * types are chosen, and otherwise every control but those, whose values the
 * server ignores.
 */
function levelSelects(root: ParentNode): HTMLSelectElement[] {
  const choosing = choosingTypes(root);
  return [
    ...root.querySelectorAll<HTMLSelectElement>("select[data-noun]"),
  ].filter((select) =>
    select.dataset.all !== undefined
      ? !choosing
      : !select.closest("[data-choose-types]") || choosing,
  );
}

function picksIn(group: HTMLElement): LevelPick[] {
  return levelSelects(group).map((select) => {
    const held = asLevel(select.dataset.held);
    return {
      noun: select.dataset.noun ?? "",
      alias: select.dataset.alias,
      held,
      level: levelOfValue(select.value, held),
      type: select.closest("[data-choose-types]") !== null,
    };
  });
}

const extensionSelect = (root: ParentNode): HTMLSelectElement | null =>
  root.querySelector<HTMLSelectElement>("select[data-ext-noun]");

/**
 * Integration data on every namespace, which Create key sets apart from the
 * data controls and the line under "Your data" still names.
 */
function extensionPicks(root: ParentNode): LevelPick[] {
  const select = extensionSelect(root);
  return select
    ? [
        {
          noun: select.dataset.extNoun ?? "",
          held: "none",
          level: asLevel(select.value),
        },
      ]
    : [];
}

/** What the app holds, which the lines name a type beside. */
const heldIn = (group: HTMLElement): Nameable[] =>
  [
    ...(group.closest("form") ?? group).querySelectorAll<HTMLElement>(
      "[data-held-pick]",
    ),
  ].map((pick) => ({
    noun: pick.dataset.noun ?? "",
    alias: pick.dataset.alias,
  }));

const switchesIn = (group: HTMLElement): HTMLInputElement[] => [
  ...group.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
];

function summaryOf(group: HTMLElement): string | undefined {
  const empty = group.dataset.accessEmpty ?? "";
  switch (group.dataset.accessGroup) {
    case "data": {
      const total = Number(
        group.querySelector<HTMLElement>("[data-choose-types]")?.dataset.total,
      );
      return dataSummary(
        [...picksIn(group), ...extensionPicks(group.closest("form") ?? group)],
        empty,
        choosingTypes(group) && total > 0 ? total : undefined,
        heldIn(group),
      );
    }
    case "profile":
      return profileSummary(
        picksIn(group),
        switchesIn(group)
          .filter((box) => box.checked)
          .map((box) => box.dataset.phrase ?? ""),
        empty,
        heldIn(group),
      );
    case "powers": {
      const boxes = switchesIn(group);
      return powersSummary(
        boxes.filter((box) => box.checked).length,
        boxes.length,
        "accessCounted" in group.dataset,
      );
    }
    default:
      return undefined;
  }
}

function somethingIsOn(form: HTMLFormElement): boolean {
  const raised = levelSelects(form).some((select) => {
    const held = asLevel(select.dataset.held);
    return addsAccess(levelOfValue(select.value, held), held);
  });
  return (
    raised ||
    [
      ...form.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"][name="scopes"]',
      ),
    ].some((box) => box.checked)
  );
}

/** The highest level a type control offers that is no higher than `target`. */
function setEvery(form: HTMLFormElement, target: Level): void {
  for (const select of form.querySelectorAll<HTMLSelectElement>(
    "[data-choose-types] select[data-noun]",
  )) {
    const held = asLevel(select.dataset.held);
    let best: HTMLOptionElement | undefined;
    for (const option of select.options) {
      const level = levelOfValue(option.value, held);
      const bestLevel = best ? levelOfValue(best.value, held) : undefined;
      const fits = LEVEL_RANK[level] <= LEVEL_RANK[target];
      if (
        bestLevel === undefined ||
        (fits &&
          (LEVEL_RANK[bestLevel] > LEVEL_RANK[target] ||
            LEVEL_RANK[level] > LEVEL_RANK[bestLevel])) ||
        (!fits &&
          LEVEL_RANK[bestLevel] > LEVEL_RANK[target] &&
          LEVEL_RANK[level] < LEVEL_RANK[bestLevel])
      )
        best = option;
    }
    if (best) select.value = best.value;
  }
}

/**
 * Shows the type list while types are chosen and, for a long one, the search,
 * "Set every type" and "Show all": all start hidden because they do nothing
 * without this script.
 */
function showTypes(form: HTMLFormElement, expanded: { all: boolean }): void {
  const list = form.querySelector<HTMLElement>("[data-choose-types]");
  if (!list) return;
  list.hidden = !choosingTypes(form);
  for (const note of list.querySelectorAll<HTMLElement>(
    "[data-no-script-note]",
  ))
    note.hidden = true;
  const rows = [...list.querySelectorAll<HTMLElement>("[data-type-row]")];
  const many = rows.length > MANY_TYPES;
  for (const row of list.querySelectorAll<HTMLElement>("[data-script-only]"))
    row.hidden = !many;
  if (!many) return;
  const query = (
    list.querySelector<HTMLInputElement>('input[type="search"]')?.value ?? ""
  )
    .trim()
    .toLowerCase();
  const matches = rows.filter(
    (row) => query === "" || (row.dataset.search ?? "").includes(query),
  );
  const collapsed = !expanded.all && query === "";
  rows.forEach((row) => {
    const at = matches.indexOf(row);
    row.hidden = at < 0 || (collapsed && at >= SHOWN_TYPES);
  });
  const none = list.querySelector<HTMLElement>("[data-types-none]");
  if (none) none.hidden = matches.length > 0;
  const more = list.querySelector<HTMLElement>("[data-types-more]");
  if (more) more.hidden = !(collapsed && matches.length > SHOWN_TYPES);
}

function update(form: HTMLFormElement, extensionChosen: boolean): void {
  const extensions = extensionSelect(form);
  if (extensions && !extensionChosen) {
    const all = form.querySelector<HTMLSelectElement>("select[data-all]");
    extensions.value = extensionFollowing(all ? [all.value] : []);
  }
  for (const group of form.querySelectorAll<HTMLElement>(
    "[data-access-group]",
  )) {
    const line = group.querySelector<HTMLElement>("[data-summary]");
    const text = summaryOf(group);
    if (line && text !== undefined) line.textContent = text;
  }
  for (const note of form.querySelectorAll<HTMLElement>(
    "[data-access-nothing]",
  ))
    note.hidden = somethingIsOn(form);
}

export function initAccess(): void {
  for (const form of document.querySelectorAll<HTMLFormElement>(
    "form[data-access]",
  )) {
    const expanded = { all: false };
    // Integration data follows all data until the person sets it.
    let extensionChosen = false;
    const sync = (): void => {
      showTypes(form, expanded);
      update(form, extensionChosen);
    };
    sync();
    form.addEventListener("change", (event) => {
      const target = event.target;
      if (
        target instanceof HTMLSelectElement &&
        target === extensionSelect(form)
      )
        extensionChosen = true;
      if (target instanceof HTMLSelectElement && "setEvery" in target.dataset) {
        const level = target.value;
        if (level === "write" || level === "read" || level === "none")
          setEvery(form, level);
        target.value = "";
      }
      sync();
    });
    form
      .querySelector('[data-choose-types] input[type="search"]')
      ?.addEventListener("input", sync);
    // Enter in the search field would send the form by its first button,
    // which cancels.
    form
      .querySelector('[data-choose-types] input[type="search"]')
      ?.addEventListener("keydown", (event) => {
        if ((event as KeyboardEvent).key === "Enter") event.preventDefault();
      });
    form.querySelector("[data-types-more]")?.addEventListener("click", () => {
      expanded.all = true;
      sync();
    });
    // A page restored from the back-forward cache keeps the controls as they
    // were left, which the lines must follow.
    window.addEventListener("pageshow", sync);
  }
}
