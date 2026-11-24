"use strict";
(() => {
  document.documentElement.classList.add("js");

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

  // The control that opened the dialog, kept until it is enabled again and the dialog is closed.
  let opener = null;

  function giveFocusBack() {
    if (dialog?.open || !opener || !opener.isConnected || opener.disabled) return;
    opener.focus();
    opener = null;
  }

  /** Disables buttons while their request is open, and gives focus back when it ends. */
  function setBusy(buttons, busy) {
    for (const button of buttons) button.disabled = busy;
    if (!busy) giveFocusBack();
  }

  function reveal(selector, shown) {
    for (const element of document.querySelectorAll(selector)) {
      element.hidden = !shown;
    }
  }

  // A setup link carries a one-time ticket in the fragment, which the server never sees.
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
    const buttons = form.querySelectorAll("button[type=submit]");
    showConfirmError("none", 0);
    setBusy(buttons, true);
    const answer = await postJson("/auth/confirm", { password: password.value });
    setBusy(buttons, false);
    password.value = "";
    if (answer && answer.status === 200) dialog.close("confirmed");
    else if (answer && answer.status === 401) showConfirmError("password", 0);
    else if (answer && answer.status === 429)
      showConfirmError("locked", answer.retryAfter || 60);
    else showConfirmError("other", 0);
  }

  /** Resolves true once the owner has confirmed, false if they gave up. */
  function confirmItsYou(opening) {
    return new Promise((resolve) => {
      showConfirmError("none", 0);
      opener = opening;
      dialog.addEventListener(
        "close",
        () => {
          giveFocusBack();
          resolve(dialog.returnValue === "confirmed");
        },
        { once: true },
      );
      dialog.returnValue = "";
      dialog.showModal();
    });
  }

  async function isRecentSignInRefusal(response) {
    if (response.status !== 403) return false;
    const body = await response.clone().json().catch(() => null);
    return body?.error?.details?.needs === "recent_sign_in";
  }

  // A form marked data-change is sent with fetch; a stale sign-in opens the dialog and the
  // change is resent after confirming.
  async function sendChange(form, submitter) {
    const opening = submitter ?? form.querySelector("button[type=submit]");
    const body = new URLSearchParams(
      submitter ? new FormData(form, submitter) : new FormData(form),
    );
    const send = () =>
      fetch(form.action, {
        method: form.method.toUpperCase(),
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      }).catch(() => null);

    let response = await send();
    if (response && dialog && (await isRecentSignInRefusal(response))) {
      if (await confirmItsYou(opening)) response = await send();
    }
    const text = response ? await response.text() : "";
    const isPage = (response?.headers.get("content-type") ?? "").includes(
      "text/html",
    );
    const answer = isPage ? null : (() => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })();
    const failure = form.querySelector("[data-form-error]");
    const done = form.querySelector("[data-form-done]");
    if (done) done.hidden = true;
    if (response && response.ok) {
      if (isPage) showPage(text);
      else if (done) {
        form.reset();
        if (failure) failure.hidden = true;
        done.hidden = false;
      } else if (typeof answer?.url === "string") location.assign(answer.url);
      else if (form.dataset.then) location.assign(form.dataset.then);
      else location.reload();
      return;
    }
    if (failure) {
      const message = answer?.error?.message;
      failure.textContent =
        typeof message === "string" ? message : failure.dataset.fallback;
      failure.hidden = false;
    }
  }

  // An answer that is a page replaces this page's content; its markup is read, never run.
  function showPage(html) {
    // A template keeps the page's own style and script elements inert, so the
    // content policy has nothing to refuse.
    const next = document.createElement("template");
    next.innerHTML = html;
    const main = document.querySelector("main");
    const incoming = next.content.querySelector("main");
    if (!main || !incoming) {
      location.reload();
      return;
    }
    const title = next.content.querySelector("title");
    if (title) document.title = title.textContent;
    main.replaceChildren(...incoming.childNodes);
    watchPage(main);
    window.scrollTo(0, 0);
  }

  function watchChanges(root = document) {
    for (const form of root.querySelectorAll("form[data-change]")) {
      form.addEventListener("submit", (event) => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        const buttons = form.querySelectorAll("button[type=submit]");
        const sending = sendChange(form, event.submitter);
        setBusy(buttons, true);
        sending.finally(() => setBusy(buttons, false));
      });
    }
  }

  // A form the browser sends keeps its buttons disabled until the answer, or the cached page, returns.
  function watchForms(root = document) {
    for (const form of root.querySelectorAll("form:not([data-change], [method=dialog])")) {
      if (form.dataset.passkeyRenameForm) continue;
      form.addEventListener("submit", (event) => {
        if (event.defaultPrevented) return;
        const buttons = form.querySelectorAll("button[type=submit]");
        // The browser reads the form after this event, so a submitter disabled now would not be sent.
        setTimeout(() => setBusy(buttons, true));
      });
    }
  }

  addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    for (const button of document.querySelectorAll("button[type=submit]")) {
      button.disabled = false;
    }
  });

  // The server reads only the letters and digits of a code, in capitals.
  const isCodeCharacter = (character) => /[A-Za-z0-9]/.test(character);
  const codeCharactersIn = (text) => [...text].filter(isCodeCharacter).length;

  /** `text` up to its `room`th letter or digit. */
  function fitCode(text, room) {
    let kept = "";
    for (const character of text) {
      if (isCodeCharacter(character)) {
        if (room <= 0) break;
        room -= 1;
      }
      kept += character;
    }
    return kept;
  }

  // Each code input's drawing, for the selection changes the document hears.
  const codeDrawings = new WeakMap();
  document.addEventListener("selectionchange", () => {
    codeDrawings.get(document.activeElement)?.();
  });

  // Draws a code field's input in its cells as the server reads it, and takes no more
  // letters or digits than it has cells, so what is drawn is what is sent.
  function watchCodes(root = document) {
    for (const input of root.querySelectorAll(".code > .in")) {
      const cells = [...input.parentElement.querySelectorAll(".cell")];
      const fit = () => {
        if (codeCharactersIn(input.value) <= cells.length) return;
        const caret = input.selectionEnd ?? input.value.length;
        input.value = fitCode(input.value, cells.length);
        const at = Math.min(caret, input.value.length);
        input.setSelectionRange(at, at);
      };
      const draw = () => {
        const { value } = input;
        const typed = [...value].filter(isCodeCharacter).join("").toUpperCase();
        const focused = document.activeElement === input;
        const from = codeCharactersIn(value.slice(0, input.selectionStart ?? value.length));
        const to = codeCharactersIn(value.slice(0, input.selectionEnd ?? value.length));
        const at = focused && from === to ? Math.min(from, cells.length - 1) : -1;
        cells.forEach((cell, index) => {
          cell.textContent = typed[index] ?? "";
          cell.classList.toggle("at", index === at);
          cell.classList.toggle("end", index === at && from === cells.length);
          cell.classList.toggle("picked", focused && index >= from && index < to);
        });
      };
      input.addEventListener("beforeinput", (event) => {
        if (!event.inputType.startsWith("insert") || event.isComposing) return;
        const data = event.data ?? event.dataTransfer?.getData("text/plain") ?? "";
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        const kept = input.value.slice(0, start) + input.value.slice(end);
        const fitted = fitCode(data, cells.length - codeCharactersIn(kept));
        if (fitted === data) return;
        event.preventDefault();
        input.setRangeText(fitted, start, end, "end");
        draw();
      });
      input.addEventListener("input", () => {
        fit();
        draw();
      });
      for (const kind of ["focus", "blur", "select", "selectionchange"]) {
        input.addEventListener(kind, draw);
      }
      codeDrawings.set(input, draw);
      fit();
      draw();
    }
  }

  // A computer puts the cursor in the first field to fill. A phone waits for a tap, because
  // focus would raise the keyboard over the page before it is read.
  function focusFirstField() {
    if (!matchMedia("(pointer: fine)").matches) return;
    if (document.querySelector("dialog[open]")) return;
    const fields = [...document.querySelectorAll("main .in")].filter(
      (field) => !field.disabled && !field.readOnly && field.offsetParent !== null,
    );
    const target =
      fields.find((field) => field.getAttribute("aria-invalid") === "true") ??
      fields.find((field) => field.value === "");
    target?.focus();
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

  // WebAuthn takes ArrayBuffers; the server's JSON carries base64url.
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

  /** Asks for a passkey challenge, which the server keeps for one answer. */
  async function askForOptions(path) {
    try {
      const response = await fetch(path, {
        method: "POST",
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
    const asked = await askForOptions("/auth/passkeys/sign-in/options");
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
  async function withRecentSignIn(send, opening) {
    const answer = await send();
    if (answer && dialog && (await isRecentSignInRefusal(answer.response))) {
      if (await confirmItsYou(opening)) return send();
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
    const authorization = new URLSearchParams(location.search).get("authorization");
    if (authorization) query.set("authorization", authorization);
    location.assign("/auth/sign-in?" + query);
  }

  const webauthn = {
    async "sign-in"(button) {
      setBusy([button], true);
      try {
        const response = await askForAssertion();
        if (!response) return;
        const answer = await postJson("/auth/passkeys/sign-in", {
          response,
        });
        if (answer && answer.status === 200) location.assign(returnTo() || "/");
        else goBackToSignIn();
      } catch {
        goBackToSignIn();
      } finally {
        setBusy([button], false);
      }
    },

    async confirm(button) {
      setBusy([button], true);
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
        setBusy([button], false);
      }
    },

    async add(button) {
      setBusy([button], true);
      showPasskeyError("");
      try {
        const asked = await withRecentSignIn(
          () => askForOptions("/auth/passkeys/registration/options"),
          button,
        );
        if (!asked) return;
        if (asked.status !== 200) {
          showPasskeyError(asked.body?.error?.message ?? SOMETHING_WENT_WRONG);
          return;
        }
        const response = await askForRegistration(asked.body);
        if (!response) return;
        const field = document.getElementById("passkey-name");
        const name = field.value.trim();
        const answer = await postJson("/auth/passkeys/registration", {
          ...(name ? { name } : {}),
          response,
        });
        if (answer && answer.status === 201) location.reload();
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
        setBusy([button], false);
      }
    },
  };

  // A browser refuses a passkey at an IP address.
  function addressTakesPasskeys() {
    return !/^(\[.*\]|\d+\.\d+\.\d+\.\d+)$/.test(location.hostname);
  }

  function watchPasskeys(root = document) {
    if (!window.PublicKeyCredential || !addressTakesPasskeys()) return;
    for (const button of root.querySelectorAll("[data-passkey]")) {
      button.hidden = false;
      const group = button.closest("[data-passkey-group]");
      if (group) group.hidden = false;
      button.addEventListener("click", () => {
        void webauthn[button.dataset.passkey](button);
      });
    }
  }

  async function removePasskey(button) {
    setBusy([button], true);
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
    }, button);
    if (answer && answer.status === 200) location.reload();
    else if (answer !== null) showPasskeyError(SOMETHING_WENT_WRONG);
    setBusy([button], false);
  }

  function rowOf(element) {
    return element.closest("li");
  }

  function openRename(button) {
    showPasskeyError("");
    const row = rowOf(button);
    row.querySelector("[data-passkey-actions]").hidden = true;
    const form = row.querySelector("[data-passkey-rename-form]");
    form.hidden = false;
    const field = form.elements.name;
    field.focus();
    field.select();
  }

  function closeRename(form) {
    const row = rowOf(form);
    form.hidden = true;
    row.querySelector("[data-passkey-actions]").hidden = false;
    row.querySelector("[data-passkey-rename]").focus();
  }

  async function renamePasskey(form) {
    const name = form.elements.name.value.trim();
    if (!name) {
      showPasskeyError("Enter a name for the passkey.");
      return;
    }
    const save = form.querySelector("button[type=submit]");
    const opening = form.contains(document.activeElement) ? document.activeElement : save;
    setBusy([save], true);
    showPasskeyError("");
    const answer = await withRecentSignIn(async () => {
      const response = await fetch("/owner/passkeys/" + form.dataset.passkeyRenameForm, {
        method: "PATCH",
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }).catch(() => null);
      return response && { response, status: response.status };
    }, opening);
    if (answer && answer.status === 200) location.reload();
    else if (answer !== null) {
      const body = answer ? await answer.response.json().catch(() => null) : null;
      showPasskeyError(
        answer?.status === 400 && body?.error?.message
          ? body.error.message
          : SOMETHING_WENT_WRONG,
      );
    }
    setBusy([save], false);
  }

  function watchPasskeyRenames(root = document) {
    for (const button of root.querySelectorAll("[data-passkey-rename]")) {
      button.addEventListener("click", () => openRename(button));
    }
    for (const form of root.querySelectorAll("[data-passkey-rename-form]")) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void renamePasskey(form);
      });
      form
        .querySelector("[data-passkey-rename-cancel]")
        .addEventListener("click", () => closeRename(form));
    }
  }

  function watchPasskeyRemovals(root = document) {
    for (const button of root.querySelectorAll("[data-passkey-remove]")) {
      button.addEventListener("click", () => void removePasskey(button));
    }
  }

  function watchChoices(root = document) {
    const choose = root.querySelector("[data-needs-choice]");
    const radios = root.querySelectorAll("input[name=access]");
    const sync = () => {
      if (choose) {
        const picked = root.querySelector("input[name=access]:checked");
        choose.classList.toggle("open", picked?.value === "choose");
      }
      for (const list of root.querySelectorAll("[data-types-list]")) {
        const all = root.querySelector("select[data-types-switch]");
        list.classList.toggle("open", all?.value === "choose-types");
      }
    };
    for (const radio of radios) radio.addEventListener("change", sync);
    for (const select of root.querySelectorAll("select[data-types-switch]")) {
      select.addEventListener("change", sync);
    }
    sync();
  }

  /** One switch turns every permission on or off; each still posts on its own. */
  function watchPowers(root = document) {
    for (const group of root.querySelectorAll("[data-powers]")) {
      const all = group.querySelector("[data-powers-all]");
      const each = [...group.querySelectorAll("[data-powers-each] input[name=scopes]")];
      if (!all || each.length === 0) continue;
      all.hidden = false;
      const sync = () => {
        const on = each.filter((input) => input.checked).length;
        all.checked = on === each.length;
        all.indeterminate = on > 0 && on < each.length;
      };
      all.addEventListener("change", () => {
        for (const input of each) input.checked = all.checked;
        sync();
      });
      for (const input of each) input.addEventListener("change", sync);
      sync();
    }
  }

  // Everything a page's content needs, run on the first page and on each page swapped in.
  function watchPage(root = document) {
    watchChoices(root);
    watchPowers(root);
    watchChanges(root);
    watchForms(root);
    watchPasskeys(root);
    watchPasskeyRemovals(root);
    watchPasskeyRenames(root);
    watchCodes(root);
    focusFirstField();
  }

  exchangeHandoff();
  watchDialog();
  watchPage();
})();
