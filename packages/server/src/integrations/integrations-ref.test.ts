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
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
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
const SCRIPT = resolve(SERVER_ROOT, "scripts/read-integrations-ref.mjs");

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

/**
 * The command-line contract, which is the half the workflows depend on.
 *
 * A parser that throws is not the same thing as a build that fails. The
 * workflow step captures this script's stdout into a variable under
 * `set -e`, so what has to hold is that a bad file exits non-zero AND
 * prints no commit: the exit code fails the step, and the empty stdout is
 * why nothing downstream could quietly carry on if it did not. Asserting
 * the throw alone would leave the step free to swallow it.
 */
describe("running it as the workflows do", () => {
  function run(refPath: string): { status: number | null; stdout: string } {
    const r = spawnSync(process.execPath, [SCRIPT, refPath], {
      encoding: "utf8",
    });
    return { status: r.status, stdout: r.stdout.trim() };
  }

  function withRefFile<T>(body: string, fn: (path: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "marfa-ref-"));
    try {
      const path = join(dir, "integrations-ref.txt");
      writeFileSync(path, body);
      return fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("prints the commit and exits 0 on the committed file", () => {
    const { status, stdout } = run(REF_PATH);
    expect(status).toBe(0);
    expect(stdout).toMatch(/^[0-9a-f]{40}$/);
  });

  it.each([
    ["a file naming nothing", "# only comments\n"],
    ["a branch", "main\n"],
    ["an abbreviated SHA", "1405b9c\n"],
    ["two commits", `${SHA}\n${SHA}\n`],
  ])("exits non-zero and prints no commit for %s", (_label, body) => {
    const { status, stdout } = withRefFile(body, run);
    expect(status).not.toBe(0);
    expect(stdout).toBe("");
  });

  it("exits non-zero when the file is not there at all", () => {
    const { status, stdout } = run(resolve(SERVER_ROOT, "no-such-ref.txt"));
    expect(status).not.toBe(0);
    expect(stdout).toBe("");
  });
});
