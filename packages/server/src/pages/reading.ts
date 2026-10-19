/**
 * A page as a person meets it, for the tests that check a page's behavior: the
 * words they read, the fields they fill in and where a form posts. A test that
 * asks for these is not broken by a restyle, which a test of class names is.
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

/** The attributes of a start tag's text, decoded. A bare attribute reads as an empty string. */
function attributesOf(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const [, key, value] of text.matchAll(/([^\s=/>]+)(?:="([^"]*)")?/g))
    if (key !== undefined)
      attributes.set(key.toLowerCase(), decode(value ?? ""));
  return attributes;
}

const START_TAG = (names: string) =>
  new RegExp(`<(${names})\\b((?:[^>"']|"[^"]*"|'[^']*')*)>`, "gi");

export interface PageField {
  tag: string;
  name: string;
  type: string | undefined;
  value: string | undefined;
  autofocus: boolean;
  /** Marked invalid for a person using assistive technology. */
  invalid: boolean;
  /** The id of the text that describes the field, such as its error. */
  describedBy: string | undefined;
}

/** Every named input, select and textarea, in the order the page lists them. */
export function pageFields(html: string): PageField[] {
  const fields: PageField[] = [];
  for (const tag of html.matchAll(START_TAG("input|select|textarea"))) {
    const attributes = attributesOf(tag[2] ?? "");
    const name = attributes.get("name");
    if (name === undefined) continue;
    fields.push({
      tag: (tag[1] ?? "").toLowerCase(),
      name,
      type: attributes.get("type"),
      value: attributes.get("value"),
      autofocus: attributes.has("autofocus"),
      invalid: attributes.get("aria-invalid") === "true",
      describedBy: attributes.get("aria-describedby"),
    });
  }
  return fields;
}

/** The field a form posts under `name`, or `undefined` when the page has none. */
export function pageField(html: string, name: string): PageField | undefined {
  return pageFields(html).find((field) => field.name === name);
}

/**
 * The words that describe the field posted under `name`, such as the error
 * under it, or `undefined` when it has none. Found the way assistive
 * technology finds them, through the field's `aria-describedby`.
 */
export function pageFieldError(html: string, name: string): string | undefined {
  const id = pageField(html, name)?.describedBy?.split(/\s+/)[0];
  if (id === undefined) return undefined;
  const element = new RegExp(
    `<(\\w+)\\b(?:[^>"']|"[^"]*"|'[^']*')*\\sid="${id.replace(/[^\w-]/g, "")}"(?:[^>"']|"[^"]*"|'[^']*')*>([\\s\\S]*?)</\\1>`,
  ).exec(html);
  return element?.[2] === undefined ? undefined : visibleText(element[2]);
}

export interface PageForm {
  method: string;
  action: string | undefined;
  novalidate: boolean;
}

/** Every form on the page: how it posts and where. */
export function pageForms(html: string): PageForm[] {
  return [...html.matchAll(START_TAG("form"))].map((tag) => {
    const attributes = attributesOf(tag[2] ?? "");
    return {
      method: (attributes.get("method") ?? "get").toLowerCase(),
      action: attributes.get("action"),
      novalidate: attributes.has("novalidate"),
    };
  });
}

/** Every link on the page: its address and the words it shows. */
export function pageLinks(html: string): { href: string; text: string }[] {
  return [
    ...html.matchAll(/<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a>/gi),
  ].map((link) => ({
    href: attributesOf(link[1] ?? "").get("href") ?? "",
    text: visibleText(link[2] ?? ""),
  }));
}
