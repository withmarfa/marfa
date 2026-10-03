/**
 * Whether a pull request's description follows the organization's template
 * (`.github/PULL_REQUEST_TEMPLATE.md` in withmarfa/.github).
 *
 * A pull request opened from the command line with `--body` skips the
 * template, and GitHub cannot require one, so `pr-description.yml` runs this
 * and fails the check. The body is untrusted input: it is read from the
 * event file and never reaches a shell.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The template's sections, in order. */
export const SECTIONS = [
  "Summary",
  "Changes",
  "Testing",
  "Notes for reviewers",
  "Checklist",
] as const;

/** Sections that must say something; the others only have to be present. */
const FILLED: readonly string[] = ["Summary", "Changes", "Testing"];

/** What the template puts under a heading, which says nothing. */
function hasContent(text: string): boolean {
  return text.split("\n").some((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && trimmed !== "-";
  });
}

/** The problems with a description, empty when it follows the template. */
export function checkDescription(body: string | null | undefined): string[] {
  // An unclosed comment hides the rest of the page when GitHub renders it.
  const text = (body ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "");

  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of text.split("\n")) {
    const heading = /^## +(.*?) *$/.exec(line);
    if (heading !== null) {
      const name = SECTIONS.find((section) => section === heading[1]);
      current = undefined;
      if (name !== undefined) {
        current = sections.get(name) ?? [];
        sections.set(name, current);
      }
    } else {
      current?.push(line);
    }
  }

  const problems: string[] = [];
  for (const section of SECTIONS) {
    const lines = sections.get(section);
    if (lines === undefined) {
      problems.push(`The "## ${section}" heading is missing.`);
    } else if (FILLED.includes(section) && !hasContent(lines.join("\n"))) {
      problems.push(`"## ${section}" has no content.`);
    }
  }

  const checklist = sections.get("Checklist");
  if (checklist !== undefined) {
    const boxes = checklist.filter((line) =>
      /^\s*[-*+]\s+\[[ xX]\]/.test(line),
    );
    const unticked = boxes.filter((line) => /^\s*[-*+]\s+\[ \]/.test(line));
    if (boxes.length === 0) {
      problems.push(`"## Checklist" has no boxes.`);
    }
    for (const line of unticked) {
      const item = line.replace(/^\s*[-*+]\s+\[ \]\s*/, "").trim();
      problems.push(`Checklist box not ticked: ${item}`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"),
  ) as { pull_request?: { body?: string | null } };
  const problems = checkDescription(event.pull_request?.body);
  for (const problem of problems) {
    console.log(`::error title=Pull request description::${problem}`);
  }
  if (problems.length > 0) {
    console.error(
      "The description must follow the organization's pull request template: " +
        "Summary, Changes, Testing, Notes for reviewers and Checklist, with " +
        "the first three filled in and every checklist box ticked.",
    );
    process.exit(1);
  }
  console.log("The description follows the template.");
}
