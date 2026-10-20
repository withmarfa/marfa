/**
 * The Health page: Run now for a housekeeping job.
 *
 * The page is read-only apart from this. A run goes through
 * `POST /housekeeping/{name}/run`, which answers once the run has finished,
 * and the page reloads to show how it ended.
 */
import { SETUP_WORDS } from "../setup-words.js";
import { signInAgain } from "./confirm.js";
import { hideNotices, showNotice } from "./notice.js";
import { busy, keepFlash, refusalText, showFlash } from "./page-state.js";

const FLASH = "marfa-health-flash";

interface Run {
  outcome?: unknown;
}

async function runJob(button: HTMLButtonElement): Promise<void> {
  const name = button.dataset.job ?? "";
  const label = button.dataset.label ?? "The job";
  if (button.getAttribute("aria-busy") === "true") return;
  hideNotices(document, ["problem"]);
  busy(button, true);
  let leaving = false;
  try {
    const response = await fetch(
      `/housekeeping/${encodeURIComponent(name)}/run`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      },
    );
    if (response.ok) {
      const run = (await response.json().catch(() => ({}))) as Run;
      keepFlash(
        FLASH,
        run.outcome === "error" ? `${label} failed` : `Ran ${label}`,
      );
      leaving = true;
      location.reload();
      return;
    }
    if (response.status === 401) {
      signInAgain();
      leaving = true;
      return;
    }
    showNotice(
      document,
      "problem",
      response.status === 409
        ? `${label} is already running. Try again when it finishes.`
        : response.status === 404
          ? `Marfa doesn't run ${label} any more.`
          : await refusalText(response),
    );
  } catch {
    showNotice(document, "problem", SETUP_WORDS.network);
  } finally {
    if (!leaving) busy(button, false);
  }
}

export function initHealth(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>(
    '[data-health] [data-hook="run-job"]',
  );
  if (buttons.length === 0) return;
  showFlash(FLASH);
  for (const button of buttons)
    button.addEventListener("click", () => {
      void runJob(button);
    });
}
