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

  // WebAuthn. The server's JSON carries bytes as base64url, and the browser's
  // API takes and gives ArrayBuffers.
  function toBytes(text) {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  }

  function toText(buffer) {
    let binary = "";
    for (const byte of new Uint8Array(buffer)) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  async function getJson(path) {
    try {
      const response = await fetch(path, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      return {
        response,
        status: response.status,
        body: await response.clone().json().catch(() => null),
      };
    } catch {
      return null;
    }
  }

  /** Asks the browser for an assertion. Null if the person cancelled. */
  async function askForAssertion() {
    const asked = await getJson("/auth/passkey/generate-authenticate-options");
    if (!asked || asked.status !== 200) throw new Error("no options");
    const publicKey = {
      ...asked.body,
      challenge: toBytes(asked.body.challenge),
      allowCredentials: [],
    };
    let credential;
    try {
      credential = await navigator.credentials.get({ publicKey });
    } catch (error) {
      if (error.name === "NotAllowedError" || error.name === "AbortError") {
        return null;
      }
      throw error;
    }
    const { response } = credential;
    return {
      id: credential.id,
      rawId: toText(credential.rawId),
      type: credential.type,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: toText(response.clientDataJSON),
        authenticatorData: toText(response.authenticatorData),
        signature: toText(response.signature),
        userHandle: response.userHandle ? toText(response.userHandle) : null,
      },
    };
  }

  /** Asks the browser to make a passkey. Null if the person cancelled. */
  async function askForRegistration(options) {
    const publicKey = {
      ...options,
      challenge: toBytes(options.challenge),
      user: { ...options.user, id: toBytes(options.user.id) },
      excludeCredentials: options.excludeCredentials.map((excluded) => ({
        ...excluded,
        id: toBytes(excluded.id),
      })),
    };
    let credential;
    try {
      credential = await navigator.credentials.create({ publicKey });
    } catch (error) {
      if (error.name === "NotAllowedError" || error.name === "AbortError") {
        return null;
      }
      throw error;
    }
    const { response } = credential;
    return {
      id: credential.id,
      rawId: toText(credential.rawId),
      type: credential.type,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: toText(response.clientDataJSON),
        attestationObject: toText(response.attestationObject),
        transports: response.getTransports ? response.getTransports() : [],
      },
    };
  }

  function showPasskeyError(message) {
    const failure = document.querySelector("[data-passkey-error]");
    if (!failure) return;
    failure.textContent = message;
    failure.hidden = !message;
  }

  const SOMETHING_WENT_WRONG = "Something went wrong. Try again.";

  /** Sends a request again once the owner confirms an old sign-in. */
  async function withRecentSignIn(send) {
    const answer = await send();
    if (answer && dialog && (await isRecentSignInRefusal(answer.response))) {
      if (await confirmItsYou()) return send();
      return null;
    }
    return answer;
  }

  function returnTo() {
    return document.querySelector("input[name=return_to]").value;
  }

  function goBackToSignIn() {
    const query = new URLSearchParams({ error: "passkey" });
    if (returnTo()) query.set("return_to", returnTo());
    location.assign("/auth/sign-in?" + query);
  }

  const webauthn = {
    async "sign-in"(button) {
      button.disabled = true;
      try {
        const response = await askForAssertion();
        if (!response) return;
        const answer = await postJson("/auth/passkey/verify-authentication", {
          response,
        });
        if (answer && answer.status === 200) location.assign(returnTo() || "/");
        else goBackToSignIn();
      } catch {
        goBackToSignIn();
      } finally {
        button.disabled = false;
      }
    },

    async confirm(button) {
      button.disabled = true;
      showConfirmError("none", 0);
      try {
        const passkey = await askForAssertion();
        if (!passkey) return;
        const answer = await postJson("/auth/confirm", { passkey });
        if (answer && answer.status === 200) dialog.close("confirmed");
        else showConfirmError("other", 0);
      } catch {
        showConfirmError("other", 0);
      } finally {
        button.disabled = false;
      }
    },

    async add(button) {
      button.disabled = true;
      showPasskeyError("");
      try {
        const asked = await withRecentSignIn(() =>
          getJson("/auth/passkey/generate-register-options"),
        );
        if (!asked) return;
        if (asked.status !== 200) {
          showPasskeyError(asked.body?.error?.message ?? SOMETHING_WENT_WRONG);
          return;
        }
        const response = await askForRegistration(asked.body);
        if (!response) return;
        const field = document.querySelector("[data-passkey-name]");
        const name = field.value.trim();
        const answer = await postJson("/auth/passkey/verify-registration", {
          ...(name ? { name } : {}),
          response,
        });
        if (answer && answer.status === 200) location.reload();
        else {
          showPasskeyError(answer?.body?.error?.message ?? SOMETHING_WENT_WRONG);
        }
      } catch (error) {
        showPasskeyError(
          error.name === "InvalidStateError"
            ? "This device already has a passkey here."
            : SOMETHING_WENT_WRONG,
        );
      } finally {
        button.disabled = false;
      }
    },
  };

  // A browser refuses a passkey at an IP address.
  function addressTakesPasskeys() {
    return !/^(\[.*\]|\d+\.\d+\.\d+\.\d+)$/.test(location.hostname);
  }

  function watchPasskeys() {
    if (!window.PublicKeyCredential || !addressTakesPasskeys()) return;
    for (const button of document.querySelectorAll("[data-passkey]")) {
      button.hidden = false;
      const group = button.closest("[data-passkey-group]");
      if (group) group.hidden = false;
      button.addEventListener("click", () => {
        void webauthn[button.dataset.passkey](button);
      });
    }
  }

  async function removePasskey(button) {
    button.disabled = true;
    showPasskeyError("");
    const path = "/owner/passkeys/" + button.dataset.passkeyRemove;
    const answer = await withRecentSignIn(async () => {
      const response = await fetch(path, {
        method: "DELETE",
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" },
      }).catch(() => null);
      return response && { response, status: response.status };
    });
    if (answer && answer.status === 200) location.reload();
    else if (answer !== null) showPasskeyError(SOMETHING_WENT_WRONG);
    button.disabled = false;
  }

  function watchPasskeyRemovals() {
    for (const button of document.querySelectorAll("[data-passkey-remove]")) {
      button.addEventListener("click", () => void removePasskey(button));
    }
  }

  exchangeHandoff();
  watchChanges();
  watchDialog();
  watchPasskeys();
  watchPasskeyRemovals();
})();
