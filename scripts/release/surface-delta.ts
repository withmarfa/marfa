/**
 * What a release moved on the published surface, against the release before
 * it: the packages and exports the lock gained, lost or changed. Written as
 * Markdown beside the artifacts, so a release says what it changed for a
 * consumer without anyone diffing two locks by hand.
 *
 * usage: tsx scripts/release/surface-delta.ts <current-lock> [previous-lock]
 * With no previous lock, this is the first release and every export is new.
 */
import { readFileSync } from "node:fs";

export type Lock = Record<
  string,
  { hash: string; exports: Record<string, string> }
>;

export interface PackageDelta {
  pkg: string;
  status: "added" | "removed" | "changed";
  added: string[];
  removed: string[];
  changed: string[];
}

/** Every package whose surface differs, and how, sorted by name. */
export function surfaceDelta(current: Lock, previous: Lock): PackageDelta[] {
  const names = [
    ...new Set([...Object.keys(current), ...Object.keys(previous)]),
  ].sort();
  const deltas: PackageDelta[] = [];
  for (const pkg of names) {
    const now = current[pkg]?.exports;
    const before = previous[pkg]?.exports;
    if (now && !before) {
      deltas.push({
        pkg,
        status: "added",
        added: Object.keys(now).sort(),
        removed: [],
        changed: [],
      });
    } else if (!now && before) {
      deltas.push({
        pkg,
        status: "removed",
        added: [],
        removed: Object.keys(before).sort(),
        changed: [],
      });
    } else if (now && before) {
      const added = Object.keys(now).filter((name) => !(name in before));
      const removed = Object.keys(before).filter((name) => !(name in now));
      const changed = Object.keys(now).filter(
        (name) => name in before && before[name] !== now[name],
      );
      if (added.length + removed.length + changed.length > 0) {
        deltas.push({
          pkg,
          status: "changed",
          added: added.sort(),
          removed: removed.sort(),
          changed: changed.sort(),
        });
      }
    }
  }
  return deltas;
}

export function render(deltas: PackageDelta[], first: boolean): string {
  const lines = ["# Published surface", ""];
  if (first) lines.push("The first release: every export is new.", "");
  if (deltas.length === 0) {
    lines.push("Nothing on the published surface moved.");
    return `${lines.join("\n")}\n`;
  }
  for (const delta of deltas) {
    lines.push(`## ${delta.pkg} (${delta.status})`, "");
    for (const [label, names] of [
      ["Added", delta.added],
      ["Removed", delta.removed],
      ["Changed", delta.changed],
    ] as const) {
      if (names.length > 0) {
        lines.push(
          `${label}: ${names.map((name) => `\`${name}\``).join(", ")}`,
        );
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

if (process.argv[1]?.endsWith("surface-delta.ts")) {
  const [currentPath, previousPath] = process.argv.slice(2);
  if (!currentPath) {
    console.error("usage: surface-delta.ts <current-lock> [previous-lock]");
    process.exit(2);
  }
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Lock;
  const current = read(currentPath);
  const previous = previousPath ? read(previousPath) : {};
  process.stdout.write(
    render(surfaceDelta(current, previous), previousPath === undefined),
  );
}
