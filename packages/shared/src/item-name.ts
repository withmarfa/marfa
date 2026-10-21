import type { DisplayHints } from "./type-registry.js";

/** The plain, bounded name used by item summaries and their name search. */
export function itemName(
  properties: Record<string, unknown>,
  hints?: DisplayHints,
): string {
  const fields = [
    hints?.title_field,
    "title",
    "name",
    hints?.body_field,
    "body",
    "text",
    "filename",
    "url",
    "address",
  ];
  for (const field of new Set(fields)) {
    if (field === undefined) continue;
    const value = properties[field];
    if (typeof value !== "string") continue;
    const first = value.trim().split(/\r\n|[\n\r\u2028\u2029]/, 1)[0] ?? "";
    const text = first
      .replace(/\p{Cc}/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const points = Array.from(text.slice(0, 242));
    return points.length > 120 ? points.slice(0, 119).join("") + "…" : text;
  }
  return "Untitled";
}
