/**
 * What the Export and restore page says once a restore has answered. It
 * touches no DOM, so the page script and a test can both import it.
 */

/** The counts `POST /restore` answers that the page reports. */
export interface RestoreCounts {
  imported: number;
  duplicates: number;
  edges_imported: number;
  blobs_imported: number;
  blobs_missing: readonly string[];
  types_registered: number;
  edge_types_registered: number;
}

const count = (n: number, noun: string): string =>
  `${String(n)} ${noun}${n === 1 ? "" : "s"}`;

/** "3 items added, 1 already here. 2 links, 0 files and 1 type added." */
export function restoreSummary(result: RestoreCounts): string {
  const types = result.types_registered + result.edge_types_registered;
  const lacking = result.blobs_missing.length;
  return [
    `${count(result.imported, "item")} added, ${String(result.duplicates)} already here.`,
    `${count(result.edges_imported, "link")}, ${count(result.blobs_imported, "file")} and ${count(types, "type")} added.`,
    ...(lacking === 0
      ? []
      : [
          `${count(lacking, "file")} named in the export ${lacking === 1 ? "is" : "are"} neither in it nor here.`,
        ]),
  ].join(" ");
}
