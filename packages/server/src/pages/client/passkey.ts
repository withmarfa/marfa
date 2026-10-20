/**
 * Adding a passkey in the setup sequence. The browser makes the credential and
 * keeps it in the authenticator; the page only carries the two requests the
 * server's passkey door answers, and shows what came back.
 */
import { sendConfirmed } from "./confirm.js";
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
async function answer(send: () => Promise<Response>): Promise<Answer | null> {
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

export function initPasskey(): void {
  const root = document.querySelector<HTMLElement>("[data-passkey]");
  const add = root?.querySelector<HTMLButtonElement>(
    '[data-hook="passkey-add"]',
  );
  if (!root || !add) return;
  const statics = (globalThis as { PublicKeyCredential?: CreationStatics })
    .PublicKeyCredential;
  if (!window.isSecureContext || !statics?.parseCreationOptionsFromJSON) {
    showNotice(root, "unsupported");
    return;
  }
  const parse = statics.parseCreationOptionsFromJSON.bind(statics);
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
        const made = await createCredential(parse);
        if (made === null) return;
        if (!(made instanceof PublicKeyCredential)) {
          showNotice(root, "error", refusalText(made));
          return;
        }
        let credential = made;
        let confirmed = false;
        // A confirmation answered with a passkey replaces the challenge this
        // registration was made for, so it starts again from its options.
        const verified = await answer(async () => {
          if (confirmed) {
            const next = await createCredential(parse);
            if (!(next instanceof PublicKeyCredential))
              throw new Error("The passkey could not be made again");
            credential = next;
          }
          confirmed = true;
          return fetchJson(VERIFY, { response: credential.toJSON() });
        });
        if (verified === null) return;
        if (verified.status !== 200) {
          showNotice(root, "error", refusalText(verified));
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
      } catch (error) {
        const cancelled =
          error instanceof DOMException &&
          (error.name === "NotAllowedError" || error.name === "AbortError");
        showNotice(
          root,
          "error",
          cancelled
            ? "The passkey request was cancelled or timed out. You can try again."
            : error instanceof TypeError
              ? SETUP_WORDS.network
              : SETUP_WORDS.somethingWrong,
        );
      } finally {
        add.disabled = false;
        add.classList.remove("is-loading");
        if (add.lastChild) add.lastChild.textContent = idle;
      }
    })();
  });
}
