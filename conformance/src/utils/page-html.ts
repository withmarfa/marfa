/**
 * What a person gets from a page, read the way they read it: the words they
 * see and the fields they fill in. The contract holds Marfa's pages to
 * these, never to the class names or tags a stylesheet happens to use, so a
 * restyle cannot fail it.
 */

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

function decode(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e] ?? e);
}

/** The words on the page, with scripts, styles and markup gone and spaces collapsed. */
export function visibleText(html: string): string {
  return decode(
    html
      .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/?(?:a|b|i|em|strong|code|span|kbd|small)\b[^>]*>/gi, "")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export interface PageField {
  tag: string;
  name: string;
  type: string | undefined;
  value: string | undefined;
}

/** Every named input, select and textarea, in the order the page lists them. */
export function pageFields(html: string): PageField[] {
  const fields: PageField[] = [];
  for (const tag of html.matchAll(
    /<(input|select|textarea)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi,
  )) {
    const attributes = new Map<string, string>();
    for (const [, key, value] of (tag[2] ?? "").matchAll(
      /([^\s=/>]+)(?:="([^"]*)")?/g,
    ))
      if (key !== undefined)
        attributes.set(key.toLowerCase(), decode(value ?? ""));
    const name = attributes.get("name");
    if (name === undefined) continue;
    fields.push({
      tag: (tag[1] ?? "").toLowerCase(),
      name,
      type: attributes.get("type"),
      value: attributes.get("value"),
    });
  }
  return fields;
}

/** The field a form posts under `name`, or `undefined` when the page has none. */
export function pageField(html: string, name: string): PageField | undefined {
  return pageFields(html).find((field) => field.name === name);
}
