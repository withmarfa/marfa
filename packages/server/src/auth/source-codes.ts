/** The longest source a key holds as its own or claims. */
export const KEY_SOURCE_MAX = 200;

/** The prefix a restore puts before an app's `oauth:` source. */
export const RESTORED_SOURCE_PREFIX = "restored:";

/**
 * The longest source code any door takes: a key's longest, with the
 * {@link RESTORED_SOURCE_PREFIX} a restore adds to an app's source of that
 * length. It is measured in UTF-16 code units, as a key's own source is.
 */
export const SOURCE_CODE_MAX = KEY_SOURCE_MAX + RESTORED_SOURCE_PREFIX.length;

/** Whether `code` is a source code the server can hold. */
export function isSourceCode(code: unknown): code is string {
  return (
    typeof code === "string" &&
    code.length > 0 &&
    code.length <= SOURCE_CODE_MAX &&
    code === code.trim()
  );
}
