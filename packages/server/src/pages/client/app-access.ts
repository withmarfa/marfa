import { literalsOf } from "./keys.js";
import { sendConfirmed, signInAgain } from "./confirm.js";
import { hideNotices, showNotice } from "./notice.js";
import { busy, keepFlash, refusalText, showFlash } from "./page-state.js";
import { initSaveBar } from "./save-bar.js";
import { SETUP_WORDS } from "../setup-words.js";

export function initAppAccess(): void {
  const form = document.querySelector<HTMLFormElement>("form[data-app-access]");
  if (!form) return;
  const bar = initSaveBar(form);
  if (!bar) return;
  showFlash("marfa-app-access-flash");
  form.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (form.dataset.sending === "1" || bar.count() === 0) return;
      const scopes = [
        ...literalsOf(form),
        ...[
          ...form.querySelectorAll<HTMLInputElement>(
            "input[type=hidden][name=scopes]",
          ),
        ].map((input) => input.value),
      ];
      const body = JSON.stringify({
        scopes,
        expected_scopes: JSON.parse(
          form.dataset.loadedScopes ?? "[]",
        ) as string[],
      });
      form.dataset.sending = "1";
      busy(bar.save, true);
      hideNotices(form);
      void (async () => {
        try {
          const response = await sendConfirmed(
            () =>
              fetch(
                `/auth/grants/${encodeURIComponent(form.dataset.appId ?? "")}`,
                {
                  method: "PATCH",
                  credentials: "same-origin",
                  headers: {
                    "content-type": "application/json",
                    accept: "application/json",
                  },
                  body,
                },
              ),
            form.dataset.confirmWhy ?? "Confirm it's you.",
            bar.save,
          );
          if (!response) return;
          if (response.ok) {
            bar.saved();
            keepFlash("marfa-app-access-flash", "Saved");
            location.reload();
          } else if (response.status === 401) signInAgain();
          else showNotice(form, "problem", await refusalText(response));
        } catch {
          showNotice(form, "problem", SETUP_WORDS.network);
        } finally {
          delete form.dataset.sending;
          busy(bar.save, false);
        }
      })();
    },
    true,
  );
}
