/**
 * The length of a password in UTF-16 code units, which Better Auth counts. The
 * one place the server sets it (`emailAndPassword` in `instance.ts`) and the
 * pages that tell a person the range read it. It touches no DOM and no Node
 * API, so the server and the browser can both import it.
 */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
