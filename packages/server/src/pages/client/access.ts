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
  dataSummary,
  levelOfValue,
  powersSummary,
  profileSummary,
  type Level,
  type LevelPick,
} from "../access-summary.js";

const asLevel = (value: string | undefined): Level =>
  value === "read" || value === "write" ? value : "none";

function picksIn(group: HTMLElement): LevelPick[] {
  return [
    ...group.querySelectorAll<HTMLSelectElement>("select[data-noun]"),
  ].map((select) => {
    const held = asLevel(select.dataset.held);
    return {
      noun: select.dataset.noun ?? "",
      held,
      level: levelOfValue(select.value, held),
    };
  });
}

const switchesIn = (group: HTMLElement): HTMLInputElement[] => [
  ...group.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
];

function summaryOf(group: HTMLElement): string | undefined {
  const empty = group.dataset.accessEmpty ?? "";
  switch (group.dataset.accessGroup) {
    case "data":
      return dataSummary(picksIn(group), empty);
    case "profile":
      return profileSummary(
        picksIn(group),
        switchesIn(group)
          .filter((box) => box.checked)
          .map((box) => box.dataset.phrase ?? ""),
        empty,
      );
    case "powers": {
      const boxes = switchesIn(group);
      return powersSummary(
        boxes.filter((box) => box.checked).length,
        boxes.length,
      );
    }
    default:
      return undefined;
  }
}

function somethingIsOn(form: HTMLFormElement): boolean {
  const raised = [
    ...form.querySelectorAll<HTMLSelectElement>("select[data-noun]"),
  ].some((select) => {
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

function update(form: HTMLFormElement): void {
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
    const sync = (): void => {
      update(form);
    };
    sync();
    form.addEventListener("change", sync);
    // A page restored from the back-forward cache keeps the controls as they
    // were left, which the lines must follow.
    window.addEventListener("pageshow", sync);
  }
}
