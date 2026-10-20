/**
 * How a setting is addressed and described on the All settings pages, shared
 * by the server, which renders them, and the command search, which links to
 * them from the browser. It touches no DOM and no Node API.
 */

/** The path segment a group is served at: "Sign-in and access" is `sign-in-and-access`. */
export const groupSlug = (group: string): string =>
  group
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** The first sentence of a description, which says what the setting does, without its code marks. */
export function firstSentence(description: string): string {
  const end = description.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? description : description.slice(0, end + 1);
  return sentence.replaceAll("`", "");
}
