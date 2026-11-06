/** Two runs side by side, as a Markdown table with the second over the first. */
import { readFileSync } from "node:fs";
import { format, type Figure, type Run } from "./figures.js";

function cell(figure: Figure | undefined): string {
  if (figure === undefined) return "";
  if (!figure.available) return `not available (${figure.note ?? ""})`;
  const errors = figure.errors > 0 ? `, ${figure.errors} errors` : "";
  if (figure.p95 === null)
    return `${format(figure.value)} ${figure.unit}${errors}`;
  return `${format(figure.p50)} / ${format(figure.p95)} ${figure.unit}${errors}`;
}

function ratio(
  a: number | null | undefined,
  b: number | null | undefined,
): string {
  if (a === null || a === undefined || b === null || b === undefined || a === 0)
    return "";
  return `${(b / a).toFixed(2)}x`;
}

function ratioCell(a: Figure | undefined, b: Figure | undefined): string {
  if (a === undefined || b === undefined || !a.available || !b.available)
    return "";
  if (a.p95 !== null && b.p95 !== null) {
    return `${ratio(a.p50, b.p50)} / ${ratio(a.p95, b.p95)}`;
  }
  return ratio(a.value, b.value);
}

function tables(run: Run): string[] {
  const lines: string[] = [];
  for (const [when, files] of Object.entries(run.storage)) {
    for (const [file, summary] of Object.entries(
      files as Record<string, unknown>,
    )) {
      const described = summary as {
        tables?: { name: string; rows: number | null; bytes: number | null }[];
        page_size?: number;
        journal?: string;
        index_bytes?: number | null;
      };
      lines.push(
        "",
        `${run.label}, ${file} ${when.replaceAll("_", " ")}: page size ${described.page_size ?? "?"}, journal ${described.journal ?? "?"}, index bytes ${format((described.index_bytes ?? 0) / 1_048_576)} MB`,
        "",
        "| Table | Rows | MB |",
        "| --- | ---: | ---: |",
      );
      for (const table of described.tables ?? []) {
        if (table.rows === 0 && (table.bytes ?? 0) <= 4_096) continue;
        lines.push(
          `| ${table.name} | ${table.rows?.toLocaleString("en-US") ?? "?"} | ${table.bytes === null ? "?" : format(table.bytes / 1_048_576)} |`,
        );
      }
    }
  }
  return lines;
}

export function compare(fileA: string, fileB: string): string {
  const a = JSON.parse(readFileSync(fileA, "utf8")) as Run;
  const b = JSON.parse(readFileSync(fileB, "utf8")) as Run;
  const names = [
    ...a.figures.map((figure) => figure.name),
    ...b.figures
      .map((figure) => figure.name)
      .filter((name) => !a.figures.some((figure) => figure.name === name)),
  ];
  const find = (run: Run, name: string) =>
    run.figures.find((figure) => figure.name === name);
  const lines = [
    `| Measurement | ${a.label} | ${b.label} | ${b.label} / ${a.label} | Better |`,
    "| --- | --- | --- | --- | --- |",
  ];
  for (const name of names) {
    const fa = find(a, name);
    const fb = find(b, name);
    const label = (fa ?? fb)?.label ?? name;
    const better = (fa ?? fb)?.better ?? "neither";
    lines.push(
      `| ${label} | ${cell(fa)} | ${cell(fb)} | ${ratioCell(fa, fb)} | ${better === "neither" ? "" : better} |`,
    );
  }
  const machine = (run: Run) =>
    `${run.label}: ${run.items_target.toLocaleString("en-US")} items, ${run.started_at} to ${run.finished_at ?? "(did not finish)"}, ${run.machine.cpu} (${run.machine.cpus} cores, ${run.machine.memory_gb} GB), load average ${run.machine.load_at_start.map((n) => n.toFixed(1)).join(" ")} at the start and ${run.machine.load_at_end?.map((n) => n.toFixed(1)).join(" ") ?? "?"} at the end.`;
  lines.push(
    "",
    "Distributions show the median / p95. The ratio is the second run over the first; below 1 means the second is smaller.",
    "",
    `- ${machine(a)}`,
    `- ${machine(b)}`,
  );
  for (const run of [a, b]) {
    for (const note of run.notes) lines.push(`- ${run.label}: ${note}`);
  }
  lines.push(...tables(a), ...tables(b));
  return lines.join("\n");
}
