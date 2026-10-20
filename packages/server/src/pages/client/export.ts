/**
 * The Export and restore page.
 *
 * Export is a plain form: the browser downloads the archive from `GET /export`
 * itself. All this module adds is what a form cannot say: the Include files
 * switch, because an off switch sends nothing, and "Everything", which is no
 * `type` at all and not an empty one.
 *
 * Restore sends the chosen file to `POST /restore`. The upload can be large,
 * so the person is asked to confirm it's them first when the sign-in has run
 * out, not after the server has refused the body.
 */
import { restoreSummary, type RestoreCounts } from "../restore-words.js";
import { SETUP_WORDS } from "../setup-words.js";
import { messageOf, sendConfirmed, signInAgain, type Gate } from "./confirm.js";
import { hideNotices, showNotice } from "./notice.js";
import { busy, hook } from "./page-state.js";

const NO_FILE = "No file chosen";

function initExportForm(form: HTMLFormElement): void {
  const files = form.querySelector<HTMLInputElement>("#export-files");
  if (!files) return;
  form.addEventListener("formdata", (event) => {
    if (event.formData.get("type") === "") event.formData.delete("type");
    if (!files.checked) event.formData.set("files", "false");
  });
}

const isCounts = (body: unknown): body is RestoreCounts =>
  typeof body === "object" &&
  body !== null &&
  "imported" in body &&
  "blobs_missing" in body &&
  "edges_skipped" in body;

async function restore(
  root: HTMLElement,
  file: File,
  button: HTMLButtonElement,
): Promise<void> {
  hideNotices(root);
  busy(button, true);
  button.setAttribute("aria-disabled", "true");
  const left = Number(root.dataset.confirmLeft);
  const gate: Gate | undefined = Number.isFinite(left)
    ? { left, rendered: Date.now() }
    : undefined;
  let leaving = false;
  try {
    const response = await sendConfirmed(
      () =>
        fetch("/restore", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/gzip" },
          body: file,
        }),
      root.dataset.confirmWhy ?? "Confirm it's you.",
      button,
      gate,
    );
    if (response === null) return;
    if (response.status === 401) {
      signInAgain();
      leaving = true;
      return;
    }
    if (!response.ok) {
      showNotice(
        root,
        "restore-problem",
        (await messageOf(response)) || SETUP_WORDS.somethingWrong,
      );
      return;
    }
    const body: unknown = await response.json();
    showNotice(
      root,
      "restored",
      isCounts(body) ? restoreSummary(body) : "The archive was added.",
    );
  } catch {
    showNotice(
      root,
      "restore-unknown",
      "Marfa didn't answer, so it isn't known whether the restore finished. Check your items before trying again.",
    );
  } finally {
    busy(button, false);
    if (!leaving) button.removeAttribute("aria-disabled");
  }
}

function initRestore(root: HTMLElement): void {
  const input = root.querySelector<HTMLInputElement>("[data-restore-input]");
  const choose = hook(root, "restore-choose");
  const send = hook(root, "restore-send");
  const name = root.querySelector<HTMLElement>('[data-restore="file"] .val');
  const reason = root.querySelector<HTMLElement>("[data-restore-reason]");
  if (!input || !choose || !send) return;
  choose.addEventListener("click", () => {
    input.click();
  });
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (name) name.textContent = file?.name ?? NO_FILE;
    if (reason) reason.hidden = file !== undefined;
    if (file) send.removeAttribute("aria-disabled");
    else send.setAttribute("aria-disabled", "true");
    hideNotices(root);
  });
  send.addEventListener("click", () => {
    const file = input.files?.[0];
    if (!file || send.getAttribute("aria-disabled") === "true") return;
    void restore(root, file, send);
  });
}

export function initExport(): void {
  const form = document.querySelector<HTMLFormElement>(
    "form[data-export-form]",
  );
  if (form) initExportForm(form);
  const restoreRoot = document.querySelector<HTMLElement>("[data-restore]");
  if (restoreRoot) initRestore(restoreRoot);
}
