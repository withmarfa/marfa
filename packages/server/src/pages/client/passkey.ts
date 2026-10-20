/**
 * Adding a passkey. The browser makes the credential and keeps it in the
 * authenticator; the page only carries the two requests the server's passkey
 * door answers, and shows what came back. The setup sequence and the console's
 * Password and passkeys page both add one through {@link registerPasskey}.
 */
import { sendConfirmed, type Proof } from "./confirm.js";
import { hideNotices, showNotice } from "./notice.js";
import { SETUP_WORDS } from "../setup-words.js";

interface CreationStatics {
  parseCreationOptionsFromJSON?: (
    options: unknown,
  ) => PublicKeyCredentialCreationOptions;
}

interface Answer {
  status: number;
  body: { message?: unknown; error?: { message?: unknown } } | null;
}

const WHY = "To add a passkey, confirm it's you.";

function fetchJson(path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** The answer to a change sent through the dialog, or `null` when the person cancelled it. */
async function answer(
  send: (confirmedWith?: Proof) => Promise<Response>,
): Promise<Answer | null> {
  const response = await sendConfirmed(send, WHY);
  if (response === null) return null;
  return {
    status: response.status,
    body: (await response.json().catch(() => null)) as Answer["body"],
  };
}

const request = (path: string, body?: unknown): Promise<Answer | null> =>
  answer(() => fetchJson(path, body));

const OPTIONS = "/auth/passkey/generate-register-options";
const VERIFY = "/auth/passkey/verify-registration";

/**
 * A new credential from the server's options: the credential, the server's
 * refusal of the options, or `null` when the person cancelled a confirmation.
 */
async function createCredential(
  parse: (options: unknown) => PublicKeyCredentialCreationOptions,
): Promise<PublicKeyCredential | Answer | null> {
  const options = await request(OPTIONS);
  if (options?.status !== 200) return options;
  const credential = await navigator.credentials.create({
    publicKey: parse(options.body),
  });
  if (!(credential instanceof PublicKeyCredential))
    throw new Error("No passkey was made");
  return credential;
}

function refusalText(answer: Answer): string {
  const text = answer.body?.error?.message ?? answer.body?.message;
  return typeof text === "string" && text !== ""
    ? text
    : SETUP_WORDS.somethingWrong;
}

/** What came of an attempt to add a passkey. */
export type PasskeyResult =
  /** The server holds the passkey. */
  | { kind: "added" }
  /** The person cancelled the "Confirm it's you" dialog, so nothing was sent again. */
  | { kind: "cancelled" }
  /** The server refused, and `message` is what it said. */
  | { kind: "refused"; message: string }
  /** The browser could not make the passkey, or the server could not be reached. */
  | { kind: "failed"; message: string };

/** Whether this browser can make a passkey at this address. */
export function passkeysSupported(): boolean {
  const statics = (globalThis as { PublicKeyCredential?: CreationStatics })
    .PublicKeyCredential;
  return window.isSecureContext && !!statics?.parseCreationOptionsFromJSON;
}

/**
 * Add a passkey: the server's options, the browser's credential, and the
 * server's check of it. A change that needs a recent sign-in opens the
 * "Confirm it's you" dialog. `name` is what the owner calls the passkey.
 */
export async function registerPasskey(name?: string): Promise<PasskeyResult> {
  const statics = (globalThis as { PublicKeyCredential?: CreationStatics })
    .PublicKeyCredential;
  if (!window.isSecureContext || !statics?.parseCreationOptionsFromJSON)
    return { kind: "failed", message: SETUP_WORDS.somethingWrong };
  const parse = statics.parseCreationOptionsFromJSON.bind(statics);
  try {
    const made = await createCredential(parse);
    if (made === null) return { kind: "cancelled" };
    if (!(made instanceof PublicKeyCredential))
      return { kind: "refused", message: refusalText(made) };
    let credential = made;
    // A confirmation answered with a passkey replaces the challenge this
    // registration was made for, so it starts again from its options. One
    // answered with the password leaves the credential good to send.
    const verified = await answer(async (confirmedWith) => {
      if (confirmedWith === "passkey") {
        const next = await createCredential(parse);
        if (!(next instanceof PublicKeyCredential))
          throw new Error("The passkey could not be made again");
        credential = next;
      }
      return fetchJson(VERIFY, {
        response: credential.toJSON(),
        ...(name === undefined ? {} : { name }),
      });
    });
    if (verified === null) return { kind: "cancelled" };
    if (verified.status !== 200)
      return { kind: "refused", message: refusalText(verified) };
    return { kind: "added" };
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    return {
      kind: "failed",
      message:
        name === "NotAllowedError" || name === "AbortError"
          ? "The passkey request was cancelled or timed out. You can try again."
          : name === "SecurityError"
            ? "Passkeys work only at the address Marfa is set up on, and not at an IP address. Open Marfa at that address and try again."
            : error instanceof TypeError
              ? SETUP_WORDS.network
              : SETUP_WORDS.somethingWrong,
    };
  }
}

/** Adding a passkey in the setup sequence. */
export function initPasskey(): void {
  const root = document.querySelector<HTMLElement>("[data-passkey]");
  const add = root?.querySelector<HTMLButtonElement>(
    '[data-hook="passkey-add"]',
  );
  if (!root || !add) return;
  if (!passkeysSupported()) {
    showNotice(root, "unsupported");
    return;
  }
  add.hidden = false;
  add.addEventListener("click", () => {
    void (async () => {
      hideNotices(root);
      add.disabled = true;
      add.classList.add("is-loading");
      const idle = add.lastChild?.textContent ?? "";
      const waiting = add.dataset.loadingLabel;
      if (waiting && add.lastChild) add.lastChild.textContent = waiting;
      try {
        const result = await registerPasskey();
        if (result.kind === "cancelled") return;
        if (result.kind !== "added") {
          showNotice(root, "error", result.message);
          return;
        }
        root
          .querySelector<HTMLElement>("[data-passkey-ask]")
          ?.setAttribute("hidden", "");
        const added = root.querySelector<HTMLElement>("[data-passkey-added]");
        if (added) {
          added.hidden = false;
          added.querySelector<HTMLElement>("a")?.focus();
        }
      } finally {
        add.disabled = false;
        add.classList.remove("is-loading");
        if (add.lastChild) add.lastChild.textContent = idle;
      }
    })();
  });
}
