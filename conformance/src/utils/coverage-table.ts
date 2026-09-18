import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface CoverageRow {
  method: string;
  path: string;
  status: string;
  fixtures: string[];
}

/** Every operation row in `spec/coverage.md`, as the referee's inventory. */
export function coverageRows(): CoverageRow[] {
  const table = readFileSync(
    resolve(process.cwd(), "spec/coverage.md"),
    "utf8",
  );
  const rows: CoverageRow[] = [];
  for (const line of table.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    const op = /^`([A-Z]+) ([^`]+)`$/.exec(cells[1] ?? "");
    if (!op) continue;
    rows.push({
      method: op[1],
      path: op[2],
      status: cells[2] ?? "",
      fixtures: [...(cells[3] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]),
    });
  }
  return rows;
}
