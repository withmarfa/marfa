/**
 * The commit the image builds its integrations from, and the parser that
 * reads it.
 *
 * The hazard is a quiet one. `actions/checkout` given an empty `ref` for
 * another repository takes that repository's default branch, and the step
 * still succeeds, so a file that stopped naming a commit would keep
 * building green while shipping whatever had landed since. Every case here
 * is a shape that would otherwise reach the checkout as an empty string or
 * as something git would resolve loosely.
 */
import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// Plain Node ESM, so a workflow step can run it with no build. The sibling
// declaration file is what lets this import it without casting.
import {
  parseIntegrationsRef,
  readIntegrationsRef,
  RefError,
} from "../../scripts/read-integrations-ref.mjs";

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REF_PATH = resolve(SERVER_ROOT, "integrations-ref.txt");

const parse = (text: string) => parseIntegrationsRef(text);
const SHA = "1405b9c1413e27f271eaccbe48e5a20ed9e6b7b0";

describe("the committed ref", () => {
  it("names one full commit", () => {
    expect(readIntegrationsRef(REF_PATH)).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("the ref parser", () => {
  it("reads the commit past the comment header", () => {
    expect(parse(`# what this is\n#\n# more\n\n${SHA}\n`)).toBe(SHA);
  });

  it("tolerates a byte-order mark and surrounding whitespace", () => {
    expect(parse(`\uFEFF   ${SHA}   \n`)).toBe(SHA);
  });

  it("reads a file with Windows line endings", () => {
    expect(parse(`# lead\r\n${SHA}\r\n`)).toBe(SHA);
  });

  it("refuses a file that names nothing, which is the silent one", () => {
    // The case that would otherwise reach the checkout as an empty ref and
    // build from the destination's default branch.
    expect(() => parse("# only comments\n\n")).toThrow(RefError);
    expect(() => parse("")).toThrow(/names no commit/);
  });

  it("refuses a second commit rather than taking the first", () => {
    expect(() => parse(`${SHA}\n${SHA}\n`)).toThrow(/names 2 commits/);
  });

  it("refuses a branch or a tag", () => {
    expect(() => parse("main\n")).toThrow(RefError);
    expect(() => parse("v1.2.3\n")).toThrow(/not a full 40-character/);
  });

  it("refuses an abbreviated SHA", () => {
    expect(() => parse("1405b9c\n")).toThrow(/not a full 40-character/);
  });

  it("refuses an uppercase SHA, so the file has one spelling", () => {
    expect(() => parse(`${SHA.toUpperCase()}\n`)).toThrow(RefError);
  });

  it("refuses a commit carrying anything else on its line", () => {
    expect(() => parse(`${SHA} # the destination's head\n`)).toThrow(RefError);
  });

  it("refuses an unreadable file the same way", () => {
    expect(() => readIntegrationsRef(resolve(SERVER_ROOT, "no-such"))).toThrow(
      RefError,
    );
  });
});
