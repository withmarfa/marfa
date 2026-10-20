/**
 * Confirming it's you.
 *
 * A change that needs a sign-in from the last five minutes is refused to an
 * older browser with `403` and `SIGN_IN_AGAIN_MESSAGE`. A page sends the
 * change through {@link sendConfirmed}: on that refusal the "Confirm it's you"
 * dialog opens, the person answers with a passkey or the password, and the
 * same change is sent once more under the session `POST /auth/confirm` made.
 * If they cancel, nothing is sent again.
 *
 * An approval page posts a plain form, so it cannot be answered and sent
 * again. Its form carries how long the sign-in has left and which of its
 * scopes need a recent one, and its approve button opens the dialog first
 * when the person has chosen one of those after the time has run out.
 *
 * The dialog is in the page, or in a shadow root on a page with a stylesheet
 * of its own (`ConfirmDialogHost`). `window.marfaConfirm` lets such a page's
 * own script use the same flow.
 */
import { CONFIRM_REFUSALS, isSignInAgainRefusal } from "../recent-sign-in.js";
import { parseWaitSeconds, waitInMinutes } from "../lockout.js";
import { SETUP_WORDS } from "../setup-words.js";
import { clearFieldError, showFieldError } from "./form.js";

/**
 * How long before the sign-in stops being recent the dialog already opens. The
 * page counts from when it arrived, which is after the server drew it, so
 * without this a press in the last seconds would pass here and be refused there.
 */
const EARLY = 30_000;

const CONFIRM = "/auth/confirm";
const OPTIONS = "/auth/passkey/generate-authenticate-options";

const WORDS = {
  enterPassword: "Enter your password.",
  wrongPassword: "That password is wrong. Try again.",
  cancelled:
    "The passkey request was cancelled or timed out. You can try again.",
  somethingWrong: SETUP_WORDS.somethingWrong,
  network: SETUP_WORDS.network,
} as const;

export type Send = () => Promise<Response>;

export interface MarfaConfirm {
  /**
   * Send a change. If it is refused for an old sign-in, ask the person to
   * confirm and send it once more. Answers the response, or `null` when they
   * cancelled and nothing was sent again.
   */
  send: (
    send: Send,
    why: string,
    opener?: Element | null,
  ) => Promise<Response | null>;
}

interface View {
  dialog: HTMLDialogElement;
  why: HTMLElement | null;
  form: HTMLFormElement;
  password: HTMLInputElement;
  passkey: HTMLButtonElement | null;
  passkeyError: HTMLElement | null;
  passkeyErrorText: HTMLElement | null;
  next: HTMLButtonElement | null;
  busy: boolean;
  opener: Element | null;
  settle: ((confirmed: boolean) => void) | null;
  pending: Promise<boolean> | null;
}

function locate(): View | null {
  const roots: ParentNode[] = [document];
  for (const host of document.querySelectorAll("[data-confirm-host]"))
    if (host.shadowRoot) roots.push(host.shadowRoot);
  for (const root of roots) {
    const dialog = root.querySelector<HTMLDialogElement>(
      "dialog[data-confirm-dialog]",
    );
    const form = dialog?.querySelector<HTMLFormElement>("[data-confirm-form]");
    const password = form?.querySelector<HTMLInputElement>(
      'input[type="password"]',
    );
    if (!dialog || !form || !password) continue;
    return {
      dialog,
      why: dialog.querySelector<HTMLElement>("[data-confirm-why]"),
      form,
      password,
      passkey: dialog.querySelector<HTMLButtonElement>(
        '[data-hook="confirm-passkey"]',
      ),
      passkeyError: dialog.querySelector<HTMLElement>(
        "[data-confirm-passkey-error]",
      ),
      passkeyErrorText: dialog.querySelector<HTMLElement>(
        "[data-confirm-passkey-error-text]",
      ),
      next: dialog.querySelector<HTMLButtonElement>(
        '[data-hook="confirm-continue"]',
      ),
      busy: false,
      opener: null,
      settle: null,
      pending: null,
    };
  }
  return null;
}

function canUsePasskeys(): boolean {
  return (
    window.isSecureContext &&
    typeof PublicKeyCredential !== "undefined" &&
    typeof PublicKeyCredential.parseRequestOptionsFromJSON === "function"
  );
}

function setBusy(view: View, busy: boolean): void {
  view.busy = busy;
  view.dialog.querySelector(".card")?.setAttribute("aria-busy", String(busy));
  for (const button of [view.next, view.passkey]) {
    if (!button) continue;
    button.disabled = busy;
  }
  const next = view.next;
  if (next) {
    next.classList.toggle("is-loading", busy);
    if (busy) {
      next.dataset.idleLabel ??= next.textContent;
      next.textContent =
        next.getAttribute("data-loading-label") ?? "Working...";
    } else if (next.dataset.idleLabel !== undefined) {
      next.textContent = next.dataset.idleLabel;
      delete next.dataset.idleLabel;
    }
  }
}

function finish(view: View, confirmed: boolean): void {
  const settle = view.settle;
  view.settle = null;
  if (view.dialog.open) view.dialog.close();
  settle?.(confirmed);
}

function hidePasskeyError(view: View): void {
  if (view.passkeyError) view.passkeyError.hidden = true;
}

function showPasskeyError(view: View, text: string): void {
  if (!view.passkeyError || !view.passkeyErrorText) return;
  view.passkeyErrorText.textContent = text;
  view.passkeyError.hidden = false;
  view.passkeyError.focus();
}

interface Body {
  error?: { message?: unknown };
}

/** The sign-in page, for a session that ended while the dialog was open. */
function signInAgain(): void {
  location.assign(
    `/auth/sign-in?return_to=${encodeURIComponent(location.pathname + location.search)}`,
  );
}

/** The message a refusal carries, or `""`. */
async function messageOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as Body | null;
  const message = body?.error?.message;
  return typeof message === "string" ? message : "";
}

async function post(proof: unknown): Promise<Response> {
  return fetch(CONFIRM, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(proof),
  });
}

type PasswordAnswer =
  { kind: "taken" } | { kind: "ended" } | { kind: "problem"; text: string };

async function sendPassword(password: string): Promise<PasswordAnswer> {
  const response = await post({ password });
  if (response.ok) return { kind: "taken" };
  const message = await messageOf(response);
  if (response.status === 401 && message === CONFIRM_REFUSALS.noSession)
    return { kind: "ended" };
  if (response.status === 401)
    return { kind: "problem", text: WORDS.wrongPassword };
  if (response.status !== 429)
    return { kind: "problem", text: WORDS.somethingWrong };
  const wait = parseWaitSeconds(response.headers.get("retry-after"));
  return {
    kind: "problem",
    text:
      wait === undefined
        ? "Too many attempts. Try again later, or use a passkey."
        : `Too many attempts. Try again in ${waitInMinutes(wait)}, or use a passkey.`,
  };
}

async function submitPassword(view: View): Promise<void> {
  if (view.busy) return;
  const password = view.password.value;
  if (password === "") {
    showFieldError(view.password, WORDS.enterPassword);
    view.password.focus();
    return;
  }
  hidePasskeyError(view);
  setBusy(view, true);
  let answer: PasswordAnswer;
  try {
    answer = await sendPassword(password);
  } catch {
    answer = { kind: "problem", text: WORDS.network };
  } finally {
    setBusy(view, false);
  }
  if (answer.kind === "taken") {
    finish(view, true);
    return;
  }
  if (answer.kind === "ended") {
    signInAgain();
    return;
  }
  showFieldError(view.password, answer.text);
  view.password.focus();
  view.password.select();
}

async function submitPasskey(view: View): Promise<void> {
  if (view.busy) return;
  hidePasskeyError(view);
  clearFieldError(view.password);
  setBusy(view, true);
  try {
    const asked = await fetch(OPTIONS, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!asked.ok) {
      showPasskeyError(view, WORDS.somethingWrong);
      return;
    }
    const options =
      (await asked.json()) as PublicKeyCredentialRequestOptionsJSON;
    options.userVerification = "required";
    const credential = await navigator.credentials.get({
      publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options),
    });
    if (!(credential instanceof PublicKeyCredential)) {
      showPasskeyError(view, "No passkey was selected. Try again.");
      return;
    }
    const response = await post({ passkey: credential.toJSON() });
    if (response.ok) {
      finish(view, true);
      return;
    }
    const message = await messageOf(response);
    if (response.status === 401 && message === CONFIRM_REFUSALS.noSession) {
      signInAgain();
      return;
    }
    showPasskeyError(
      view,
      response.status === 401 && message !== ""
        ? message
        : WORDS.somethingWrong,
    );
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    showPasskeyError(
      view,
      name === "NotAllowedError" || name === "AbortError"
        ? WORDS.cancelled
        : error instanceof TypeError
          ? WORDS.network
          : WORDS.somethingWrong,
    );
  } finally {
    setBusy(view, false);
  }
}

/** Open the dialog and answer whether the person confirmed. */
function ask(
  view: View,
  why: string,
  opener: Element | null,
): Promise<boolean> {
  if (view.pending) return view.pending;
  view.opener = opener;
  if (view.why) view.why.textContent = why;
  view.password.value = "";
  clearFieldError(view.password);
  hidePasskeyError(view);
  setBusy(view, false);
  const pending = new Promise<boolean>((resolve) => {
    view.settle = resolve;
  }).finally(() => {
    view.pending = null;
  });
  view.pending = pending;
  view.dialog.showModal();
  return pending;
}

function wire(view: View): void {
  view.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitPassword(view);
  });
  view.password.addEventListener("input", () => {
    clearFieldError(view.password);
  });
  if (view.passkey) {
    if (canUsePasskeys()) view.passkey.hidden = false;
    view.passkey.addEventListener("click", () => {
      void submitPasskey(view);
    });
  }
  // A dialog that is sending cannot be dismissed, or its answer would have
  // nobody waiting for it.
  view.dialog.addEventListener("cancel", (event) => {
    if (view.busy) event.preventDefault();
  });
  view.dialog.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-dialog-close]") && !view.busy)
      finish(view, false);
  });
  view.dialog.addEventListener("close", () => {
    const opener = view.opener;
    view.opener = null;
    const settle = view.settle;
    view.settle = null;
    settle?.(false);
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  });
}

async function refusedForOldSignIn(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  return isSignInAgainRefusal(response.status, body);
}

function gate(view: View, form: HTMLFormElement): void {
  const left = Number(form.dataset.confirmLeft);
  if (!Number.isFinite(left)) return;
  const needing = new Set(
    (form.dataset.confirmScopes ?? "").split(" ").filter((s) => s !== ""),
  );
  const why = form.dataset.confirmWhy ?? "";
  const rendered = Date.now();
  let confirmed = false;
  // Before the form module's own listener, which would otherwise start the
  // submitting state on a submit this one is about to hold back.
  form.addEventListener(
    "submit",
    (event) => {
      if (confirmed) {
        confirmed = false;
        return;
      }
      const submitter = event.submitter;
      if (
        !(submitter instanceof HTMLElement) ||
        !("confirm" in submitter.dataset)
      )
        return;
      if (Date.now() - rendered < left - EARLY) return;
      const chosen = new FormData(form).getAll("scopes");
      if (
        !chosen.some((scope) => typeof scope === "string" && needing.has(scope))
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void ask(view, why, submitter).then((ok) => {
        if (!ok) return;
        confirmed = true;
        form.requestSubmit(submitter);
      });
    },
    true,
  );
}

let current: View | null = null;

/** The dialog on this page, found and wired the first time it is wanted. */
function dialogView(): View | null {
  if (current) return current;
  const view = locate();
  if (view) wire(view);
  current = view;
  return current;
}

/**
 * Send a change, and if it is refused for an old sign-in, confirm and send it
 * once more. Without the dialog on the page the refusal is the answer.
 */
export async function sendConfirmed(
  send: Send,
  why: string,
  opener: Element | null = document.activeElement,
): Promise<Response | null> {
  const first = await send();
  if (!(await refusedForOldSignIn(first))) return first;
  const view = dialogView();
  if (!view) return first;
  if (!(await ask(view, why, opener))) return null;
  return send();
}

// Set as the script loads, so a page's own script that follows it can use it
// before the document has finished parsing.
(window as Window & { marfaConfirm?: MarfaConfirm }).marfaConfirm = {
  send: sendConfirmed,
};

export function initConfirm(): void {
  const view = dialogView();
  if (!view) return;
  for (const form of document.querySelectorAll<HTMLFormElement>(
    "form[data-confirm-left]",
  ))
    gate(view, form);
}
