"use strict";
(() => {
  const RECENT_SIGN_IN_REFUSAL = "Sign in again to perform this operation";

  /** Sends JSON and reads the answer. Null when no answer came. */
  async function postJson(path, data) {
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
        retryAfter: Number(response.headers.get("retry-after")),
        body: await response.json().catch(() => null),
      };
    } catch {
      return null;
    }
  }

  function reveal(selector, shown) {
    for (const element of document.querySelectorAll(selector)) {
      element.hidden = !shown;
    }
  }

  // Setup: a link opened from the machine carries a one-time ticket in the
  // address fragment, which the server never sees.
  function exchangeHandoff() {
    if (location.pathname !== "/setup") return;
    const ticket = new URLSearchParams(location.hash.slice(1)).get("handoff");
    if (!ticket) return;
    history.replaceState(null, "", location.pathname + location.search);
    reveal("[data-handoff-working]", true);
    postJson("/setup/exchange", { ticket }).then((answer) => {
      if (answer && (answer.status === 200 || answer.status === 409)) {
        location.replace("/setup");
        return;
      }
      reveal("[data-handoff-working]", false);
      reveal("[data-handoff-failed]", true);
    });
  }

  // Confirming a stale sign-in. The dialog is on the page only when a change
  // there may need a recent sign-in.
  const dialog = document.getElementById("confirm-dialog");

  function showConfirmError(kind, waitSeconds) {
    for (const element of dialog.querySelectorAll("[data-confirm-error]")) {
      element.hidden = element.dataset.confirmError !== kind;
    }
    const wait = dialog.querySelector("[data-wait]");
    if (kind === "locked" && wait) {
      const minutes = Math.max(1, Math.ceil(waitSeconds / 60));
      wait.textContent = minutes + (minutes === 1 ? " minute" : " minutes");
    }
  }

  async function submitConfirmation(form) {
    const password = form.elements.namedItem("password");
    showConfirmError("none", 0);
    const answer = await postJson("/auth/confirm", { password: password.value });
    password.value = "";
    if (answer && answer.status === 200) dialog.close("confirmed");
    else if (answer && answer.status === 401) showConfirmError("password", 0);
    else if (answer && answer.status === 429)
      showConfirmError("locked", answer.retryAfter || 60);
    else showConfirmError("other", 0);
  }

  /** Resolves true once the owner has confirmed, false if they gave up. */
  function confirmItsYou() {
    return new Promise((resolve) => {
      showConfirmError("none", 0);
      dialog.addEventListener(
        "close",
        () => resolve(dialog.returnValue === "confirmed"),
        { once: true },
      );
      dialog.returnValue = "";
      dialog.showModal();
    });
  }

  async function isRecentSignInRefusal(response) {
    if (response.status !== 403) return false;
    const body = await response.clone().json().catch(() => null);
    return body?.error?.message === RECENT_SIGN_IN_REFUSAL;
  }

  // A form marked data-change is sent with fetch and asks for JSON. A refusal
  // for an old sign-in opens the dialog, and the change is sent once more
  // after the owner confirms. A successful answer that names a url sends the
  // browser there, otherwise to the form's data-then address or back to this
  // page.
  async function sendChange(form) {
    const send = () =>
      fetch(form.action, {
        method: form.method.toUpperCase(),
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(new FormData(form)),
      }).catch(() => null);

    let response = await send();
    if (response && dialog && (await isRecentSignInRefusal(response))) {
      if (await confirmItsYou()) response = await send();
    }
    const body = response ? await response.json().catch(() => null) : null;
    if (response && response.ok) {
      if (typeof body?.url === "string") location.assign(body.url);
      else if (form.dataset.then) location.assign(form.dataset.then);
      else location.reload();
      return;
    }
    const failure = form.querySelector("[data-form-error]");
    if (failure) {
      const message = body?.error?.message;
      failure.textContent =
        typeof message === "string" ? message : failure.dataset.fallback;
      failure.hidden = false;
    }
  }

  function watchChanges() {
    for (const form of document.querySelectorAll("form[data-change]")) {
      form.addEventListener("submit", (event) => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        const buttons = form.querySelectorAll("button[type=submit]");
        for (const button of buttons) button.disabled = true;
        sendChange(form).finally(() => {
          for (const button of buttons) button.disabled = false;
        });
      });
    }
  }

  function watchDialog() {
    if (!dialog) return;
    const form = dialog.querySelector("form");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitConfirmation(form);
    });
    dialog
      .querySelector("[data-confirm-cancel]")
      .addEventListener("click", () => dialog.close());
  }

  // WebAuthn. A later step defines this object with one function for each
  // data-passkey value on the page ("sign-in" and "confirm"). Each takes the
  // button that was pressed. While it is null the passkey buttons stay hidden.
  const webauthn = null;

  function watchPasskeys() {
    if (!webauthn || !window.PublicKeyCredential) return;
    for (const button of document.querySelectorAll("[data-passkey]")) {
      button.hidden = false;
      const group = button.closest("[data-passkey-group]");
      if (group) group.hidden = false;
      button.addEventListener("click", () => {
        void webauthn[button.dataset.passkey](button);
      });
    }
  }

  exchangeHandoff();
  watchChanges();
  watchDialog();
  watchPasskeys();
})();
