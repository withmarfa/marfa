/**
 * The words the claim and setup screens say that both the server and the
 * browser write: the server when it renders a refusal into the page, the
 * browser when a refusal comes back to a page already open. One list keeps
 * the two from saying the same thing two ways.
 */

/** The steps of the sequence: setup code, your details, passkey, name, connect, backups. */
export const SETUP_STEP_COUNT = 6;

export const SETUP_WORDS = {
  noCode: "Enter the setup code.",
  wrongCode: "That setup code isn't right. Check it and try again.",
  linkSpent:
    "That setup link has expired or was already used. Enter the setup code instead, or run marfa setup open for a new link.",
  sessionEnded:
    "Your setup session ended. Enter the setup code again to continue.",
  network: "Marfa didn't answer. Check your connection and try again.",
  somethingWrong: "Something went wrong. Try again.",
  email: "Enter your email address.",
  password: "Enter a password.",
} as const;

/** The wait a refusal for too many attempts names, in the largest whole unit that does not understate it. */
export function tooManyTries(retryAfterSeconds: number | undefined): string {
  const seconds = Number.isFinite(retryAfterSeconds)
    ? Math.max(1, retryAfterSeconds ?? 1)
    : 900;
  const minutes = Math.ceil(seconds / 60);
  if (minutes <= 1) return "Too many tries. Try again in a minute.";
  if (minutes < 60)
    return `Too many tries. Try again in ${String(minutes)} minutes.`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1
    ? "Too many tries. Try again in an hour."
    : `Too many tries. Try again in ${String(hours)} hours.`;
}
