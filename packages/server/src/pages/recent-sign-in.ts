/**
 * How a door tells a browser that its sign-in is too old for the change, and
 * how the page knows it was told. The server and the browser module read the
 * same definition, so the refusal cannot be reworded on one side only.
 */

/** How long after a browser session was created a change that needs a recent sign-in is still allowed. */
export const RECENT_SIGN_IN_MS = 300_000;

/** The message of the `403 forbidden` a door answers when the sign-in is too old. */
export const SIGN_IN_AGAIN_MESSAGE = "Sign in again to perform this operation";

/** Whether an answer is the refusal for a sign-in that is too old. */
export function isSignInAgainRefusal(status: number, body: unknown): boolean {
  if (status !== 403 || body === null || typeof body !== "object") return false;
  const error = (body as { error?: unknown }).error;
  if (error === null || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === "forbidden" && message === SIGN_IN_AGAIN_MESSAGE;
}

/** What `POST /auth/confirm` says when it refuses, which the dialog tells apart. */
export const CONFIRM_REFUSALS = {
  password: "That password is wrong.",
  passkey: "That passkey could not be verified.",
  /** No signed-in owner session holds the request, so there is nothing to renew. */
  noSession: "Sign in as the owner to continue.",
} as const;
