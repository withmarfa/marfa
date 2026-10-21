/**
 * The General page: the instance's name and how long it keeps things.
 *
 * The server draws the page and writes every word into the markup. This
 * module reads the controls that differ from what the page loaded and sends
 * only those through `PATCH /config`, so a setting someone else changed in
 * the meantime is not written back over.
 */
import { SETUP_WORDS } from "../setup-words.js";
import { signInAgain } from "./confirm.js";
import { hideNotices, showNotice } from "./notice.js";
import { busy, keepFlash, refusalText, showFlash } from "./page-state.js";
import { changedControls, initSaveBar, type SaveBar } from "./save-bar.js";

const FLASH = "marfa-general-flash";
const NAME_WORDS = "Give this Marfa a name.";

/** The settings that changed, under the names `PATCH /config` takes them by. */
export function changesOf(
  form: HTMLFormElement,
): Record<string, string | number | boolean | null> {
  const changes: Record<string, string | number | boolean | null> = {};
  for (const control of changedControls(form))
    changes[control.name] =
      control.name === "name"
        ? control.value.trim()
        : control.value === "default"
          ? null
          : control.value === "true"
            ? true
            : control.value === "false"
              ? false
              : Number(control.value);
  return changes;
}

async function submit(form: HTMLFormElement, bar: SaveBar): Promise<void> {
  if (form.dataset.sending === "1" || bar.count() === 0) return;
  hideNotices(form, ["problem"]);
  const changes = changesOf(form);
  if (changes.name === "") {
    showNotice(form, "problem", NAME_WORDS);
    return;
  }
  form.dataset.sending = "1";
  busy(bar.save, true);
  let leaving = false;
  try {
    const response = await fetch("/config", {
      method: "PATCH",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(changes),
    });
    if (response.ok) {
      keepFlash(FLASH, "Saved");
      leaving = true;
      bar.saved();
      location.reload();
      return;
    }
    if (response.status === 401) {
      signInAgain();
      leaving = true;
      return;
    }
    showNotice(form, "problem", await refusalText(response));
  } catch {
    showNotice(form, "problem", SETUP_WORDS.network);
  } finally {
    delete form.dataset.sending;
    if (!leaving) busy(bar.save, false);
  }
}

export function initGeneral(): void {
  const form = document.querySelector<HTMLFormElement>(
    "form[data-general-form]",
  );
  if (!form) return;
  showFlash(FLASH);
  const bar = initSaveBar(form);
  if (!bar) return;
  // Ahead of the page's own submit handling, which would validate and send a
  // plain form this one is not.
  form.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      void submit(form, bar);
    },
    true,
  );
}
