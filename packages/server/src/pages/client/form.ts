/**
 * Form submit lifecycle for POST forms: inline validation, then the
 * submitting state.
 *
 * Forms carry `novalidate`, so the browser never shows its own validation
 * bubble. On submit this checks each field and shows its message under it,
 * focuses the first invalid one and stops the submit; the message clears when
 * the field becomes valid. Once validation passes the submit button is
 * disabled and shows its `data-loading-label`, and a second submit is dropped.
 * A page restored from the back-forward cache is the page as it was left, so
 * `pageshow` clears the submitting state on a restored one.
 *
 * With scripting off the form is a plain POST that the server validates.
 * A GET form is left alone, except that a select marked `data-autosubmit`
 * submits its form when it changes.
 */
const FALLBACK = "Working...";

export type Control =
  HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const fieldOf = (control: Control): HTMLElement | null =>
  control.closest<HTMLElement>(".field");

function messageFor(control: Control): string {
  const custom = control.getAttribute("data-validate-msg");
  const validity = control.validity;
  if (validity.valueMissing)
    return control.getAttribute("data-required-msg") ?? "Please fill this in.";
  if (validity.typeMismatch && control.getAttribute("type") === "email")
    return "Enter a valid email address.";
  if (validity.tooShort && "minLength" in control)
    return `Use at least ${String(control.minLength)} characters.`;
  if (custom) return custom;
  if (validity.patternMismatch) return "Check the format and try again.";
  return control.validationMessage || "Check this field.";
}

/** Remove a message `showFieldError` or the validation pass made. */
export function clearFieldError(control: Control): void {
  const field = fieldOf(control);
  if (!field) return;
  control.removeAttribute("aria-invalid");
  const message = field.querySelector<HTMLElement>(".err");
  // Only a message this module made goes; one the server rendered stays.
  if (message?.dataset.jsError === "1") {
    message.remove();
    describe(control, null);
  }
}

function describe(control: Control, id: string | null): void {
  const ids = (control.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter((part) => part !== "" && !part.endsWith("-js-err"));
  if (id) ids.push(id);
  if (ids.length > 0) control.setAttribute("aria-describedby", ids.join(" "));
  else control.removeAttribute("aria-describedby");
}

/**
 * Show `text` under the field and mark it invalid. The server's refusal of a
 * value the browser accepted (a wrong code, a taken address) goes through here
 * too, so every message sits in the same place and clears the same way.
 */
export function showFieldError(control: Control, text?: string): void {
  const field = fieldOf(control);
  if (!field) return;
  control.setAttribute("aria-invalid", "true");
  let message = field.querySelector<HTMLElement>(".err");
  if (!message) {
    message = document.createElement("p");
    message.className = "err";
    message.setAttribute("role", "alert");
    message.dataset.jsError = "1";
    message.id = `${control.id || "field"}-js-err`;
    field.append(message);
    describe(control, message.id);
  }
  message.textContent = text ?? messageFor(control);
}

/** Check every visible field in `container`; the first invalid one, if any. */
function validate(container: HTMLElement): Control | null {
  let firstInvalid: Control | null = null;
  const controls = container.querySelectorAll<Control>(
    "input, select, textarea",
  );
  for (const control of controls) {
    if (
      (control instanceof HTMLInputElement && control.type === "hidden") ||
      control.hidden ||
      control.disabled
    )
      continue;
    if (control.checkValidity()) {
      clearFieldError(control);
    } else {
      showFieldError(control);
      firstInvalid ??= control;
    }
  }
  return firstInvalid;
}

function submitButton(form: HTMLFormElement): HTMLElement | null {
  for (const el of form.querySelectorAll<HTMLElement>(
    "button, input[type=submit]",
  )) {
    if (el instanceof HTMLInputElement) return el;
    if ((el.getAttribute("type") ?? "submit").toLowerCase() === "submit")
      return el;
  }
  return null;
}

function onSubmit(event: SubmitEvent): void {
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;

  const firstInvalid = validate(form);
  if (firstInvalid) {
    event.preventDefault();
    firstInvalid.focus();
    return;
  }
  if (form.dataset.submitting === "1") {
    event.preventDefault();
    return;
  }
  form.dataset.submitting = "1";

  const button = event.submitter ?? submitButton(form);
  if (!(button instanceof HTMLButtonElement)) return;

  button.classList.add("is-loading");
  button.dataset.idleLabel ??= button.textContent;
  button.textContent = button.getAttribute("data-loading-label") ?? FALLBACK;
  // Disabled after the submit event, so the button's name and value still post.
  setTimeout(() => {
    button.disabled = true;
  }, 0);
}

/** Make a form that was sending submittable again. */
export function resetSubmitState(form: HTMLFormElement): void {
  delete form.dataset.submitting;
  for (const button of form.querySelectorAll<HTMLElement>(
    "button, input[type=submit]",
  )) {
    button.classList.remove("is-loading");
    if (
      button instanceof HTMLButtonElement ||
      button instanceof HTMLInputElement
    )
      button.disabled = false;
    const idle = button.dataset.idleLabel;
    if (idle !== undefined) {
      button.textContent = idle;
      delete button.dataset.idleLabel;
    }
  }
}

export function initForms(): void {
  document.addEventListener("input", (event) => {
    const control = event.target;
    if (!(
      control instanceof HTMLInputElement ||
      control instanceof HTMLSelectElement ||
      control instanceof HTMLTextAreaElement
    ))
      return;
    const field = fieldOf(control);
    if (
      field &&
      control.getAttribute("aria-invalid") &&
      control.checkValidity()
    )
      clearFieldError(control);
  });

  document.addEventListener("change", (event) => {
    const select = event.target;
    if (select instanceof HTMLSelectElement && "autosubmit" in select.dataset)
      select.form?.requestSubmit();
  });

  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    for (const form of document.querySelectorAll<HTMLFormElement>(
      "form[data-submitting]",
    ))
      resetSubmitState(form);
  });

  for (const form of document.querySelectorAll<HTMLFormElement>("form")) {
    if ((form.getAttribute("method") ?? "get").toLowerCase() !== "post")
      continue;
    form.addEventListener("submit", onSubmit);
  }
}
