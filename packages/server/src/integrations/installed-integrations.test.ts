/**
 * The declaration of what the image installs, and the one parser that reads
 * it.
 *
 * The declaration names integrations that live in withmarfa/integrations,
 * so nothing here can check it against a tree. What the image build does
 * check is that every declared name is present in the checkout it pinned,
 * which fails the build naming the integration it could not find.
 *
 * The parser is checked here. Three copies of it once existed, one of
 * which claimed in a comment to agree with the others and did not, so the
 * thing worth pinning is that there is now one and that it refuses what it
 * cannot read unambiguously.
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
    // One of the four disagreements that justified collapsing three
    // parsers into one, so it is worth a case rather than a comment.
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
  it("refuses a bare name with no handle", () => {
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

  it("still refuses these when the line also carries the marker", () => {
    // The shape is checked after the field arithmetic, so a name that is
    // wrong on a well-formed line is still caught rather than waved past.
    expect(() => parse("acme/.. manifest-only\n")).toThrow(
      /resolve somewhere other than/,
    );
  });
});
