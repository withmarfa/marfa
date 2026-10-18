export interface HousekeepingRow {
  name: string;
  description: string;
}
export const TABLE_START = "<!-- housekeeping-table:start -->";
export const TABLE_END = "<!-- housekeeping-table:end -->";

export function renderTable(rows: readonly HousekeepingRow[]): string {
  const body = rows.map(({ name, description }) =>
    [`\`${name}\``, description].map((cell) =>
      cell.replace(/\\/g, "\\\\").replace(/\|/g, "\\|"),
    ),
  );
  const header = ["Job", "What it does"];
  const widths = header.map((title, column) =>
    Math.max(3, title.length, ...body.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: readonly string[]) =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(" | ")} |`;
  return [
    line(header),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...body.map(line),
  ].join("\n");
}

export function withHousekeepingTable(
  chapter: string,
  rows: readonly HousekeepingRow[],
): string {
  const start = chapter.indexOf(TABLE_START);
  const end = chapter.indexOf(TABLE_END);
  if (
    start < 0 ||
    end < start ||
    chapter.split(TABLE_START).length !== 2 ||
    chapter.split(TABLE_END).length !== 2
  ) {
    throw new Error(
      `The chapter needs exactly one ${TABLE_START} and ${TABLE_END}, in that order.`,
    );
  }
  return `${chapter.slice(0, start + TABLE_START.length)}\n\n${renderTable(rows)}\n\n${chapter.slice(end)}`;
}
