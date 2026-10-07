/**
 * The table of codes in `spec/errors.md`, written from the rows the server's
 * code table describes. The rows come in as data so that nothing here reads
 * the server: `scripts/errors-table.ts` passes them in and the repository's
 * own check compares what comes out to the chapter.
 */

/** One code, as `ERROR_CODES` in the shared package describes it. */
export interface ErrorRow {
  code: string;
  status: number;
  /** What the table shows in place of the status, where the status is not the code's own. */
  statusLabel?: string;
  summary: string;
}

export const TABLE_START = "<!-- errors-table:start -->";
export const TABLE_END = "<!-- errors-table:end -->";

const HEADER = ["Code", "Status", "Meaning"];

function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** The rows in the order the table lists them: by status, then by code. */
export function inTableOrder(rows: readonly ErrorRow[]): ErrorRow[] {
  return [...rows].sort(
    (a, b) => a.status - b.status || a.code.localeCompare(b.code),
  );
}

/**
 * A Markdown table with its columns padded the way Prettier pads them, so
 * the format check accepts the chapter as written. Each row's first cell is
 * the code in backticks, which the server's census reads.
 */
export function renderTable(rows: readonly ErrorRow[]): string {
  const body = inTableOrder(rows).map((row) =>
    [`\`${row.code}\``, row.statusLabel ?? String(row.status), row.summary].map(
      cell,
    ),
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
export function withErrorsTable(
  chapter: string,
  rows: readonly ErrorRow[],
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

/** The rows of the server's code table, as this module takes them. */
export function errorRows(
  codes: Readonly<
    Record<string, { status: number; statusLabel?: string; summary: string }>
  >,
): ErrorRow[] {
  return Object.entries(codes).map(([code, info]) => ({ code, ...info }));
}
