/**
 * The claim in a page that is already open. The forms work without this: they
 * post to the server, which answers with the next page or the same one with
 * its refusal. With it, a refusal appears in place and a typed code stays, and
 * a setup link opened from the machine (`/setup#handoff=...`) is exchanged
 * without the person typing anything.
 */
import { clearFieldError, resetSubmitState, showFieldError } from "./form.js";
import type { Control } from "./form.js";
import { hideNotices, showNotice } from "./notice.js";
import { SETUP_WORDS, tooManyTries } from "../setup-words.js";

interface Answer {
  status: number;
  body: {
    error?: {
      code?: unknown;
      message?: unknown;
      details?: { retry_after?: unknown; errors?: unknown };
    };
  } | null;
}

/** `null` when the request never got an answer. */
async function post(path: string, data: unknown): Promise<Answer | null> {
  try {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(data),
    });
    return {
      status: response.status,
      body: (await response.json().catch(() => null)) as Answer["body"],
    };
  } catch {
    return null;
  }
}

const retryAfter = (answer: Answer): number | undefined => {
  const value = answer.body?.error?.details?.retry_after;
  return typeof value === "number" ? value : undefined;
};

const serverText = (answer: Answer): string => {
  const text = answer.body?.error?.message;
  return typeof text === "string" && text !== ""
    ? text
    : SETUP_WORDS.somethingWrong;
};

/** `#handoff=...` is read once and taken out of the address at once, so it is not kept in history or sent on. */
function takeHandoff(): string | null {
  if (location.pathname !== "/setup" || location.hash === "") return null;
  const ticket = new URLSearchParams(location.hash.slice(1)).get("handoff");
  history.replaceState(null, "", location.pathname + location.search);
  return ticket;
}

function control(form: HTMLFormElement, name: string): Control | null {
  const found = form.elements.namedItem(name);
  return found instanceof HTMLInputElement ? found : null;
}

function codeForm(form: HTMLFormElement): void {
  const code = control(form, "code");
  const refuse = (text: string, field: boolean): void => {
    if (field && code) {
      showFieldError(code, text);
      code.focus();
    } else showNotice(form, "error", text);
  };
  /** Moves on when the exchange is done or the instance is claimed; otherwise says why not. True when it moved on. */
  const react = (answer: Answer | null, link: boolean): boolean => {
    if (answer?.status === 200 || answer?.status === 409) {
      location.replace("/setup");
      return true;
    }
    if (answer === null) refuse(SETUP_WORDS.network, false);
    else if (answer.status === 401) {
      if (link) refuse(SETUP_WORDS.linkSpent, false);
      else refuse(SETUP_WORDS.wrongCode, true);
    } else if (answer.status === 429)
      refuse(tooManyTries(retryAfter(answer)), true);
    else if (answer.status === 400) refuse(SETUP_WORDS.noCode, true);
    else refuse(serverText(answer), false);
    return false;
  };

  form.addEventListener("submit", (event) => {
    if (event.defaultPrevented || !code) return;
    event.preventDefault();
    hideNotices(form);
    void post("/setup/exchange", { code: code.value }).then((answer) => {
      if (!react(answer, false)) resetSubmitState(form);
    });
  });

  const ticket = takeHandoff();
  if (ticket !== null)
    void post("/setup/exchange", { ticket }).then((answer) => {
      react(answer, true);
    });
}

function detailsForm(form: HTMLFormElement): void {
  const password = control(form, "password");
  const refused = (names: string[]): void => {
    for (const name of names) {
      const field = control(form, name);
      if (field) clearFieldError(field);
    }
  };
  form.addEventListener("submit", (event) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    hideNotices(form);
    refused(["email", "name", "password"]);
    const data = Object.fromEntries(new FormData(form)) as Record<
      string,
      string
    >;
    void post("/owner", data).then((answer) => {
      if (answer?.status === 201) {
        location.assign("/setup/passkey");
        return;
      }
      if (password) password.value = "";
      resetSubmitState(form);
      if (answer === null)
        return void showNotice(form, "error", SETUP_WORDS.network);
      if (answer.status === 409) {
        location.replace("/setup");
        return;
      }
      if (answer.status === 401) return void showNotice(form, "ended");
      if (answer.status === 429)
        return void showNotice(form, "error", tooManyTries(retryAfter(answer)));
      if (answer.status === 400) {
        const entries = answer.body?.error?.details?.errors;
        let first: Control | null = null;
        if (Array.isArray(entries))
          for (const entry of entries as {
            path?: unknown;
            message?: unknown;
          }[]) {
            if (
              typeof entry.path !== "string" ||
              typeof entry.message !== "string"
            )
              continue;
            const field = control(form, entry.path);
            if (!field) continue;
            showFieldError(field, entry.message);
            first ??= field;
          }
        if (first) {
          first.focus();
          return;
        }
      }
      showNotice(form, "error", serverText(answer));
    });
  });
}

export function initSetup(): void {
  const code = document.querySelector<HTMLFormElement>(
    'form[data-setup-form="code"]',
  );
  const details = document.querySelector<HTMLFormElement>(
    'form[data-setup-form="details"]',
  );
  if (code) codeForm(code);
  else takeHandoff();
  if (details) detailsForm(details);
}
