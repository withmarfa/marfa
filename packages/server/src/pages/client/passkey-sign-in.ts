/**
 * Signing in with a passkey.
 *
 * The server renders the whole passkey block hidden, because it works only in
 * a browser that can ask for a passkey and at a secure address. This module
 * shows the block when the browser can, and otherwise shows the line that says
 * what a passkey needs. The ceremony runs against the server's own endpoints;
 * the private key never leaves the person's device.
 */
const OPTIONS = "/auth/passkey/generate-authenticate-options";
const VERIFY = "/auth/passkey/verify-authentication";

const CANCELLED =
  "The passkey request was cancelled or timed out. You can try again.";
const FAILED = "The passkey request could not be completed. Try again.";

interface AnswerBody {
  error?: { message?: string };
  message?: string;
}

function canUsePasskeys(): boolean {
  return (
    window.isSecureContext &&
    typeof PublicKeyCredential !== "undefined" &&
    typeof PublicKeyCredential.parseRequestOptionsFromJSON === "function"
  );
}

/** A path on this server, or `/`: the form's `return_to` was checked by the server, and this checks it again. */
function localPath(raw: string | undefined): string {
  return raw !== undefined && /^\/(?:[^/\\]|$)/.test(raw) ? raw : "/";
}

async function ask(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json()) as AnswerBody;
  if (!response.ok)
    throw new Error(data.error?.message ?? data.message ?? FAILED);
  return data;
}

export function initPasskeySignIn(): void {
  const block = document.querySelector<HTMLElement>("[data-passkey-signin]");
  if (!block) return;
  const unsupported = document.querySelector<HTMLElement>(
    "[data-passkey-unsupported]",
  );
  if (!canUsePasskeys()) {
    if (unsupported) unsupported.hidden = false;
    return;
  }
  block.hidden = false;

  const button = block.querySelector<HTMLButtonElement>(
    '[data-hook="passkey-signin"]',
  );
  const failure = block.querySelector<HTMLElement>("[data-passkey-error]");
  const failureText = block.querySelector<HTMLElement>(
    "[data-passkey-error-text]",
  );
  const returnTo = document.querySelector<HTMLInputElement>(
    'input[name="return_to"]',
  );
  if (!button || !failure || !failureText) return;

  const fail = (message: string): void => {
    failureText.textContent = message;
    failure.hidden = false;
    failure.focus();
  };

  button.addEventListener("click", () => {
    void (async () => {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      failure.hidden = true;
      try {
        const options = (await ask(
          OPTIONS,
        )) as PublicKeyCredentialRequestOptionsJSON;
        options.userVerification = "required";
        const credential = await navigator.credentials.get({
          publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options),
        });
        if (!(credential instanceof PublicKeyCredential))
          throw new Error("No passkey was selected. Try again.");
        await ask(VERIFY, { response: credential.toJSON() });
        location.assign(localPath(returnTo?.value));
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        fail(
          name === "NotAllowedError" || name === "AbortError"
            ? CANCELLED
            : error instanceof Error && error.message !== ""
              ? error.message
              : FAILED,
        );
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    })();
  });
}
