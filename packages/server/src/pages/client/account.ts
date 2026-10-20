/**
 * The owner's own account pages: Profile, and Password and passkeys.
 *
 * A change is a form in a dialog, marked `data-account-form` with what it
 * does. The browser checks the value by the rules the server holds it to
 * (`account-input.ts`), sends it to the door that already makes the change,
 * and says what came back under the field it belongs to. A change that needs a
 * recent sign-in goes through `sendConfirmed`, which asks the person to
 * confirm it's them and sends the change once more.
 *
 * What a change touched is drawn by the server. The region marked `data-live`
 * is read again from the page's own address and swapped in, so the browser
 * never rebuilds a row itself.
 */
import {
  ACCOUNT_WORDS,
  emailProblem,
  nameProblem,
  newPasswordProblem,
} from "../account-input.js";
import { parseWaitSeconds, waitInMinutes } from "../lockout.js";
import { CONFIRM_REFUSALS } from "../recent-sign-in.js";
import { SETUP_WORDS } from "../setup-words.js";
import {
  CONFIRM_WORDS,
  codeOf,
  messageOf,
  sendConfirmed,
  signInAgain,
} from "./confirm.js";
import { openDialog } from "./dialog.js";
import { clearFieldError, showFieldError, type Control } from "./form.js";
import { localizeDates } from "./local-date.js";
import { hideNotices, showNotice } from "./notice.js";
import { passkeysSupported, registerPasskey } from "./passkey.js";

/** The code `DELETE /owner/passkeys/{id}` answers with for an ID the owner has no passkey under. */
const PASSKEY_NOT_FOUND = "passkey_not_found";

const JSON_HEADERS = {
  "content-type": "application/json",
  accept: "application/json",
};

/** What came of a change. */
type Outcome =
  /** The server holds the change. */
  | { kind: "done"; message: string }
  /** Nothing to say: the person cancelled, or the page is leaving. */
  | { kind: "stay" }
  /** Something to put right, under `control` or, without one, in the dialog. */
  | { kind: "problem"; control: Control | null; text: string };

interface Problem {
  control: Control;
  text: string;
}

interface FormKind {
  /** Why the value cannot be sent, found before anything is. */
  check: (form: HTMLFormElement) => Problem | undefined;
  send: (form: HTMLFormElement, opener: Element | null) => Promise<Outcome>;
}

function control(form: HTMLFormElement, name: string): HTMLInputElement {
  const found = form.elements.namedItem(name);
  if (!(found instanceof HTMLInputElement))
    throw new Error(`The form has no ${name} field`);
  return found;
}

/** What a refused change says, with a lost sign-in sent to sign in. */
async function refusal(
  response: Response,
  field: Control | null,
  invalid?: string,
): Promise<Outcome> {
  if (response.status === 401) {
    signInAgain();
    return { kind: "stay" };
  }
  return {
    kind: "problem",
    control: field,
    text:
      response.status === 400 && invalid !== undefined
        ? invalid
        : response.status === 400 || response.status === 404
          ? (await messageOf(response)) || SETUP_WORDS.somethingWrong
          : SETUP_WORDS.somethingWrong,
  };
}

function ownerChange(
  field: "name" | "email",
  done: string,
  invalid: string,
): FormKind["send"] {
  const why = `To change your ${field}, confirm it's you.`;
  return async (form, opener) => {
    const input = control(form, field);
    const value = input.value.trim();
    const response = await sendConfirmed(
      () =>
        fetch("/owner", {
          method: "PATCH",
          credentials: "same-origin",
          headers: JSON_HEADERS,
          body: JSON.stringify({ [field]: value }),
        }),
      why,
      opener,
    );
    if (response === null) return { kind: "stay" };
    if (response.ok) return { kind: "done", message: done };
    return refusal(response, input, invalid);
  };
}

async function changePassword(form: HTMLFormElement): Promise<Outcome> {
  const current = control(form, "currentPassword");
  const next = control(form, "newPassword");
  const response = await fetch("/auth/change-password", {
    method: "POST",
    credentials: "same-origin",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      currentPassword: current.value,
      newPassword: next.value,
    }),
  });
  if (response.ok)
    return {
      kind: "done",
      message: "Password changed. Your other browsers are signed out.",
    };
  if (response.status === 429) {
    const wait = parseWaitSeconds(response.headers.get("retry-after"));
    return {
      kind: "problem",
      control: current,
      text:
        wait === undefined
          ? "Too many attempts. Try again later."
          : `Too many attempts. Try again in ${waitInMinutes(wait)}.`,
    };
  }
  if (response.status === 401) {
    if ((await messageOf(response)) === CONFIRM_REFUSALS.noSession) {
      signInAgain();
      return { kind: "stay" };
    }
    return {
      kind: "problem",
      control: current,
      text: CONFIRM_WORDS.wrongPassword,
    };
  }
  if (response.status === 400)
    return {
      kind: "problem",
      control: next,
      text: ACCOUNT_WORDS.newPasswordLength,
    };
  return {
    kind: "problem",
    control: current,
    text: SETUP_WORDS.somethingWrong,
  };
}

async function addPasskey(form: HTMLFormElement): Promise<Outcome> {
  const input = control(form, "name");
  const result = await registerPasskey(input.value.trim());
  if (result.kind === "added")
    return { kind: "done", message: "Passkey added" };
  if (result.kind === "cancelled") return { kind: "stay" };
  return { kind: "problem", control: input, text: result.message };
}

function passkeyId(form: HTMLFormElement): string {
  return encodeURIComponent(form.dataset.passkeyId ?? "");
}

async function renamePasskey(
  form: HTMLFormElement,
  opener: Element | null,
): Promise<Outcome> {
  const input = control(form, "name");
  const name = input.value.trim();
  const response = await sendConfirmed(
    () =>
      fetch(`/owner/passkeys/${passkeyId(form)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: JSON_HEADERS,
        body: JSON.stringify({ name }),
      }),
    "To rename a passkey, confirm it's you.",
    opener,
  );
  if (response === null) return { kind: "stay" };
  if (response.ok) return { kind: "done", message: "Passkey renamed" };
  return refusal(response, input, ACCOUNT_WORDS.nameRefused);
}

async function removePasskey(
  form: HTMLFormElement,
  opener: Element | null,
): Promise<Outcome> {
  const response = await sendConfirmed(
    () =>
      fetch(`/owner/passkeys/${passkeyId(form)}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      }),
    "To remove a passkey, confirm it's you.",
    opener,
  );
  if (response === null) return { kind: "stay" };
  if (response.ok) return { kind: "done", message: "Passkey removed" };
  // A passkey that is already gone is the state the person asked for. Another
  // 404, such as an owner who cannot be found, is not that.
  if (
    response.status === 404 &&
    (await codeOf(response.clone())) === PASSKEY_NOT_FOUND
  )
    return { kind: "done", message: "Passkey removed" };
  return refusal(response, null);
}

const FORMS: Readonly<Record<string, FormKind>> = {
  name: {
    check: (form) => {
      const input = control(form, "name");
      const text = nameProblem(input.value);
      return text === undefined ? undefined : { control: input, text };
    },
    send: ownerChange("name", "Name changed", ACCOUNT_WORDS.nameRefused),
  },
  email: {
    check: (form) => {
      const input = control(form, "email");
      const text = emailProblem(input.value);
      return text === undefined ? undefined : { control: input, text };
    },
    send: ownerChange("email", "Email changed", ACCOUNT_WORDS.emailShape),
  },
  password: {
    check: (form) => {
      const current = control(form, "currentPassword");
      const next = control(form, "newPassword");
      const first: Problem[] = [];
      if (current.value === "")
        first.push({
          control: current,
          text: ACCOUNT_WORDS.enterCurrentPassword,
        });
      const length = newPasswordProblem(next.value);
      if (length !== undefined) first.push({ control: next, text: length });
      // Every problem is shown; the first one takes focus.
      for (const problem of first.slice(1))
        showFieldError(problem.control, problem.text);
      return first[0];
    },
    send: (form) => changePassword(form),
  },
  "passkey-add": {
    check: (form) => {
      const input = control(form, "name");
      const text = nameProblem(input.value, ACCOUNT_WORDS.enterPasskeyName);
      return text === undefined ? undefined : { control: input, text };
    },
    send: (form) => addPasskey(form),
  },
  "passkey-rename": {
    check: (form) => {
      const input = control(form, "name");
      const text = nameProblem(input.value, ACCOUNT_WORDS.enterPasskeyName);
      return text === undefined ? undefined : { control: input, text };
    },
    send: renamePasskey,
  },
  "passkey-remove": {
    check: () => undefined,
    send: removePasskey,
  },
};

function dialogOf(form: HTMLFormElement): HTMLDialogElement | null {
  return form.closest("dialog");
}

function clearProblems(form: HTMLFormElement): void {
  for (const input of form.querySelectorAll<Control>("input"))
    clearFieldError(input);
  hideNotices(form);
}

function setBusy(
  form: HTMLFormElement,
  busy: boolean,
  submitter: Element | null,
): void {
  const dialog = dialogOf(form);
  if (busy) form.dataset.busy = "1";
  else delete form.dataset.busy;
  dialog?.querySelector(".card")?.setAttribute("aria-busy", String(busy));
  for (const button of dialog?.querySelectorAll<HTMLButtonElement>(
    ".pair button",
  ) ?? [])
    button.disabled = busy;
  if (!(submitter instanceof HTMLButtonElement)) return;
  submitter.classList.toggle("is-loading", busy);
  if (busy) {
    submitter.dataset.idleLabel ??= submitter.textContent;
    submitter.textContent =
      submitter.getAttribute("data-loading-label") ?? "Working...";
  } else if (submitter.dataset.idleLabel !== undefined) {
    submitter.textContent = submitter.dataset.idleLabel;
    delete submitter.dataset.idleLabel;
  }
}

/** Read the page again and swap in the region the server draws. */
async function refresh(): Promise<boolean> {
  const live = document.querySelector("[data-live]");
  if (!live) return false;
  try {
    const response = await fetch(location.pathname, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "text/html" },
    });
    if (!response.ok) return false;
    const next = new DOMParser()
      .parseFromString(await response.text(), "text/html")
      .querySelector("[data-live]");
    if (!next) return false;
    live.replaceChildren(
      ...Array.from(next.childNodes, (node) => document.importNode(node, true)),
    );
    localizeDates(live);
    return true;
  } catch {
    return false;
  }
}

function focusHook(hook: string | undefined): void {
  if (hook === undefined) return;
  document
    .querySelector<HTMLElement>(`[data-hook="${CSS.escape(hook)}"]`)
    ?.focus();
}

function closeDialogs(form: HTMLFormElement): void {
  dialogOf(form)?.close();
  for (const dialog of document.querySelectorAll<HTMLDialogElement>(
    "[data-live] dialog[open]",
  ))
    dialog.close();
}

async function submit(event: SubmitEvent): Promise<void> {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const kind = FORMS[form.dataset.accountForm ?? ""];
  if (!kind) return;
  event.preventDefault();
  if (form.dataset.busy !== undefined) return;
  clearProblems(form);
  const problem = kind.check(form);
  if (problem) {
    showFieldError(problem.control, problem.text);
    problem.control.focus();
    return;
  }
  const submitter = event.submitter;
  setBusy(form, true, submitter);
  let outcome: Outcome;
  try {
    outcome = await kind.send(form, submitter);
  } catch {
    outcome = {
      kind: "problem",
      control: form.querySelector<Control>("input:not([type=hidden])"),
      text: SETUP_WORDS.network,
    };
  } finally {
    setBusy(form, false, submitter);
  }
  if (outcome.kind === "stay") return;
  if (outcome.kind === "problem") {
    if (outcome.control) {
      showFieldError(outcome.control, outcome.text);
      outcome.control.focus();
    } else showNotice(form, "error", outcome.text);
    return;
  }
  const after = form.dataset.after;
  closeDialogs(form);
  if (form.hasAttribute("data-refresh") && !(await refresh())) {
    location.reload();
    return;
  }
  for (const wrap of document.querySelectorAll<HTMLElement>(
    '[data-notice="done"]',
  ))
    wrap.hidden = true;
  showNotice(document, "done", outcome.message);
  focusHook(after);
}

/** A dialog that closes goes back to how the server drew it. */
function reset(dialog: HTMLDialogElement): void {
  for (const form of dialog.querySelectorAll<HTMLFormElement>(
    "form[data-account-form]",
  )) {
    form.reset();
    clearProblems(form);
    for (const input of form.querySelectorAll<HTMLInputElement>(
      '[data-password] input[type="text"], [data-password] input[type="password"]',
    )) {
      if (input.type === "text")
        input
          .closest("[data-password]")
          ?.querySelector<HTMLButtonElement>("[data-password-toggle]")
          ?.click();
      input.dispatchEvent(new Event("input"));
    }
  }
}

export function initAccount(): void {
  if (!document.querySelector("form[data-account-form], [data-account-add]"))
    return;
  document.addEventListener("submit", (event) => {
    void submit(event);
  });
  document.addEventListener(
    "close",
    (event) => {
      if (event.target instanceof HTMLDialogElement) reset(event.target);
    },
    true,
  );
  // Where the server says a passkey cannot work at this address, Add stays
  // hidden: the notice already says why.
  if (document.querySelector('[data-notice="unsupported"]:not([hidden])'))
    return;
  for (const add of document.querySelectorAll<HTMLElement>(
    "[data-account-add]",
  )) {
    add.hidden = false;
    add.addEventListener("click", () => {
      const dialog = document.getElementById(add.dataset.accountAdd ?? "");
      if (passkeysSupported() && dialog instanceof HTMLDialogElement) {
        hideNotices(document, ["done", "error"]);
        openDialog(dialog, add);
        return;
      }
      const notice = showNotice(
        document,
        "unsupported",
      )?.querySelector<HTMLElement>(".notice");
      if (notice) {
        notice.tabIndex = -1;
        notice.focus();
      }
    });
  }
}
