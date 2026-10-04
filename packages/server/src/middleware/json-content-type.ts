/** What the library and Hono both read as a JSON `Content-Type`. */
const JSON_CONTENT_TYPE =
  /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i;

export function isJsonContentType(type: string | undefined): boolean {
  return type !== undefined && JSON_CONTENT_TYPE.test(type);
}
