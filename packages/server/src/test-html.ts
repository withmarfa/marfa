/**
 * A small reader of the HTML a page sends, for tests that ask what a person
 * would see and what a form would post, by roles, field names and text and not
 * by class names or tag shapes.
 */

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);
}

/** The text a person reads: tags and scripts gone, entities decoded, space collapsed. */
export function visibleText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const inner = tag.replace(/^<[a-z0-9-]+/i, "").replace(/\/?>$/, "");
  for (const m of inner.matchAll(/([a-z][\w:-]*)(?:="([^"]*)")?/gi)) {
    out[(m[1] ?? "").toLowerCase()] = decodeEntities(m[2] ?? "");
  }
  return out;
}

export interface OptionRead {
  value: string;
  label: string;
  selected: boolean;
}

export interface ControlRead {
  tag: "select" | "input" | "button";
  /** The input's type, or "select". */
  type: string;
  name: string;
  value: string;
  role?: string;
  /** The accessible name given as aria-label. */
  label?: string;
  /** The ids of the elements that describe it, as aria-describedby gives them. */
  describedby?: string;
  id?: string;
  checked: boolean;
  disabled: boolean;
  options: OptionRead[];
}

/** Every select, input and button in the page, as a form would see it. */
export function readControls(html: string): ControlRead[] {
  const controls: ControlRead[] = [];
  const pattern =
    /<select\b[^>]*>[\s\S]*?<\/select>|<input\b[^>]*>|<button\b[^>]*>[\s\S]*?<\/button>/gi;
  for (const match of html.matchAll(pattern)) {
    const source = match[0];
    const open = /^<[a-z]+\b[^>]*>/i.exec(source)?.[0] ?? source;
    const a = attributes(open);
    if (/^<select/i.test(source)) {
      const options: OptionRead[] = [];
      for (const o of source.matchAll(
        /<option\b([^>]*)>([\s\S]*?)<\/option>/gi,
      )) {
        const oa = attributes(`<option ${o[1] ?? ""}>`);
        options.push({
          value: oa.value ?? "",
          label: visibleText(o[2] ?? ""),
          selected: "selected" in oa,
        });
      }
      controls.push({
        tag: "select",
        type: "select",
        name: a.name ?? "",
        value:
          options.find((o) => o.selected)?.value ?? options[0]?.value ?? "",
        label: a["aria-label"],
        describedby: a["aria-describedby"],
        id: a.id,
        checked: false,
        disabled: "disabled" in a,
        options,
      });
    } else if (/^<input/i.test(source)) {
      controls.push({
        tag: "input",
        type: a.type ?? "text",
        name: a.name ?? "",
        value: a.value ?? "",
        role: a.role,
        label: a["aria-label"],
        describedby: a["aria-describedby"],
        id: a.id,
        checked: "checked" in a,
        disabled: "disabled" in a,
        options: [],
      });
    } else {
      controls.push({
        tag: "button",
        type: a.type ?? "submit",
        name: a.name ?? "",
        value: a.value ?? "",
        label: visibleText(source),
        id: a.id,
        checked: false,
        disabled: "disabled" in a,
        options: [],
      });
    }
  }
  return controls;
}

/** The values a browser would post for `name` if the person changed nothing. */
export function defaultSubmission(html: string, name: string): string[] {
  const out: string[] = [];
  for (const c of readControls(html)) {
    if (c.name !== name || c.disabled || c.tag === "button") continue;
    if (c.tag === "select") {
      if (c.value !== "") out.push(c.value);
    } else if (c.type === "hidden") {
      out.push(c.value);
    } else if ((c.type === "checkbox" || c.type === "radio") && c.checked) {
      out.push(c.value);
    }
  }
  return out;
}

/** Every literal a person could post for `name`: each option, switch and hidden value. */
export function offeredValues(html: string, name: string): string[] {
  const out: string[] = [];
  for (const c of readControls(html)) {
    if (c.name !== name || c.tag === "button") continue;
    if (c.tag === "select") out.push(...c.options.map((o) => o.value));
    else out.push(c.value);
  }
  return [...new Set(out.filter((v) => v !== ""))];
}
