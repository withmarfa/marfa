import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureTitles } from "../../utils/fixture-titles.js";
import {
  citationsIn,
  readChapter,
  statementText,
} from "../../utils/spec-statements.js";

/**
 * The corpus against the chapters, with no server and no device.
 *
 * `spec-citations.test.ts` checks that a citation resolves. It cannot check
 * the other direction, and the other direction is the one that matters here:
 * a device statement with no citation is a rule nothing asserts, and it would
 * read exactly like a rule everything asserts.
 *
 * A rule's explicitly labelled test metadata carries its citations too.
 * Every device statement is cited, every citation reaches a device
 * fixture, and every fixture of the device's behavior is cited.
 */

const here = dirname(fileURLToPath(import.meta.url));
const specDir = resolve(here, "../../../spec");
const CHAPTERS = ["device.md", "queue-and-verdicts.md", "folders.md"];

interface Statement {
  chapter: string;
  id: string;
  text: string;
}

function statements(chapter: string): Statement[] {
  return read(chapter);
}

function read(chapter: string): Statement[] {
  return readText(chapter, readFileSync(resolve(specDir, chapter), "utf8"));
}

function readText(chapter: string, text: string): Statement[] {
  return readChapter(text).statements.map((statement) => ({
    chapter,
    id: statement.id,
    text: statementText(statement),
  }));
}

function titlesIn(file: string): string[] {
  const path = resolve(here, "..", file);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return fixtureTitles(text);
}

const allStatements = CHAPTERS.flatMap(statements);
const fixtureFiles = readdirSync(here).filter(
  (name) => name.endsWith(".test.ts") && !name.endsWith(".decision.test.ts"),
);

describe("separate rule metadata", () => {
  const cited = "`device/stop.test.ts › a stopped call`";

  it("reads a statement's citations from its Tests paragraph and not from its reason", () => {
    const found = readText(
      "device.md",
      `### \`device/a-rule\`\n\nWhen asked, the CLI MUST answer.\n\n**Reason:** ${cited} explains its reason.\n\n**Tests:** ${cited}\n`,
    );
    expect(found).toEqual([
      {
        chapter: "device.md",
        id: "device/a-rule",
        text: `When asked, the CLI MUST answer. ${cited}`,
      },
    ]);
    expect(citationsIn(found[0].text)).toEqual([
      { file: "device/stop.test.ts", title: "a stopped call" },
    ]);
  });

  it("counts CLI fixtures as evidence for a rule and resolves their titles", () => {
    const title = titlesIn("cli/folder.test.ts")[0];
    expect(title).toBeDefined();
    const statement = readText(
      "folders.md",
      [
        "### `folders/" + "sample-rule`",
        "",
        "The CLI MUST answer.",
        "",
        `**Tests:** \`cli/folder.test.ts › ${title}\`.`,
      ].join("\n"),
    )[0];
    expect(citationsIn(statement.text)).toEqual([
      { file: "cli/folder.test.ts", title },
    ]);
  });
});

describe("every device statement is asserted by something", () => {
  it("finds the device chapters and their statements", () => {
    expect(
      CHAPTERS.every((chapter) => existsSync(resolve(specDir, chapter))),
      "a device chapter is missing, so everything below is checking an empty set",
    ).toBe(true);
    // Per chapter, rather than a count over the three: a loose floor lets
    // most of a chapter fall out of the parse while every check below passes
    // on whatever survived.
    for (const chapter of CHAPTERS) {
      const ids = read(chapter).map((statement) => statement.id);
      expect(
        ids.filter((id, index) => ids.indexOf(id) !== index),
        `${chapter} states the same ID twice`,
      ).toEqual([]);
      expect(
        ids.length,
        `${chapter} parsed to ${String(ids.length)} statements, which is fewer than it carries`,
      ).toBeGreaterThanOrEqual(15);
    }
  });

  it("cites a fixture for every statement", () => {
    // A rule no fixture can assert yet names the issue that makes it
    // testable instead, which `spec-form.test.ts` holds to its one shape.
    const WAITING = / waiting on #\d+\.$/;
    // The witness: an ID statement's waiting line is read as its text ends.
    const waiting = readText(
      "device.md",
      `### \`device/a-rule\`\n\nWhen asked, the CLI MUST answer.\n\n**Tests:** waiting on #1.\n`,
    )[0];
    expect(WAITING.test(waiting.text), waiting.text).toBe(true);
    const uncited = allStatements
      .filter(
        (statement) =>
          citationsIn(statement.text).length === 0 &&
          !WAITING.test(statement.text),
      )
      .map((statement) => `${statement.chapter} ${statement.id}`);
    expect(
      uncited,
      "a statement in a device chapter names no fixture, so it is a rule nothing checks and it reads exactly like a rule everything checks",
    ).toEqual([]);
  });

  it("cites only fixtures that exist, with titles that exist", () => {
    const unresolved: string[] = [];
    for (const statement of allStatements) {
      for (const citation of citationsIn(statement.text)) {
        const titles = titlesIn(citation.file);
        if (titles.length === 0) {
          unresolved.push(
            `${statement.chapter} ${statement.id}: ${citation.file} is missing`,
          );
          continue;
        }
        if (citation.title !== undefined && !titles.includes(citation.title)) {
          unresolved.push(
            `${statement.chapter} ${statement.id}: ${citation.file} › ${citation.title}`,
          );
        }
      }
    }
    expect(
      unresolved,
      "a device statement cites a fixture or a title that does not exist, so the statement is asserted by nothing at all",
    ).toEqual([]);
  });

  it("runs every device fixture rather than skipping one", () => {
    // A fixture that skips passes every check here: it is cited, its title
    // resolves, and it asserts nothing, so the statement citing it reads as
    // asserted while nothing runs it. One marked to fail is the same: it
    // passes when what it asserts is false.
    const SKIPS =
      /\b(?:skip|skipIf|runIf|todo|fails)\s*\(|\b(?:skip|todo|fails)\s*:\s*true\b/;
    // The witness: the check sees each way a fixture is skipped.
    for (const written of [
      "context.skip();",
      "({ skip }) => skip()",
      'it.skip("a fixture", () => {});',
      'it.skipIf(true)("a fixture", () => {});',
      'it.runIf(false)("a fixture", () => {});',
      'it.todo("a fixture");',
      'it.fails("a fixture", () => {});',
      'it("a fixture", { skip: true }, () => {});',
      'it("a fixture", { todo: true }, () => {});',
      'it("a fixture", { fails: true }, () => {});',
      'describe.skip("a chapter", () => {});',
    ]) {
      expect(SKIPS.test(written), written).toBe(true);
    }
    // A fixture that runs only on macOS, such as one of the keychain, which
    // no other platform has, asserts its statement where the device suite
    // runs on macOS: nightly and on request (`ci.yml`), never on a pull
    // request.
    const ON_MACOS = /\.runIf\(process\.platform === "darwin"\)/g;
    const skips = (text: string) => SKIPS.test(text.replace(ON_MACOS, ""));
    expect(skips('describe.runIf(process.platform === "darwin")("a")')).toBe(
      false,
    );
    expect(skips('describe.runIf(process.platform === "linux")("a")')).toBe(
      true,
    );
    const skipping = fixtureFiles.filter((file) =>
      skips(readFileSync(resolve(here, file), "utf8")),
    );
    expect(
      skipping,
      "a device fixture skips itself, so the statement citing it is asserted by nothing",
    ).toEqual([]);
    // The witness: the files read are the fixtures, so an empty list above
    // is every one of them read and not nothing read.
    expect(fixtureFiles).toContain("working-copy.test.ts");
  });

  it("cites every fixture of the device's behavior from some statement", () => {
    // The suite's own controls are not the device's behavior: fidelity holds
    // the scripting to the real server and the scripted server's own tests
    // hold the harness. Everything else asserts a rule, and a fixture no
    // statement cites is a rule written nowhere, whose citation could be
    // dropped with nothing failing.
    const CONTROLS = ["fidelity.test.ts", "scripted-server.test.ts"];
    const cited = new Set(
      allStatements.flatMap((statement) =>
        citationsIn(statement.text).map(
          (citation) => `${citation.file} › ${citation.title ?? ""}`,
        ),
      ),
    );
    const uncited = fixtureFiles
      .filter((file) => !CONTROLS.includes(file))
      .flatMap((file) =>
        titlesIn(`device/${file}`)
          .map((title) => `device/${file} › ${title}`)
          .filter((key) => !cited.has(key)),
      );
    expect(
      uncited,
      "a fixture of the device's behavior is cited by no statement, so the rule it asserts is written nowhere",
    ).toEqual([]);
    // The witness: the files read are the fixtures and their titles are
    // read, so an empty list above is every one of them cited and not
    // nothing read.
    expect(fixtureFiles).toContain("queue.test.ts");
    expect(
      titlesIn("device/queue.test.ts"),
      "no title was read from a fixture, so an empty list above checked nothing",
    ).not.toEqual([]);
  });
});
