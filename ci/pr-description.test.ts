/**
 * `scripts/check-pr-description.ts`, pinned: what counts as a description
 * that follows the pull request template, and that the check runs on its own
 * workflow so editing a description reruns nothing else.
 */
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { checkDescription } from "../scripts/check-pr-description.js";

const ROOT = resolve(import.meta.dirname, "..");

const TEMPLATE = `## Summary

<!-- What changed and why, in two or three plain sentences. End with "Closes #NN" when this closes an issue. -->

## Changes

-

## Testing

<!-- How this was tested: the commands or tests run and what they showed. Say what was not tested. -->

## Notes for reviewers

<!-- Trade-offs, follow-ups, and the depth of review this needs and why. -->

## Checklist

- [ ] The title is a scoped Conventional Commit.
- [ ] New behavior has a test that was seen failing first, or no test was needed and the reason is above.
- [ ] Docs, comments and the contract still say what is true after this change.
`;

const FILLED = `## Summary

Requires the template. Closes #1.

## Changes

- Adds the check.

## Testing

Ran the tests.

## Notes for reviewers

Checks only.

## Checklist

- [x] The title is a scoped Conventional Commit.
- [x] New behavior has a test that was seen failing first, or no test was needed and the reason is above.
- [X] Docs, comments and the contract still say what is true after this change.
`;

describe("a description that follows the template", () => {
  it("passes when it is filled in and every box is ticked", () => {
    expect(checkDescription(FILLED)).toEqual([]);
  });

  it("passes with Windows line endings, as the web editor saves them", () => {
    expect(checkDescription(FILLED.replace(/\n/g, "\r\n"))).toEqual([]);
  });

  it("does not need Notes for reviewers to say anything", () => {
    expect(
      checkDescription(FILLED.replace("Checks only.\n", "<!-- none -->\n")),
    ).toEqual([]);
  });

  it("accepts a ticked box under any list marker", () => {
    expect(checkDescription(FILLED.replace(/^- \[x\]/gm, "* [x]"))).toEqual([]);
  });
});

describe("a description that does not", () => {
  it("fails the empty template, naming each unfilled section and box", () => {
    expect(checkDescription(TEMPLATE)).toEqual([
      `"## Summary" has no content.`,
      `"## Changes" has no content.`,
      `"## Testing" has no content.`,
      "Checklist box not ticked: The title is a scoped Conventional Commit.",
      "Checklist box not ticked: New behavior has a test that was seen failing first, or no test was needed and the reason is above.",
      "Checklist box not ticked: Docs, comments and the contract still say what is true after this change.",
    ]);
  });

  it.each([null, undefined, "", "Fixes the thing."])(
    "fails %j, which has none of the headings",
    (body) => {
      expect(checkDescription(body)).toHaveLength(5);
    },
  );

  it.each([
    "Summary",
    "Changes",
    "Testing",
    "Notes for reviewers",
    "Checklist",
  ])("names a missing %s heading", (section) => {
    const body = FILLED.replace(`## ${section}`, `### ${section}`);
    expect(checkDescription(body)).toEqual([
      `The "## ${section}" heading is missing.`,
    ]);
  });

  it("does not count a heading hidden in a comment", () => {
    const body = FILLED.replace(
      "## Testing",
      "<!--\n## Testing\n-->\n## Elsewhere",
    );
    expect(checkDescription(body)).toEqual([
      `The "## Testing" heading is missing.`,
    ]);
  });

  it("treats a bare dash and comments as no content", () => {
    expect(
      checkDescription(
        FILLED.replace("- Adds the check.", "- \n<!-- later -->"),
      ),
    ).toEqual([`"## Changes" has no content.`]);
  });

  it("counts a dash with words after it as content", () => {
    expect(
      checkDescription(TEMPLATE.replace("-\n", "- Adds the check.\n")),
    ).not.toContain(`"## Changes" has no content.`);
  });

  it("fails one unticked box among ticked ones", () => {
    expect(
      checkDescription(FILLED.replace("- [X] Docs", "- [ ] Docs")),
    ).toEqual([
      "Checklist box not ticked: Docs, comments and the contract still say what is true after this change.",
    ]);
  });

  it("fails a checklist emptied of its boxes", () => {
    expect(checkDescription(FILLED.replace(/^- \[.\].*\n/gm, ""))).toEqual([
      `"## Checklist" has no boxes.`,
    ]);
  });

  it("reads an unclosed comment as hiding the rest of the page", () => {
    expect(checkDescription(`${FILLED}\n<!-- ## Summary`)).toEqual([]);
    expect(
      checkDescription(FILLED.replace("## Notes", "<!-- ## Notes")),
    ).toEqual([
      `The "## Notes for reviewers" heading is missing.`,
      `The "## Checklist" heading is missing.`,
    ]);
  });
});

describe("the script, as the workflow runs it", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pr-description-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(body: string) {
    const event = join(dir, "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { body } }));
    return spawnSync("node", ["scripts/check-pr-description.ts"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_PATH: event },
    });
  }

  it("exits zero for a filled description", () => {
    const result = run(FILLED);
    expect(result.status).toBe(0);
  });

  it("exits non-zero with one annotation per problem for the template", () => {
    const result = run(TEMPLATE);
    expect(result.status).toBe(1);
    expect(result.stdout.match(/^::error title=/gm)).toHaveLength(6);
  });

  it("never treats a body as a command", () => {
    const marker = join(dir, "ran");
    const result = run(`$(touch ${marker}) \`touch ${marker}\`\n${FILLED}`);
    expect(result.status).toBe(0);
    expect(() => readFileSync(marker)).toThrow();
  });
});

describe("pr-description.yml", () => {
  const workflow = parse(
    readFileSync(
      join(ROOT, ".github", "workflows", "pr-description.yml"),
      "utf8",
    ),
  ) as {
    on: { pull_request: { types: string[] } };
    jobs: Record<string, { name: string; if?: string }>;
  };

  it("reruns on a description edit and nothing else on the pull request", () => {
    expect(Object.keys(workflow.on)).toEqual(["pull_request"]);
    expect(workflow.on.pull_request.types).toEqual([
      "opened",
      "edited",
      "reopened",
      "synchronize",
      "ready_for_review",
    ]);
  });

  it("is one job, named for the required check, that skips bots", () => {
    expect(Object.values(workflow.jobs)).toEqual([
      expect.objectContaining({
        name: "Pull request description",
        if: "${{ github.event.pull_request.user.type != 'Bot' }}",
      }),
    ]);
  });

  it("is the only workflow that runs on a description edit", () => {
    const dir = join(ROOT, ".github", "workflows");
    const editing = readdirSync(dir).filter((file) => {
      const on = (
        parse(readFileSync(join(dir, file), "utf8")) as {
          on?: { pull_request?: { types?: string[] } | null };
        }
      ).on;
      // A pull request trigger with no types never runs on an edit.
      return on?.pull_request?.types?.includes("edited") === true;
    });
    expect(editing).toEqual(["pr-description.yml"]);
  });
});
