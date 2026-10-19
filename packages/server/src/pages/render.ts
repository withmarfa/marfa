/**
 * A page as the string a response sends. Every page has one root, the shell,
 * and its markup is escaped as it is built: text and attribute values are
 * escaped, and nothing here marks a string as trusted.
 */
export function renderDocument(page: {
  toString(): string | Promise<string>;
}): string {
  const markup = page.toString();
  if (typeof markup !== "string")
    throw new Error(
      "A page renders synchronously; await belongs in the route.",
    );
  return `<!DOCTYPE html>${markup}`;
}
