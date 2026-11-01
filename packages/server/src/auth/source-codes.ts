/** The longest source a key holds as its own or claims. */
export const KEY_SOURCE_MAX = 200;

/** The prefix a restore puts before an app's `oauth:` source. */
export const RESTORED_SOURCE_PREFIX = "restored:";

/** Whether `code` is a source code the server can hold. */
export function isSourceCode(code: unknown): code is string {
  return (
    typeof code === "string" &&
    code.length > 0 &&
    (code.length <= KEY_SOURCE_MAX ||
      (code.startsWith(RESTORED_SOURCE_PREFIX) &&
        code.length <= KEY_SOURCE_MAX + RESTORED_SOURCE_PREFIX.length)) &&
    code === code.trim()
  );
}
