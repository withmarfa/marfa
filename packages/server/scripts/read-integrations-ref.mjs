/**
 * The one parser for integrations-ref.txt.
 *
 * The file names the withmarfa/integrations commit the image builds its
 * integrations from, and the whole value of naming it is that the answer
 * is the same every time. A reader that returns nothing rather than
 * refusing gives that away silently: `actions/checkout` handed an empty
 * `ref` for another repository takes that repository's default branch, so
 * two builds of one server commit would ship whatever landed in between.
 *
 * So this refuses everything that is not exactly one full commit SHA. The
 * sibling declaration parser exists for the same reason and this file is
 * shaped after it: plain Node, ESM, printing its one result so a workflow
 * step can consume it.
 *
 * This one really is builtins-only, and unlike its sibling it has to be: a
 * workflow step runs it before `pnpm install`, so nothing but Node is there
 * to resolve an import against.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A full commit SHA, lowercase. Abbreviations are refused: git resolves
 *  them against one repository's object set, and this names another's. */
const SHA = /^[0-9a-f]{40}$/;

/** Thrown for anything the file does not say unambiguously. */
export class RefError extends Error {
  constructor(message) {
    super(message);
    this.name = "RefError";
  }
}

/**
 * Parse the file's text into one commit SHA.
 *
 * Blank lines and lines whose first non-space character is `#` are
 * ignored, matching the sibling declaration. Everything else has to be the
 * single SHA: a second line is refused rather than taking the first,
 * because a file naming two commits does not say which one the image
 * should have.
 */
export function parseIntegrationsRef(text) {
  const lines = text
    // A byte-order mark ahead of the first line, as the sibling tolerates.
    // Escaped rather than written literally: an invisible character in a
    // pattern is the kind of thing an editor silently eats.
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  if (lines.length === 0) {
    throw new RefError(
      "names no commit. An empty file would build from the destination's " +
        "default branch, which is the guarantee this file exists to make.",
    );
  }
  if (lines.length > 1) {
    throw new RefError(
      `names ${String(lines.length)} commits and must name exactly one.`,
    );
  }

  const ref = lines[0];
  if (!SHA.test(ref)) {
    throw new RefError(
      `"${ref}" is not a full 40-character lowercase commit SHA. A branch, ` +
        "a tag or an abbreviation would let two builds of one server " +
        "commit ship different integrations.",
    );
  }
  return ref;
}

/** Read and parse the file. A file that cannot be read at all fails the
 *  same way as one that says the wrong thing: both leave the caller with
 *  no commit. */
export function readIntegrationsRef(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new RefError(`cannot read ${path}: ${String(err.message ?? err)}`);
  }
  return parseIntegrationsRef(text);
}

function runDirectly() {
  const argv = process.argv[1];
  if (typeof argv !== "string") return false;
  try {
    return realpathSync(argv) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Run directly: print the commit, for the workflow step that checks the
// destination out at it.
if (runDirectly()) {
  const path = process.argv[2];
  if (typeof path !== "string" || path.length === 0) {
    console.error("usage: read-integrations-ref.mjs <ref-path>");
    process.exit(2);
  }
  try {
    console.log(readIntegrationsRef(path));
  } catch (err) {
    console.error(`[integrations-ref] ${String(err.message ?? err)}`);
    process.exit(1);
  }
}
