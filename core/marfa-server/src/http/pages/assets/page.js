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
      const body = await response.json().catch(() => null);
      return {
        status: response.status,
        retryAfter: Number(response.headers.get("retry-after")),
        body,
        field: body?.error?.details?.field,
      };
    } catch {
      return null;
    }
  }

  // Restore focus once the opener is enabled.
  const openers = new WeakMap();
  let opener = null;

  function giveFocusBack() {
    if (confirmDialog()?.open || !opener || !opener.isConnected || opener.disabled) return;
    opener.focus();
    opener = null;
  }

  /** Where focus goes in a dialog on a phone in place of a field: its title, read first. */
  function titleOf(dialog) {
    const title = dialog.querySelector("h2");
    title.tabIndex = -1;
    return title;
  }

  // Keep the software keyboard closed when a touch dialog opens.
  function openModal(dialog, from, first) {
    openers.set(dialog, from ?? document.activeElement);
    const fine = matchMedia("(pointer: fine)").matches;
    const field = first instanceof HTMLInputElement;
    const target = fine || (first && !field) ? first : titleOf(dialog);
    // The dialog's own focusing reads `autofocus`, so nothing else is focused first.
    target?.setAttribute("autofocus", "");
    dialog.showModal();
    target?.removeAttribute("autofocus");
    if (fine && field) first.select();
  }

  /** A session that ended, such as by signing out in another tab, signs in again and comes back. */
  function signInAgain() {
    location.assign("/auth/sign-in?" + new URLSearchParams({ return_to: location.pathname + location.search }));
  }

  function watchFocusBack() {
    for (const dialog of document.querySelectorAll("dialog")) {
      if (!bindOnce("focus-back", dialog)) continue;
      dialog.addEventListener("close", () => {
        opener = openers.get(dialog) ?? null;
        giveFocusBack();
      });
      dialog.addEventListener("cancel", (event) => {
        if (dialog.dataset.busy) event.preventDefault();
      });
      for (const cancel of cancelsOf(dialog)) {
        cancel.addEventListener("click", () => dialog.close());
      }
    }
  }

  /** The buttons that send a form, including ones elsewhere in the page that name it with `form`. */
  function submitsOf(form) {
    return [...form.elements].filter((element) => element.type === "submit");
  }

  function cancelsOf(sheet) {
    return [...sheet.querySelectorAll("[data-dialog-cancel]")];
  }

  /**
   * Disables buttons while their request is open, and gives focus back when it ends. A dialog
   * they sit in does not close on Escape meanwhile.
   */
  function setBusy(buttons, busy) {
    for (const button of buttons) button.disabled = busy;
    const sheet = buttons[0]?.closest("dialog");
    if (sheet) {
      if (busy) sheet.dataset.busy = "true";
      else delete sheet.dataset.busy;
    }
    if (!busy) giveFocusBack();
  }

  /** "2 minutes" for a wait in seconds, as the pages say it. */
  function waitWords(seconds) {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return minutes + (minutes === 1 ? " minute" : " minutes");
  }

  /** A line under a group: its hint, or a problem which takes the hint's place. */
  function showNote(note, problem, ...fields) {
    note.className = problem ? "err" : "hint";
    note.textContent = problem || note.dataset.hint;
    for (const field of fields) {
      if (problem) field.setAttribute("aria-invalid", "true");
      else field.removeAttribute("aria-invalid");
    }
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
      reveal("[data-hint]", false);
      const late = document.querySelector("[data-late-problem]");
      if (!late) return;
      late.hidden = false;
      document.getElementById("code")?.setAttribute("aria-describedby", late.id);
    });
  }

  // A page drawn again brings its own dialog, so the dialog is looked up each time.
  function confirmDialog() {
    return document.getElementById("confirm-dialog");
  }

  function confirmParts() {
    const dialog = confirmDialog();
    return {
      dialog,
      note: dialog.querySelector("[data-note]"),
      password: dialog.querySelector("#confirm-password"),
      fields: dialog.querySelector("[data-confirm-fields]"),
      title: dialog.querySelector("h2"),
      lede: dialog.querySelector("#confirm-text"),
      submit: dialog.querySelector("[data-confirm-submit]"),
    };
  }

  // The words each dialog was drawn with, kept before a use changes them.
  const confirmDefaults = new WeakMap();

  // Each watcher binds an element once, so every watcher can run again after a redraw.
  const bound = new Map();
  function bindOnce(kind, element) {
    if (!element) return false;
    if (!bound.has(kind)) bound.set(kind, new WeakSet());
    const seen = bound.get(kind);
    if (seen.has(element)) return false;
    seen.add(element);
    return true;
  }

  const MISMATCH = "The passwords don’t match.";

  // A form that asks for a password twice compares them as it is sent, so what was typed stays.
  function watchRepeatedPasswords() {
    for (const form of document.querySelectorAll("#owner-form, #recover-form")) {
      if (!bindOnce("repeated", form)) continue;
      const password = form.elements.namedItem("password");
      const confirm = form.elements.namedItem("confirm_password");
      const note = document.getElementById(password.getAttribute("aria-describedby"));
      const before = { className: note.className, text: note.textContent };
      const settle = () => {
        if (confirm.getAttribute("aria-invalid") !== "true" || confirm.dataset.mismatch !== "true") return;
        delete confirm.dataset.mismatch;
        confirm.removeAttribute("aria-invalid");
        note.className = before.className;
        note.textContent = before.text;
        note.removeAttribute("role");
      };
      password.addEventListener("input", settle);
      confirm.addEventListener("input", settle);
      form.addEventListener("submit", (event) => {
        if (password.value === confirm.value) return;
        event.preventDefault();
        confirm.dataset.mismatch = "true";
        confirm.setAttribute("aria-invalid", "true");
        note.className = "err";
        note.setAttribute("role", "alert");
        note.textContent = MISMATCH;
        confirm.focus();
      });
    }
  }

  const SOMETHING_WENT_WRONG = "Something went wrong. Try again.";

  // What the dialog is being used for now. `run` sends the request the owner is confirming. A
  // `plain` use asks for a yes alone, and turns to the password when the server wants one.
  let confirming = null;

  function showConfirmError(kind, waitSeconds) {
    const { note, password, lede } = confirmParts();
    const passkeys = document.querySelector('[data-passkey="confirm"]');
    const messages = {
      empty: "Enter your password.",
      password: "That password isn’t right.",
      locked:
        "Too many attempts. Try again in " +
        waitWords(waitSeconds) +
        (passkeys && !passkeys.hidden ? ", or use a passkey." : "."),
      other: SOMETHING_WENT_WRONG,
    };
    const message = messages[kind] ?? "";
    if (confirming?.plain) {
      lede.textContent = message || confirming.lede;
      lede.classList.toggle("err", Boolean(message));
      return;
    }
    showNote(note, message);
    if (kind === "password" || kind === "empty") {
      password.setAttribute("aria-invalid", "true");
    } else password.removeAttribute("aria-invalid");
    if (message) password.setAttribute("aria-describedby", note.id);
    else password.removeAttribute("aria-describedby");
  }

  /** A plain yes sends no password, so the field takes part only once the server asks for one. */
  function showPasswordField(shown) {
    const { fields, password } = confirmParts();
    fields.hidden = !shown;
    password.disabled = !shown;
  }

  /** Turns a plain yes into a request for the password, and says where focus goes next. */
  function askForPassword(use) {
    const { dialog, password, lede } = confirmParts();
    use.plain = false;
    showConfirmError("none", 0);
    use.lede = use.passwordLede || use.lede;
    lede.textContent = use.lede;
    lede.classList.remove("err");
    showPasswordField(true);
    return matchMedia("(pointer: fine)").matches ? password : titleOf(dialog);
  }

  // Every control that answers the dialog waits for the answer to the one already sent.
  function confirmControls() {
    const { dialog, fields, password } = confirmParts();
    return [...dialog.querySelectorAll("button"), ...(fields.hidden ? [] : [password])];
  }

  // Ignore a reply after the dialog has moved to another action or been drawn again.
  async function answering(step) {
    const use = confirming;
    const { dialog } = confirmParts();
    const current = () => confirming === use && dialog.isConnected && dialog.open;
    const controls = confirmControls();
    setBusy(controls, true);
    let next = null;
    try {
      next = await step(use, current);
    } finally {
      if (confirming === use) setBusy(controls, false);
    }
    if (current()) next?.focus();
  }

  async function confirmed(use, current) {
    if (use.run) {
      const result = await use.run();
      if (!current()) return null;
      if (result.ended) return signInAgain();
      if (!result.ok) {
        showConfirmError("other", 0);
        return confirmParts().submit;
      }
    }
    confirmDialog().close("confirmed");
    return null;
  }

  function submitConfirmation() {
    return answering(async (use, current) => {
      const { dialog, password, submit } = confirmParts();
      showConfirmError("none", 0);
      if (use.plain) {
        const result = await use.run();
        if (!current()) return null;
        if (result.ok) dialog.close("confirmed");
        else if (result.ended) signInAgain();
        else if (result.recentSignIn) return askForPassword(use);
        else {
          showConfirmError("other", 0);
          return submit;
        }
        return null;
      }
      if (!password.value) {
        showConfirmError("empty", 0);
        return password;
      }
      const answer = await postJson("/auth/confirm", { password: password.value });
      if (!current()) return null;
      password.value = "";
      if (answer?.status === 200) return confirmed(use, current);
      if (answer?.status === 401 && answer.field === "password") {
        showConfirmError("password", 0);
      } else if (answer?.status === 401) {
        signInAgain();
        return null;
      } else if (answer?.status === 429) {
        showConfirmError("locked", answer.retryAfter || 60);
      } else showConfirmError("other", 0);
      return password;
    });
  }

  /**
   * Resolves true once the owner has confirmed, false if they gave up. The words default to
   * the ones the page drew; `title` is a list of nodes, so a name can sit in `bdi`.
   */
  function confirmItsYou(options = {}, from) {
    const { dialog, password, title, lede, submit } = confirmParts();
    const defaults = confirmDefaults.get(dialog);
    return new Promise((resolve) => {
      const words = options.lede ?? defaults.lede;
      confirming = {
        run: options.run ?? null,
        plain: Boolean(options.plain),
        lede: words,
        passwordLede: options.passwordLede ?? "",
      };
      title.replaceChildren(...(options.title ?? defaults.title));
      lede.textContent = words;
      lede.classList.remove("err");
      submit.textContent = options.button ?? defaults.button;
      submit.classList.toggle("danger", Boolean(options.danger));
      submit.classList.toggle("primary", !options.danger);
      for (const button of dialog.querySelectorAll("button")) button.disabled = false;
      delete dialog.dataset.busy;
      showPasswordField(!confirming.plain);
      password.value = "";
      showConfirmError("none", 0);
      dialog.addEventListener(
        "close",
        () => resolve(dialog.returnValue === "confirmed"),
        { once: true },
      );
      dialog.returnValue = "";
      openModal(dialog, from, confirming.plain ? submit : password);
    });
  }

  async function isRecentSignInRefusal(response) {
    if (response.status !== 403) return false;
    const body = await response.clone().json().catch(() => null);
    return body?.error?.details?.needs === "recent_sign_in";
  }

  // A form marked data-change is sent with fetch; a stale sign-in opens the dialog and the
  // change is resent after confirming. A page that comes back replaces this one, and a form
  // marked data-page asks only for a page.
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
          accept: form.hasAttribute("data-page") ? "text/html" : "application/json, text/html",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      }).catch(() => null);

    let response = await send();
    if (response && confirmDialog() && (await isRecentSignInRefusal(response))) {
      if (await confirmItsYou({}, opening)) response = await send();
    }
    if (response?.status === 401 && !form.hasAttribute("data-page")) {
      signInAgain();
      return;
    }
    const text = response ? await response.text() : "";
    const isPage = (response?.headers.get("content-type") ?? "").includes(
      "text/html",
    );
    // A page comes back whatever its status, such as one drawn again after a conflict.
    if (isPage) {
      showPage(text);
      return;
    }
    const answer = (() => {
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
      if (done) {
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
    const dialog = confirmDialog();
    const incomingDialog = next.content.querySelector("#confirm-dialog");
    if (incomingDialog && dialog) dialog.replaceWith(incomingDialog);
    else if (incomingDialog) main.after(incomingDialog);
    else if (dialog) dialog.remove();
    watchPage();
    window.scrollTo(0, 0);
  }

  function watchChanges() {
    for (const form of document.querySelectorAll("form[data-change]")) {
      if (!bindOnce("change", form)) continue;
      form.addEventListener("submit", (event) => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        const buttons = submitsOf(form);
        const sending = sendChange(form, event.submitter);
        setBusy(buttons, true);
        sending.finally(() => setBusy(buttons, false));
      });
    }
  }

  // A form the browser sends keeps its buttons disabled until the answer, or the cached page, returns.
  function watchForms() {
    for (const form of document.querySelectorAll(
      "form:not([data-change], [data-handled], [method=dialog])",
    )) {
      if (!bindOnce("form", form)) continue;
      form.addEventListener("submit", (event) => {
        if (event.defaultPrevented) return;
        const buttons = submitsOf(form);
        // The browser reads the form after this event, so a submitter disabled now would not be sent.
        setTimeout(() => setBusy(buttons, true));
      });
    }
  }

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

  /** The offset in `text` just after its `count`th letter or digit. */
  function offsetAfterCodeCharacters(text, count) {
    if (count <= 0) return 0;
    let seen = 0;
    let offset = 0;
    for (const character of text) {
      offset += character.length;
      if (isCodeCharacter(character)) {
        seen += 1;
        if (seen === count) return offset;
      }
    }
    return text.length;
  }

  // Each code input's drawing, for the selection changes the document hears.
  const codeDrawings = new WeakMap();
  document.addEventListener("selectionchange", () => {
    codeDrawings.get(document.activeElement)?.();
  });

  // Draws a code field's input in its cells as the server reads it, and takes no more
  // letters or digits than it has cells, so what is drawn is what is sent. A value that
  // arrives with more than the cells hold stays as it is, in the plain input.
  function watchCodes() {
    for (const input of document.querySelectorAll(".code > .in")) {
      if (!bindOnce("code", input)) continue;
      const cells = [...input.parentElement.querySelectorAll(".cell")];
      if (codeCharactersIn(input.value) > cells.length) {
        input.parentElement.classList.add("plain");
        continue;
      }
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
      // The input's own text does not sit where the cells do, so the pointer chooses a place
      // between the cells, and a drag extends from there.
      const placeAt = (clientX) => {
        const typed = codeCharactersIn(input.value);
        let place = 0;
        for (const cell of cells) {
          const box = cell.getBoundingClientRect();
          if (clientX > box.left + box.width / 2) place += 1;
        }
        return offsetAfterCodeCharacters(input.value, Math.min(place, typed));
      };
      input.addEventListener("mousedown", (event) => {
        if (event.button !== 0 || input.disabled) return;
        event.preventDefault();
        input.focus();
        if (event.detail >= 2) {
          input.select();
          return;
        }
        const anchor = placeAt(event.clientX);
        input.setSelectionRange(anchor, anchor);
        draw();
        const drag = (move) => {
          const head = placeAt(move.clientX);
          input.setSelectionRange(
            Math.min(anchor, head),
            Math.max(anchor, head),
            head < anchor ? "backward" : "forward",
          );
          draw();
        };
        const drop = () => {
          document.removeEventListener("mousemove", drag);
          document.removeEventListener("mouseup", drop);
        };
        document.addEventListener("mousemove", drag);
        document.addEventListener("mouseup", drop);
      });
      codeDrawings.set(input, draw);
      draw();
    }
  }

  addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    for (const button of document.querySelectorAll("button[type=submit]")) {
      button.disabled = false;
    }
  });

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
    const dialog = confirmDialog();
    if (!bindOnce("dialog", dialog)) return;
    const { title, lede, submit } = confirmParts();
    confirmDefaults.set(dialog, {
      title: [...title.childNodes],
      lede: lede.textContent,
      button: submit.textContent,
    });
    const form = dialog.querySelector("form");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitConfirmation();
    });
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

  const CANCELLED = Symbol("cancelled");

  /** Sends a request again once the owner confirms an old sign-in. */
  async function withRecentSignIn(send, from) {
    const answer = await send();
    if (answer && confirmDialog() && (await isRecentSignInRefusal(answer.response))) {
      if (await confirmItsYou({}, from)) return send();
      return CANCELLED;
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

  // A rejected passkey and an ended session both answer 401.
  async function sessionEnded() {
    const response = await fetch("/owner/passkeys", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    }).catch(() => null);
    return response?.status === 401;
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

    confirm(button) {
      return answering(async (use, current) => {
        showConfirmError("none", 0);
        try {
          const passkey = await askForAssertion();
          if (!passkey || !current()) return button;
          const answer = await postJson("/auth/confirm", { passkey });
          if (!current()) return null;
          if (answer?.status === 200) return confirmed(use, current);
          if (answer?.status === 401 && (await sessionEnded())) {
            if (current()) signInAgain();
            return null;
          }
          if (!current()) return null;
          showConfirmError("other", 0);
        } catch {
          if (current()) showConfirmError("other", 0);
        }
        return button;
      });
    },

    add(button) {
      const sheet = document.getElementById("add-dialog");
      const field = document.getElementById("passkey-name");
      field.value = "";
      showNote(document.getElementById("add-note"), "", field);
      openModal(sheet, button, field);
    },
  };

  // A browser refuses a passkey at an IP address, and anywhere that is not HTTPS or localhost.
  function addressTakesPasskeys() {
    return window.isSecureContext && !/^(\[.*\]|\d+\.\d+\.\d+\.\d+)$/.test(location.hostname);
  }

  function watchPasskeys() {
    const reason = !addressTakesPasskeys()
      ? "address"
      : !window.PublicKeyCredential
        ? "browser"
        : "";
    if (reason) {
      reveal('[data-passkey-unavailable="' + reason + '"]', true);
      return;
    }
    for (const button of document.querySelectorAll("[data-passkey]")) {
      if (!bindOnce("passkey", button)) continue;
      button.hidden = false;
      const group = button.closest("[data-passkey-group]");
      if (group) group.hidden = false;
      button.addEventListener("click", () => {
        void webauthn[button.dataset.passkey](button);
      });
    }
    for (const advice of document.querySelectorAll("[data-passkey-advice]")) {
      advice.hidden = false;
    }
  }

  /** The add dialog: a name, then the browser's own prompt, then the server keeps the passkey. */
  function watchAddDialog() {
    const sheet = document.getElementById("add-dialog");
    if (!bindOnce("add", sheet)) return;
    const form = sheet.querySelector("form");
    const field = document.getElementById("passkey-name");
    const note = document.getElementById("add-note");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const buttons = [...submitsOf(form), ...cancelsOf(sheet)];
      showNote(note, "", field);
      setBusy(buttons, true);
      let leaving = false;
      try {
        const asked = await withRecentSignIn(
          () => askForOptions("/auth/passkeys/registration/options"),
          event.submitter,
        );
        if (asked === CANCELLED) return;
        if (asked?.status === 401) {
          signInAgain();
          return;
        }
        if (!asked || asked.status !== 200) {
          showNote(note, asked?.body?.error?.message ?? SOMETHING_WENT_WRONG, field);
          return;
        }
        const response = await askForRegistration(asked.body);
        if (!response) return;
        const name = field.value.trim();
        const answer = await postJson("/auth/passkeys/registration", {
          ...(name ? { name } : {}),
          response,
        });
        if (answer && answer.status === 201) {
          leaving = true;
          location.reload();
          return;
        }
        if (answer?.status === 401) {
          signInAgain();
          return;
        }
        showNote(note, answer?.body?.error?.message ?? SOMETHING_WENT_WRONG, field);
      } catch (error) {
        showNote(
          note,
          error.name === "InvalidStateError"
            ? "This device already has a passkey here."
            : SOMETHING_WENT_WRONG,
          field,
        );
      } finally {
        if (!leaving) setBusy(buttons, false);
      }
    });
  }

  /** Sends a change to one passkey. Null when no answer came. */
  async function sendPasskey(method, id, body) {
    const response = await fetch("/owner/passkeys/" + id, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).catch(() => null);
    return response && { response, status: response.status };
  }

  /** Shows a passkey's new name in its row, and in the label of the row's menu. */
  function showName(row, name) {
    row.dataset.name = name;
    row.querySelector(".name bdi").textContent = name;
    for (const labelled of row.querySelectorAll(".more, .menu")) {
      labelled.setAttribute("aria-label", "More for " + name);
    }
  }

  /** The rename dialog is shared by every row; the row it is for is kept while it is open. */
  function watchRenameDialog() {
    const sheet = document.getElementById("rename-dialog");
    if (!bindOnce("rename", sheet)) return;
    const form = sheet.querySelector("form");
    const field = document.getElementById("rename-passkey");
    const note = document.getElementById("rename-note");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = field.value.trim();
      if (!name) {
        showNote(note, "Enter a name for the passkey.", field);
        field.focus();
        return;
      }
      if (name === sheet.dataset.name) {
        sheet.close();
        return;
      }
      const id = sheet.dataset.passkey;
      const buttons = [...submitsOf(form), ...cancelsOf(sheet)];
      showNote(note, "", field);
      setBusy(buttons, true);
      try {
        const answer = await withRecentSignIn(
          () => sendPasskey("PATCH", id, { name }),
          event.submitter,
        );
        if (answer === CANCELLED) return;
        if (answer?.status === 401) {
          signInAgain();
          return;
        }
        if (answer?.status === 200) {
          const row = document.querySelector('[data-passkey-row="' + CSS.escape(id) + '"]');
          if (row) showName(row, name);
          sheet.close();
          return;
        }
        const body = answer ? await answer.response.json().catch(() => null) : null;
        showNote(
          note,
          answer?.status === 400 && body?.error?.message
            ? body.error.message
            : SOMETHING_WENT_WRONG,
          field,
        );
      } finally {
        setBusy(buttons, false);
      }
    });
  }

  function openRename(row, from) {
    const sheet = document.getElementById("rename-dialog");
    const field = document.getElementById("rename-passkey");
    sheet.dataset.passkey = row.dataset.passkeyRow;
    sheet.dataset.name = row.dataset.name;
    field.value = row.dataset.name;
    showNote(document.getElementById("rename-note"), "", field);
    openModal(sheet, from, field);
  }

  /**
   * Removing asks for a yes first. The server refuses with an old sign-in, and the same dialog
   * then asks for the password or a passkey, and sends the removal again.
   */
  async function removePasskey(row, from) {
    const name = document.createElement("bdi");
    name.textContent = row.dataset.name;
    const id = row.dataset.passkeyRow;
    const run = async () => {
      const answer = await sendPasskey("DELETE", id);
      return {
        ok: Boolean(answer && answer.response.ok),
        ended: answer?.status === 401,
        recentSignIn: Boolean(answer && (await isRecentSignInRefusal(answer.response))),
      };
    };
    const removed = await confirmItsYou(
      {
        title: ["Remove ", name, "?"],
        lede: "You can’t sign in with it again.",
        passwordLede: "Enter your password to confirm it’s you.",
        button: "Remove",
        danger: true,
        plain: true,
        run,
      },
      from,
    );
    if (removed) location.reload();
  }

  function placeMenu(menu, button) {
    const edge = 8;
    const at = button.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = menu;
    const left = Math.min(Math.max(edge, at.right - width), innerWidth - width - edge);
    const below = at.bottom + 4;
    const above = at.top - 4 - height;
    const top = below + height + edge > innerHeight && above > edge ? above : below;
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }

  function watchMenus() {
    if (!("popover" in HTMLElement.prototype)) return;
    reveal(".more[data-js]", true);
    for (const menu of document.querySelectorAll(".menu[popover]")) {
      if (!bindOnce("menu", menu)) continue;
      const button = document.querySelector('[popovertarget="' + menu.id + '"]');
      const row = menu.closest("li");
      const items = [...menu.querySelectorAll("[role=menuitem]")];
      let leave = null;
      menu.addEventListener("toggle", (event) => {
        leave?.abort();
        if (event.newState !== "open") return;
        leave = new AbortController();
        const hide = () => menu.hidePopover();
        addEventListener("scroll", hide, { passive: true, signal: leave.signal });
        addEventListener("resize", () => placeMenu(menu, button), { signal: leave.signal });
        placeMenu(menu, button);
        items[0].focus();
      });
      menu.addEventListener("keydown", (event) => {
        const at = items.indexOf(document.activeElement);
        const to = {
          ArrowDown: (at + 1) % items.length,
          ArrowUp: (at - 1 + items.length) % items.length,
          Home: 0,
          End: items.length - 1,
        }[event.key];
        if (event.key === "Tab") menu.hidePopover();
        if (to === undefined) return;
        event.preventDefault();
        items[to].focus();
      });
      menu.querySelector("[data-passkey-rename]").addEventListener("click", () => {
        menu.hidePopover();
        openRename(row, button);
      });
      menu.querySelector("[data-passkey-remove]").addEventListener("click", () => {
        menu.hidePopover();
        void removePasskey(row, button);
      });
    }
  }

  /** The password dialog: the new password is typed twice, and the page compares them. */
  function watchChangePassword() {
    const sheet = document.getElementById("change-dialog");
    const trigger = document.querySelector("[data-change-password]");
    if (!sheet || !trigger || !bindOnce("change-password", sheet)) return;
    const form = sheet.querySelector("form");
    const current = form.elements.namedItem("current_password");
    const next = form.elements.namedItem("new_password");
    const again = form.elements.namedItem("confirm_password");
    const currentNote = document.getElementById("current-note");
    const newNote = document.getElementById("new-note");
    const clear = () => {
      showNote(currentNote, "", current);
      showNote(newNote, "", next, again);
    };
    trigger.addEventListener("click", () => {
      form.reset();
      clear();
      openModal(sheet, trigger, current);
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      clear();
      if (!current.value) {
        showNote(currentNote, "Enter your current password.", current);
        current.focus();
        return;
      }
      if ([...next.value].length < 8) {
        showNote(newNote, "Use at least 8 characters.", next, again);
        next.focus();
        return;
      }
      if (next.value !== again.value) {
        showNote(newNote, "The passwords don’t match.", next, again);
        again.focus();
        return;
      }
      const buttons = [...submitsOf(form), ...cancelsOf(sheet)];
      const lock = (locked) => {
        for (const field of [current, next, again]) field.readOnly = locked;
      };
      setBusy(buttons, true);
      lock(true);
      try {
        const answer = await postJson("/auth/owner/password", {
          current_password: current.value,
          new_password: next.value,
        });
        const status = answer?.status;
        if (status === 200) {
          form.reset();
          sheet.close();
          reveal("[data-password-changed]", true);
        } else if (status === 401 && answer.field === "current_password") {
          lock(false);
          current.value = "";
          showNote(currentNote, "That password isn’t right.", current);
          current.focus();
        } else if (status === 401) {
          signInAgain();
        } else if (status === 429) {
          showNote(
            newNote,
            "Too many attempts. Try again in " + waitWords(answer.retryAfter || 60) + ".",
          );
        } else {
          showNote(newNote, SOMETHING_WENT_WRONG);
        }
      } finally {
        lock(false);
        setBusy(buttons, false);
      }
    });
  }

  // Without scripts every part shows, and the server reads only what the control's value counts.
  // A part shows while its control is at `data-shown-at`, one value or several divided by `|`.
  function syncChoices() {
    for (const part of document.querySelectorAll("[data-shown-by]")) {
      const control = document.getElementById(part.dataset.shownBy);
      part.classList.toggle("open", part.dataset.shownAt.split("|").includes(control?.value));
    }
  }

  function watchChoices() {
    for (const part of document.querySelectorAll("[data-shown-by]")) {
      const control = document.getElementById(part.dataset.shownBy);
      if (bindOnce("choice", control)) control.addEventListener("change", syncChoices);
    }
    syncChoices();
  }

  // Opening Choose takes the summary away, so focus moves to the first choice.
  function watchChoose() {
    for (const details of document.querySelectorAll("details.choose")) {
      if (!bindOnce("choose", details)) continue;
      details.addEventListener("toggle", () => {
        if (details.open) details.querySelector("select")?.focus();
      });
    }
  }

  // Everything a page needs, run on the first page and again on each page swapped in.
  function watchPage() {
    watchChoices();
    watchChoose();
    watchChanges();
    watchRepeatedPasswords();
    watchForms();
    watchFocusBack();
    watchDialog();
    reveal("[data-js]:not(.more)", true);
    watchPasskeys();
    watchMenus();
    watchAddDialog();
    watchRenameDialog();
    watchChangePassword();
    watchCodes();
    focusFirstField();
  }

  exchangeHandoff();
  watchPage();
})();
