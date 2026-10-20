/**
 * What the owner's own pages say about the values they take: a name, an email
 * address, a password and a passkey's name. The browser checks a value with
 * these before sending it, so a person sees the problem at once; the server
 * checks the same values again and its answer is the one that counts
 * (`instance-claim/profile-input`, `authentication/passkey-rename`). It
 * touches no DOM and no Node API, so the server and the browser can both
 * import it.
 */

export const NAME_MAX = 200;
export const EMAIL_MAX = 254;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export const ACCOUNT_WORDS = {
  enterName: "Enter a name.",
  nameTooLong: "Use 200 characters or fewer.",
  hiddenCharacter: "Remove hidden characters, such as line breaks.",
  nameRefused: "Use 1 to 200 characters, with no hidden characters.",
  enterEmail: "Enter your email address.",
  emailTooLong: "Use 254 characters or fewer.",
  emailShape: "Enter an email like name@example.com.",
  enterCurrentPassword: "Enter your current password.",
  wrongPassword: "That password is wrong. Try again.",
  newPasswordLength: "Use 8 to 128 characters.",
  enterPasskeyName: "Give the passkey a name.",
} as const;

/**
 * A control character (C0, DEL or C1) or a bidirectional embedding, override
 * or isolate. The server refuses a name that holds one before it trims, so a
 * line break at the end of a name is refused too.
 */
const HIDDEN =
  // eslint-disable-next-line no-control-regex -- the controls are what it finds
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]|\p{Bidi_Control}/u;

/** The length of `text` in Unicode code points, as the contract counts a name. */
export function codePoints(text: string): number {
  return Array.from(text).length;
}

/**
 * Why a name for the owner, or for a passkey, cannot be sent, or `undefined`
 * when it can. `empty` is what to say when nothing is left after trimming.
 */
export function nameProblem(
  raw: string,
  empty: string = ACCOUNT_WORDS.enterName,
): string | undefined {
  if (HIDDEN.test(raw)) return ACCOUNT_WORDS.hiddenCharacter;
  const name = raw.trim();
  if (name === "") return empty;
  if (codePoints(name) > NAME_MAX) return ACCOUNT_WORDS.nameTooLong;
  return undefined;
}

/** Why an email address cannot be sent, or `undefined` when it can. */
export function emailProblem(raw: string): string | undefined {
  const email = raw.trim();
  if (email === "") return ACCOUNT_WORDS.enterEmail;
  if (email.length > EMAIL_MAX) return ACCOUNT_WORDS.emailTooLong;
  return /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)
    ? undefined
    : ACCOUNT_WORDS.emailShape;
}

/** Why a new password cannot be sent, or `undefined` when it can. */
export function newPasswordProblem(password: string): string | undefined {
  return password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX
    ? undefined
    : ACCOUNT_WORDS.newPasswordLength;
}
