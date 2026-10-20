/**
 * The API keys pages: making a key, changing one and revoking one.
 *
 * The server draws every page and writes every word a person can be told into
 * the markup. This module reads the controls, sends the change through the
 * public doors (`POST /keys`, `PATCH /keys/{id}`, `DELETE /keys/{id}`) and
 * shows what came back. A change that needs a recent sign-in goes through
 * `sendConfirmed`, which asks the person to confirm it's them and sends the
 * change once more.
 *
 * A new key's secret is written into the page once, from the answer to the
 * create. It is never put in a link, in storage or in a log, and the address
 * the page ends on shows the same "can't be shown again" page as any later
 * visit.
 */
import { CHOOSE_TYPES } from "../access-summary.js";
import {
  accessBody,
  claimedSources,
  END_CHOICES,
  endsAt,
  extensionPermissions,
  keyFingerprint,
  notAfter,
  SKIPPED_WRITE_RULES,
  withDenials,
  type Denials,
  type EndChoice,
  type ExtensionLevel,
  type FingerprintedKey,
} from "../key-body.js";
import { parseWaitSeconds, waitInMinutes } from "../lockout.js";
import { SETUP_WORDS } from "../setup-words.js";
import { sendConfirmed, signInAgain } from "./confirm.js";
import { hideNotices, showNotice } from "./notice.js";

const KEYS_HREF = "/auth/owner/keys";
const JSON_HEADERS = {
  "content-type": "application/json",
  accept: "application/json",
};
const FLASH = "marfa-keys-flash";
const COPIED_MS = 2000;

const keyHref = (id: string): string =>
  `${KEYS_HREF}/${encodeURIComponent(id)}`;

interface ErrorBody {
  error?: { message?: unknown };
}

async function messageOf(
  response: Response,
  fallback: string,
): Promise<string> {
  const body = (await response.json().catch(() => null)) as ErrorBody | null;
  const message = body?.error?.message;
  return typeof message === "string" && message !== "" ? message : fallback;
}

/** What a refusal says when it is not about one field. */
async function refusalText(response: Response): Promise<string> {
  if (response.status === 429) {
    const wait = parseWaitSeconds(response.headers.get("retry-after"));
    return wait === undefined
      ? "Too many attempts. Try again later."
      : `Too many attempts. Try again in ${waitInMinutes(wait)}.`;
  }
  return response.status === 400 || response.status === 403
    ? messageOf(response, SETUP_WORDS.somethingWrong)
    : SETUP_WORDS.somethingWrong;
}

// ---------------------------------------------------------------------------
// A word that carries over to the next page
// ---------------------------------------------------------------------------

function keepFlash(message: string): void {
  try {
    sessionStorage.setItem(FLASH, message);
  } catch {
    // Without storage the next page simply says nothing.
  }
}

/** Shows, once, what the page before it left to say. */
function showFlash(): void {
  try {
    const message = sessionStorage.getItem(FLASH);
    sessionStorage.removeItem(FLASH);
    if (message !== null) showNotice(document, "flash", message);
  } catch {
    // Without storage there is nothing to say.
  }
}

// ---------------------------------------------------------------------------
// The words under a row, swapped in and out
// ---------------------------------------------------------------------------

const noteOf = (control: Element): HTMLElement | null =>
  control.closest(".row")?.querySelector<HTMLElement>(".rd") ?? null;

/** Replaces the line under a control's row, or puts back the one the server wrote. */
function setNote(control: Element, text: string | null, tone?: "danger"): void {
  const note = noteOf(control);
  if (!note) return;
  note.dataset.original ??= note.textContent;
  note.textContent = text ?? note.dataset.original;
  note.classList.remove("danger");
  if (text !== null && tone !== undefined) note.classList.add(tone);
}

// ---------------------------------------------------------------------------
// Reading the access controls
// ---------------------------------------------------------------------------

/** The scope literals the controls stand at, as an approval page would post them. */
export function literalsOf(form: HTMLFormElement): string[] {
  const choosing =
    form.querySelector<HTMLSelectElement>("select[data-all]")?.value ===
    CHOOSE_TYPES;
  const literals = new Set<string>();
  for (const select of form.querySelectorAll<HTMLSelectElement>(
    "select[name=scopes], select[name=types]",
  )) {
    if (select.value === "" || select.value === CHOOSE_TYPES) continue;
    if (select.name === "types" && !choosing) continue;
    literals.add(select.value);
  }
  for (const box of form.querySelectorAll<HTMLInputElement>(
    "input[type=checkbox][name=scopes]",
  ))
    if (box.checked) literals.add(box.value);
  return [...literals].sort();
}

const field = (
  form: HTMLFormElement,
  name: string,
): HTMLInputElement | HTMLSelectElement => {
  const found = form.elements.namedItem(name);
  if (!(
    found instanceof HTMLInputElement || found instanceof HTMLSelectElement
  ))
    throw new Error(`The form has no ${name} field`);
  return found;
};

const isEndChoice = (value: string): value is EndChoice =>
  (END_CHOICES as readonly string[]).includes(value);

// ---------------------------------------------------------------------------
// A button that is busy
// ---------------------------------------------------------------------------

function busy(button: HTMLButtonElement, on: boolean): void {
  if (on) {
    button.dataset.idleLabel ??= button.textContent;
    button.textContent = button.dataset.loadingLabel ?? "Working...";
    button.classList.add("is-loading");
    button.setAttribute("aria-busy", "true");
  } else {
    if (button.dataset.idleLabel !== undefined)
      button.textContent = button.dataset.idleLabel;
    delete button.dataset.idleLabel;
    button.classList.remove("is-loading");
    button.removeAttribute("aria-busy");
  }
}

const hook = (root: ParentNode, name: string): HTMLButtonElement | null =>
  root.querySelector<HTMLButtonElement>(`[data-hook="${name}"]`);

function setAvailable(button: HTMLElement | null, available: boolean): void {
  if (!button) return;
  if (available) button.removeAttribute("aria-disabled");
  else button.setAttribute("aria-disabled", "true");
}

const isAvailable = (button: HTMLElement | null): boolean =>
  button !== null && button.getAttribute("aria-disabled") !== "true";

/** Opens the row that holds a control, so a script can send focus to it. */
function reveal(control: HTMLElement): void {
  const details = control.closest("details");
  if (details) details.open = true;
}

function describeProblem(form: HTMLFormElement, text: string): void {
  showNotice(form, "problem", text);
}

// ---------------------------------------------------------------------------
// Create key
// ---------------------------------------------------------------------------

interface Reason {
  text: string;
  /** Where focus goes when the person presses the button anyway. */
  focus: () => void;
}

function createReason(form: HTMLFormElement): Reason | null {
  const name = field(form, "label");
  if (name.value.trim() === "")
    return {
      text: form.dataset.reasonName ?? "",
      focus: () => {
        setNote(
          name,
          form.querySelector<HTMLElement>("[data-note-error]")?.dataset
            .noteError ?? null,
          "danger",
        );
        name.focus();
      },
    };
  const literals = literalsOf(form);
  if (literals.length === 0)
    return {
      text: form.dataset.reasonAccess ?? "",
      focus: () => {
        const first = form.querySelector<HTMLElement>(
          "select[name=scopes], input[type=checkbox][name=scopes]",
        );
        if (!first) return;
        reveal(first);
        first.focus();
      },
    };
  return null;
}

function syncCreate(form: HTMLFormElement): void {
  const reason = createReason(form);
  setAvailable(hook(form, "key-submit"), reason === null);
  const line = form.querySelector<HTMLElement>("[data-reason]");
  if (line) line.textContent = reason?.text ?? "";
}

interface Made {
  id: string;
  label: string;
  key: string;
}

function isMade(value: unknown): value is Made {
  const made = value as Partial<Made> | null;
  return (
    made !== null &&
    typeof made === "object" &&
    typeof made.id === "string" &&
    typeof made.label === "string" &&
    typeof made.key === "string"
  );
}

function createBody(form: HTMLFormElement): Record<string, unknown> {
  const label = field(form, "label").value.trim();
  const source = field(form, "source").value.trim() || label;
  const end = field(form, "ends").value;
  const expiresAt = isEndChoice(end) ? endsAt(end, Date.now()) : null;
  const sources = claimedSources(field(form, "sources").value, source);
  return {
    label,
    source,
    ...accessBody(literalsOf(form)),
    extension_permissions: extensionPermissions(
      extensionLevel(field(form, "extensions").value),
    ),
    ...(sources.length > 0 ? { sources } : {}),
    default_tier: field(form, "default_tier").value,
    ...(expiresAt === null ? {} : { expires_at: expiresAt }),
    ...(field(form, "rules").value === "skip"
      ? { enforcement_override: SKIPPED_WRITE_RULES }
      : {}),
  };
}

const extensionLevel = (value: string): ExtensionLevel =>
  value === "read" || value === "write" ? value : "none";

/** Shows the secret once, in place of the form. */
function showSecret(form: HTMLFormElement, made: Made): void {
  const view = document.querySelector<HTMLElement>("[data-key-copy]");
  if (!view) return;
  const title = view.querySelector<HTMLElement>(".rt");
  if (title) title.textContent = made.label;
  const secret = view.querySelector<HTMLElement>("#key-secret");
  if (secret) {
    secret.textContent = made.key;
    secret.classList.add("secret");
  }
  const done = hook(view, "key-done");
  if (done instanceof HTMLElement) done.setAttribute("href", keyHref(made.id));
  const copy = view.querySelector<HTMLButtonElement>("[data-key-copy]");
  let onCopy: (() => void) | undefined;
  if (copy && "clipboard" in navigator) {
    copy.hidden = false;
    const label = copy.textContent;
    onCopy = () => {
      void navigator.clipboard
        .writeText(made.key)
        .then(() => {
          copy.textContent = "Copied";
          setTimeout(() => {
            copy.textContent = label;
          }, COPIED_MS);
        })
        .catch(() => {
          // A refused write leaves the secret on the screen to select by hand.
        });
    };
    copy.addEventListener("click", onCopy);
  }
  // A page the browser keeps for the back button would otherwise bring the
  // secret back whole. It is taken off the page as the person leaves, and
  // coming back to the kept page shows what any later visit shows.
  window.addEventListener(
    "pagehide",
    () => {
      if (secret) secret.textContent = "";
      if (copy && onCopy) copy.removeEventListener("click", onCopy);
    },
    { once: true },
  );
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) location.reload();
  });
  form.hidden = true;
  view.hidden = false;
  document.title = "Copy your key";
  const here = document.querySelector<HTMLElement>(".crumbs .here");
  if (here) here.textContent = "Copy your key";
  history.replaceState(null, "", `${keyHref(made.id)}/copy`);
  const heading = view.querySelector<HTMLElement>("h1");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus();
  }
}

async function submitCreate(form: HTMLFormElement): Promise<void> {
  const button = hook(form, "key-submit");
  if (!(button instanceof HTMLButtonElement) || form.dataset.sending === "1")
    return;
  const reason = createReason(form);
  if (reason) {
    reason.focus();
    return;
  }
  hideNotices(form);
  const source = field(form, "source");
  setNote(source, null);
  const body = createBody(form);
  form.dataset.sending = "1";
  busy(button, true);
  try {
    const response = await sendConfirmed(
      () =>
        fetch("/keys", {
          method: "POST",
          credentials: "same-origin",
          headers: JSON_HEADERS,
          body: JSON.stringify(body),
        }),
      form.dataset.confirmWhy ?? "Confirm it's you.",
      button,
    );
    if (response === null) return;
    if (response.status === 201) {
      const made: unknown = await response.json().catch(() => null);
      if (isMade(made)) {
        showSecret(form, made);
        return;
      }
      describeProblem(form, SETUP_WORDS.somethingWrong);
      return;
    }
    if (response.status === 401) {
      signInAgain();
      return;
    }
    if (response.status === 409) {
      setNote(
        source,
        await messageOf(
          response,
          "Another key already writes as that source. Choose another.",
        ),
        "danger",
      );
      source.focus();
      return;
    }
    describeProblem(form, await refusalText(response));
  } catch {
    describeProblem(form, SETUP_WORDS.network);
  } finally {
    delete form.dataset.sending;
    busy(button, false);
  }
}

function initCreate(form: HTMLFormElement): void {
  const sync = (): void => {
    syncCreate(form);
  };
  sync();
  form.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.id === "key-name") setNote(target, null);
    if (target.id === "key-source") setNote(target, null);
    sync();
  });
  form.addEventListener("change", sync);
  window.addEventListener("pageshow", sync);
  // Ahead of the page's own submit handling, which would validate and send a
  // plain form this one is not.
  form.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      void submitCreate(form);
    },
    true,
  );
}

// ---------------------------------------------------------------------------
// A key
// ---------------------------------------------------------------------------

/** What the controls stand at, to tell whether anything has changed. */
const stateOf = (form: HTMLFormElement): string =>
  JSON.stringify([literalsOf(form), field(form, "ends").value]);

function syncEdit(form: HTMLFormElement, initial: string): void {
  const changed = stateOf(form) !== initial;
  const save = hook(form, "key-submit");
  const discard = hook(form, "key-discard");
  setAvailable(save, changed);
  setAvailable(discard, changed);
  const line = form.querySelector<HTMLElement>("[data-reason]");
  if (line)
    line.textContent = changed
      ? "Nothing changes until you save."
      : (save?.dataset.idle ?? "");
}

function keptDenials(form: HTMLFormElement): Denials {
  try {
    const kept: unknown = JSON.parse(form.dataset.keep ?? "{}");
    return kept !== null && typeof kept === "object" ? kept : {};
  } catch {
    return {};
  }
}

function editBody(
  form: HTMLFormElement,
  initialLiterals: string,
): Record<string, unknown> {
  const literals = literalsOf(form);
  const ends = field(form, "ends");
  const end = ends.value;
  return {
    narrow_only: true,
    ...(JSON.stringify(literals) === initialLiterals
      ? {}
      : withDenials(accessBody(literals), keptDenials(form))),
    ...(end === ends.dataset.initial || !isEndChoice(end)
      ? {}
      : {
          expires_at: notAfter(
            endsAt(end, Date.now()),
            ends.dataset.currentIso,
          ),
        }),
  };
}

const CHANGED_ELSEWHERE =
  "This key changed after this page opened. Reload to see it.";
const GONE_WORDS =
  "This key was revoked or has ended. Go to API keys to see what is left.";

type Seen =
  | { state: "same" }
  | { state: "changed" }
  | { state: "gone" }
  | { state: "refused"; response: Response };

/**
 * Looks at the key as it is now and compares it with what the page loaded, so
 * a save made on a page that has gone stale does not run over a newer change.
 */
async function seeKey(form: HTMLFormElement, id: string): Promise<Seen> {
  const response = await fetch("/keys", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!response.ok) return { state: "refused", response };
  const list = (await response.json().catch(() => null)) as {
    data?: unknown;
  } | null;
  const found = Array.isArray(list?.data)
    ? (list.data as (FingerprintedKey & { id?: unknown })[]).find(
        (key) => key.id === id,
      )
    : undefined;
  if (found === undefined) return { state: "gone" };
  return keyFingerprint(found) === form.dataset.loaded
    ? { state: "same" }
    : { state: "changed" };
}

async function submitEdit(
  form: HTMLFormElement,
  initialLiterals: string,
): Promise<void> {
  const button = hook(form, "key-submit");
  if (!(button instanceof HTMLButtonElement) || form.dataset.sending === "1")
    return;
  if (!isAvailable(button)) return;
  hideNotices(form);
  const id = form.dataset.keyId ?? "";
  const body = editBody(form, initialLiterals);
  form.dataset.sending = "1";
  busy(button, true);
  let leaving = false;
  try {
    const seen = await seeKey(form, id);
    if (seen.state === "refused") {
      if (seen.response.status === 401) {
        signInAgain();
        leaving = true;
        return;
      }
      describeProblem(form, await refusalText(seen.response));
      return;
    }
    if (seen.state === "gone") {
      describeProblem(form, GONE_WORDS);
      return;
    }
    if (seen.state === "changed") {
      describeProblem(form, CHANGED_ELSEWHERE);
      return;
    }
    const response = await sendConfirmed(
      () =>
        fetch(`/keys/${encodeURIComponent(id)}`, {
          method: "PATCH",
          credentials: "same-origin",
          headers: JSON_HEADERS,
          body: JSON.stringify(body),
        }),
      form.dataset.confirmWhy ?? "Confirm it's you.",
      button,
    );
    if (response === null) return;
    if (response.ok) {
      keepFlash("Saved");
      leaving = true;
      location.reload();
      return;
    }
    if (response.status === 401) {
      signInAgain();
      leaving = true;
      return;
    }
    if (response.status === 404) {
      describeProblem(form, GONE_WORDS);
      return;
    }
    describeProblem(form, await refusalText(response));
  } catch {
    describeProblem(form, SETUP_WORDS.network);
  } finally {
    delete form.dataset.sending;
    if (!leaving) busy(button, false);
  }
}

async function revoke(): Promise<void> {
  const dialog = document.getElementById("key-revoke-dialog");
  if (!(dialog instanceof HTMLDialogElement)) return;
  const button = hook(dialog, "key-revoke");
  if (!(button instanceof HTMLButtonElement) || dialog.dataset.sending === "1")
    return;
  const id = dialog.dataset.keyId ?? "";
  const label = dialog.dataset.keyLabel ?? "the key";
  hideNotices(dialog);
  dialog.dataset.sending = "1";
  busy(button, true);
  let leaving = false;
  try {
    const response = await sendConfirmed(
      () =>
        fetch(`/keys/${encodeURIComponent(id)}`, {
          method: "DELETE",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        }),
      dialog.dataset.confirmWhy ?? "Confirm it's you.",
      button,
    );
    if (response === null) return;
    // A key that is already gone is the state the person asked for.
    if (response.ok || response.status === 404) {
      keepFlash(`Revoked ${label}`);
      leaving = true;
      location.assign(KEYS_HREF);
      return;
    }
    if (response.status === 401) {
      signInAgain();
      leaving = true;
      return;
    }
    showNotice(dialog, "revoke-problem", await refusalText(response));
  } catch {
    showNotice(dialog, "revoke-problem", SETUP_WORDS.network);
  } finally {
    delete dialog.dataset.sending;
    if (!leaving) busy(button, false);
  }
}

function initEdit(form: HTMLFormElement): void {
  const initial = stateOf(form);
  const initialLiterals = JSON.stringify(literalsOf(form));
  const sync = (): void => {
    syncEdit(form, initial);
  };
  sync();
  form.addEventListener("input", sync);
  form.addEventListener("change", sync);
  window.addEventListener("pageshow", sync);
  hook(form, "key-discard")?.addEventListener("click", () => {
    if (!isAvailable(hook(form, "key-discard"))) return;
    form.reset();
    // The access lines follow the controls when the form announces a change.
    form.dispatchEvent(new Event("change", { bubbles: true }));
    hideNotices(form);
    sync();
  });
  hook(document, "key-revoke")?.addEventListener("click", () => {
    void revoke();
  });
  // Ahead of the page's own submit handling, which would validate and send a
  // plain form this one is not.
  form.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      void submitEdit(form, initialLiterals);
    },
    true,
  );
}

// ---------------------------------------------------------------------------

export function initKeys(): void {
  showFlash();
  for (const form of document.querySelectorAll<HTMLFormElement>(
    "form[data-key-form]",
  )) {
    if (form.dataset.keyForm === "create") initCreate(form);
    else if (form.dataset.keyForm === "edit") initEdit(form);
  }
}
