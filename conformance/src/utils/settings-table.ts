/**
 * The settings table in `spec/instance.md`, written from the rows the
 * server's settings schema describes. The rows come in as data so that
 * nothing here reads the server: `scripts/settings-table.ts` passes them in
 * and the repository's own check compares what comes out to the chapter.
 */

/** One setting, as `describeSettings` in the server's `config.ts` returns it. */
export interface SettingRow {
  name: string;
  rule:
    | { kind: "count"; min: number; max?: number; unit?: string }
    | { kind: "decimal"; min: number; max: number }
    | { kind: "choice"; values: readonly string[] }
    | { kind: "secret"; minLength?: number }
    | {
        kind:
          | "flag"
          | "url"
          | "text"
          | "origins"
          | "cidrs"
          | "header-name"
          | "headers"
          | "permission-bundles";
      };
  default?: string | number | boolean;
  defaultNote?: string;
  description: string;
}

export const TABLE_START = "<!-- settings-table:start -->";
export const TABLE_END = "<!-- settings-table:end -->";

const HEADER = ["Setting", "Default", "Allowed values", "What it sets"];

const UNIT_NAMES: Record<string, string> = {
  ms: "milliseconds",
  days: "days",
  hours: "hours",
  bytes: "bytes",
};

function code(value: string): string {
  return `\`${value}\``;
}

function listOf(items: readonly string[]): string {
  return items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1] ?? ""}`;
}

/** What a setting accepts, in words. */
export function allowedValues(rule: SettingRow["rule"]): string {
  switch (rule.kind) {
    case "count": {
      const unit =
        rule.unit === undefined
          ? ""
          : ` of ${UNIT_NAMES[rule.unit] ?? rule.unit}`;
      const range =
        rule.max === undefined
          ? `${String(rule.min)} or more`
          : `${String(rule.min)} to ${String(rule.max)}`;
      return `Whole number${unit}, ${range}`;
    }
    case "decimal":
      return `Decimal number, ${String(rule.min)} to ${String(rule.max)}`;
    case "choice":
      return listOf(rule.values.map(code));
    case "flag":
      return `${code("true")}, ${code("1")}, ${code("yes")}, ${code("on")}, ${code("false")}, ${code("0")}, ${code("no")} or ${code("off")}, in any case`;
    case "url":
      return `Absolute ${code("http")} or ${code("https")} URL`;
    case "text":
      return "Any text";
    case "secret":
      return rule.minLength === undefined
        ? "Text with no whitespace around it"
        : `Text of at least ${String(rule.minLength)} characters, with no whitespace around it`;
    case "origins":
      return `Comma-separated origins, each ${code("scheme://host[:port]")} with no path`;
    case "cidrs":
      return "Comma-separated CIDR ranges, IPv4 or IPv6";
    case "header-name":
      return "An HTTP header name";
    case "headers":
      return `Comma-separated ${code("key=value")} pairs, values percent-encoded`;
    case "permission-bundles":
      return "JSON array of permission bundles";
  }
}

/** What a setting is when it is unset or blank. */
export function defaultText(row: SettingRow): string {
  const parts: string[] = [];
  if (row.default !== undefined) {
    const unit =
      row.rule.kind === "count" && row.rule.unit !== undefined
        ? ` ${row.rule.unit}`
        : "";
    parts.push(`${code(String(row.default))}${unit}`);
  }
  if (row.defaultNote !== undefined) parts.push(row.defaultNote);
  return parts.length > 0 ? parts.join(". ").replace(/\.\. /g, ". ") : "None";
}

function cell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/**
 * A Markdown table with its columns padded the way Prettier pads them, so
 * the format check accepts the chapter as written.
 */
export function renderTable(rows: readonly SettingRow[]): string {
  const body = rows.map((row) =>
    [
      code(row.name),
      defaultText(row),
      allowedValues(row.rule),
      row.description,
    ].map(cell),
  );
  const widths = HEADER.map((title, column) =>
    Math.max(
      3,
      title.length,
      ...body.map((line) => (line[column] ?? "").length),
    ),
  );
  const line = (cells: readonly string[]) =>
    `| ${cells.map((text, column) => text.padEnd(widths[column] ?? 0)).join(" | ")} |`;
  return [
    line(HEADER),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...body.map(line),
  ].join("\n");
}

/** The chapter with the table between its two markers replaced by one written from `rows`. */
export function withSettingsTable(
  chapter: string,
  rows: readonly SettingRow[],
): string {
  const start = chapter.indexOf(TABLE_START);
  const end = chapter.indexOf(TABLE_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `the chapter needs ${TABLE_START} and ${TABLE_END}, in that order, where the table goes`,
    );
  }
  return `${chapter.slice(0, start + TABLE_START.length)}\n\n${renderTable(rows)}\n\n${chapter.slice(end)}`;
}
