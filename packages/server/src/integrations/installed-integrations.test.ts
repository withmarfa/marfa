/**
 * The declaration of what the image installs, and the one parser that reads
 * it.
 *
 * The declaration names integrations that live in withmarfa/integrations,
 * so nothing here can check it against a tree. What the image build does
 * check is that every declared name is present in the checkout it pinned,
 * which fails the build naming the integration it could not find.
 *
 * The parser is checked here. There is one of it, everything that reads
 * the declaration goes through it, and what is worth pinning is that it
 * refuses whatever it cannot read unambiguously.
 */
import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// The parser is plain Node ESM, because the in-image verification imports
// it where there is no TypeScript. Its sibling declaration file is what
// lets this import it without casting past the type checker.
import {
  parseInstalledIntegrations,
  readInstalledIntegrations,
  DeclarationError,
} from "../../scripts/read-installed-integrations.mjs";
import { isValidIntegrationIdentifier } from "@withmarfa/shared";

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DECLARATION = resolve(SERVER_ROOT, "installed-integrations.txt");

const parse = (text: string) => parseInstalledIntegrations(text);

describe("the committed declaration", () => {
  it("parses, and names something", () => {
    // The file is the image's only input for what to install, and a merge
    // that mangles it is caught here rather than at a build.
    expect(readInstalledIntegrations(DECLARATION).length).toBeGreaterThan(0);
  });
});

describe("the declaration parser", () => {
  it("reads a name per line, ignoring blanks and comments", () => {
    expect(parse("# lead\n\nacme/beta\nacme/alpha # trailing\n\n")).toEqual([
      { name: "acme/alpha", manifestOnly: false },
      { name: "acme/beta", manifestOnly: false },
    ]);
  });

  it("reads the manifest-only marker", () => {
    expect(parse("acme/alpha\nacme/beta manifest-only\n")).toEqual([
      { name: "acme/alpha", manifestOnly: false },
      { name: "acme/beta", manifestOnly: true },
    ]);
  });

  it("refuses a marker it does not recognize", () => {
    expect(() => parse("acme/alpha optional\n")).toThrow(DeclarationError);
    expect(() => parse("acme/alpha optional\n")).toThrow(
      /not a recognized marker/,
    );
  });

  it("refuses a line carrying more than a name and a marker", () => {
    expect(() => parse("acme/alpha manifest-only extra\n")).toThrow(
      /expected "<name>"/,
    );
  });

  it("refuses a name declared twice", () => {
    expect(() => parse("acme/alpha\nacme/beta\nacme/alpha\n")).toThrow(
      /more than once/,
    );
  });

  it("refuses a declaration that names nothing", () => {
    // The failure this exists for is a merge that drops the body, which
    // would otherwise build an image whose substrate boots with nothing
    // registered and says nothing about it.
    expect(() => parse("# only comments\n\n")).toThrow(/lost its body/);
  });

  it("accepts an explicitly empty deployment", () => {
    expect(parse("# nothing installed\nnone\n")).toEqual([]);
  });

  it("refuses an empty deployment declared twice", () => {
    expect(() => parse("none\nnone\n")).toThrow(/more than once/);
  });

  it("refuses an empty deployment that also names integrations", () => {
    expect(() => parse("none\nacme/alpha\n")).toThrow(/cannot appear beside/);
  });

  it("reads a file with Windows line endings", () => {
    // A shell and JavaScript disagree about a CRLF ending, so the one
    // parser owns the answer and it is worth a case rather than a comment.
    expect(parse("acme/alpha\r\nacme/beta manifest-only\r\n")).toEqual([
      { name: "acme/alpha", manifestOnly: false },
      { name: "acme/beta", manifestOnly: true },
    ]);
  });

  it("refuses a marker standing where a name should be", () => {
    expect(() => parse("manifest-only\n")).toThrow(/cannot be a name/);
  });

  it("tolerates a byte-order mark and surrounding whitespace", () => {
    expect(parse("\uFEFFacme/alpha\n   acme/beta   \n")).toEqual([
      { name: "acme/alpha", manifestOnly: false },
      { name: "acme/beta", manifestOnly: false },
    ]);
  });
});

/**
 * The shape of a name, which is a boundary rather than a format rule.
 *
 * The image build interpolates a name into the paths it copies through, so
 * the parser is the only thing standing between this file and a write
 * outside the staging directory. These are the cases that would get there.
 */
describe("the name shape", () => {
  it("refuses a bare name with no namespace", () => {
    // The flat layout's shape. It reads as an integration and names no
    // directory, so it would fail the build later and more obscurely.
    expect(() => parse("alpha\n")).toThrow(DeclarationError);
    expect(() => parse("alpha\n")).toThrow(/exactly\s+two/);
  });

  it("refuses a name carrying more than two segments", () => {
    expect(() => parse("acme/alpha/beta\n")).toThrow(/exactly\s+two/);
  });

  it("refuses an empty segment on either side", () => {
    expect(() => parse("acme/\n")).toThrow(/empty segment/);
    expect(() => parse("/alpha\n")).toThrow(/empty segment/);
  });

  it("refuses a doubled separator", () => {
    // Three segments once split, the middle one empty. Caught by the count
    // rather than the emptiness check, and either message is honest.
    expect(() => parse("acme//alpha\n")).toThrow(DeclarationError);
  });

  it("refuses a traversal segment, which is the one that escapes staging", () => {
    for (const name of ["../alpha", "acme/..", "./alpha", "acme/."]) {
      expect(() => parse(`${name}\n`), name).toThrow(DeclarationError);
    }
    expect(() => parse("acme/..\n")).toThrow(/resolve somewhere other than/);
  });

  // Discovery skips a leading underscore or dot at either level, so a name
  // carrying one is unloadable. It would still stage into the image and pass
  // the verification, which skips nothing, leaving the catalog an integration
  // short with nothing saying so.
  it("refuses a segment the runtime's discovery would skip", () => {
    for (const name of [
      "_acme/thing",
      ".acme/thing",
      "acme/_thing",
      "acme/.thing",
    ]) {
      expect(() => parse(`${name}\n`), name).toThrow(DeclarationError);
    }
    expect(() => parse("_acme/thing\n")).toThrow(/discovery skips/);
    expect(() => parse("acme/_thing\n")).toThrow(/never loads/);
  });

  // Everything past the two local rules is the platform's grammar. These
  // three shapes are the ones the parser used to admit: each parsed, staged
  // into the image, and was then refused by the loader that validates the
  // manifest, leaving the catalog an integration short. The corpus at the
  // bottom of this file is what keeps the two grammars level; these are
  // here because a named case says what changed and a corpus does not.
  it("refuses a name the platform's own identifier grammar rejects", () => {
    for (const name of [
      // Uppercase, against the lowercase grammar on both halves.
      "Acme/Calendar",
      // Namespace under the three-character floor.
      "ab/x",
      // Doubled hyphen in the namespace.
      "acme--corp/x",
      // Hyphen at either end of the namespace.
      "-acme/thing",
      "acme-/thing",
      // The name half has to start with a letter.
      "acme/9lives",
    ]) {
      expect(() => parse(`${name}\n`), name).toThrow(DeclarationError);
      expect(() => parse(`${name}\n`), name).toThrow(
        /not a valid integration identifier/,
      );
    }
  });

  it("accepts the shapes the grammar allows, including a dotted name", () => {
    // The name half is dot-joined segments, so a family can carry a
    // sub-namespace the way a type does. Nothing declares one today and the
    // parser must not be the reason nothing can.
    expect(parse("acme/calendar.events\nacme/a_b-c9\n")).toEqual([
      { name: "acme/a_b-c9", manifestOnly: false },
      { name: "acme/calendar.events", manifestOnly: false },
    ]);
  });

  it("keeps the two local rules ahead of the grammar", () => {
    // Both shapes are also refused by the platform's validator, so the
    // order is what decides whether the message says which of the two local
    // reasons applied or only that the name was wrong. The local reasons
    // are the actionable ones.
    expect(() => parse("acme/..\n")).toThrow(/resolve somewhere other than/);
    expect(() => parse("_acme/thing\n")).toThrow(/discovery skips/);
  });

  it("still refuses these when the line also carries the marker", () => {
    // The shape is checked after the field arithmetic, so a name that is
    // wrong on a well-formed line is still caught rather than waved past.
    expect(() => parse("acme/.. manifest-only\n")).toThrow(
      /resolve somewhere other than/,
    );
  });
});

/**
 * The parser restates the platform's identifier grammar because it cannot
 * import it: a workflow step runs it on a bare runner before
 * `pnpm install`, so nothing is there to resolve an import against. This is
 * what makes the restatement safe, and it is the only thing that does.
 *
 * A corpus rather than a list of examples, because a list of examples is
 * exactly what the parser used to be: a subset of the rules, chosen by
 * hand, that agreed until it did not. Every name below is put to both, and
 * a disagreement in either direction fails.
 *
 * **Equality, not implication.** Every name the parser's own two rules
 * refuse is also refused by the grammar, because a `..` segment and a
 * leading `_` or `.` all fail its character classes. Those rules exist to
 * say which of two actionable things went wrong, and asserting equality is
 * what states that they cost nothing else.
 */
describe("the parser's grammar against the platform's", () => {
  const HANDLES = [
    "acme",
    "ab",
    "abc",
    "a".repeat(32),
    "a".repeat(33),
    "acme--corp",
    "acme-corp",
    "-acme",
    "acme-",
    "Acme",
    "9acme",
    "acme9",
    "acme_corp",
    "acme.corp",
    "acme corp",
    "",
    "..",
    ".",
    "_acme",
    ".acme",
    "acmé",
  ];
  const NAMES = [
    "calendar",
    "a",
    "task-auto-archive",
    "calendar.events",
    "calendar.",
    ".calendar",
    "calendar..events",
    "9lives",
    "Calendar",
    "cal_endar",
    "cal-endar",
    "-calendar",
    "calendar-",
    "",
    "..",
    ".",
    "_calendar",
    "calendár",
    "a".repeat(120),
  ];

  /** What the parser makes of one name, reduced to accept or refuse. */
  function parserAccepts(name: string): boolean {
    try {
      parse(`${name}\n`);
      return true;
    } catch {
      return false;
    }
  }

  it("agrees with the platform on every name in the corpus", () => {
    const disagreements: string[] = [];
    for (const handle of HANDLES) {
      for (const leaf of NAMES) {
        const name = `${handle}/${leaf}`;
        // A name carrying whitespace is a multi-field line and never
        // reaches the shape check, so it is not a case the two grammars
        // could disagree about.
        if (/\s/.test(name)) continue;
        const mine = parserAccepts(name);
        const theirs = isValidIntegrationIdentifier(name);
        if (mine !== theirs) {
          disagreements.push(
            `"${name}": parser ${mine ? "accepts" : "refuses"}, platform ${theirs ? "accepts" : "refuses"}`,
          );
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("puts enough through the corpus for that to mean something", () => {
    // A corpus both grammars refuse entirely would agree trivially.
    const accepted = HANDLES.flatMap((handle) =>
      NAMES.map((leaf) => `${handle}/${leaf}`),
    ).filter((name) => isValidIntegrationIdentifier(name));
    expect(accepted.length).toBeGreaterThan(20);
  });

  it("agrees on the shapes the grammar has no slash to work with", () => {
    for (const name of [
      "acme",
      "acme/a/b",
      "/calendar",
      "acme/",
      "a".repeat(200),
    ]) {
      expect(parserAccepts(name), name).toBe(
        isValidIntegrationIdentifier(name),
      );
    }
  });
});
