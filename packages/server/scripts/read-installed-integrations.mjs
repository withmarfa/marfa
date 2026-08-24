/**
 * The one parser for installed-integrations.txt.
 *
 * There were three: the Dockerfile's staging loop read it with `sed`, the
 * in-image verification read it with its own JavaScript, and the test that
 * holds it to the directory read it with a third copy that claimed in a
 * comment to be the same parse. It was not. A name and a comment on one
 * line, a CRLF ending, a byte-order mark, and an unquoted glob character
 * each meant something different to the shell than to the two JavaScript
 * copies. Every disagreement happened to fail the build rather than ship a
 * wrong image, so the cost was confusion rather than damage, but three
 * parsers for one file is a defect waiting for a fourth.
 *
 * Plain Node, ESM, node: builtins only, because the verification imports it
 * inside the runtime image where there is no monorepo and no TypeScript.
 * Run it directly and it prints one name per line, which is what the
 * Dockerfile's loop consumes.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A name is dispatchable unless the declaration says otherwise. */
const MANIFEST_ONLY = "manifest-only";

/**
 * The token that declares an intentionally empty deployment.
 *
 * An empty file cannot mean this. Installing nothing is a real shape, and
 * so is a declaration that lost its body to a bad merge, and the two are
 * indistinguishable from the bytes alone. Requiring a word for the first
 * makes the second fail, which is the direction that matters: the image
 * that ships an empty integrations root boots a substrate with no
 * registrations and says nothing about it.
 */
const NONE = "none";

export class DeclarationError extends Error {}

/**
 * Parse a declaration into `{ name, manifestOnly }` entries, sorted by name.
 *
 * Throws `DeclarationError` on anything ambiguous rather than guessing,
 * because every caller is either building an image or asserting one, and
 * both would rather stop than proceed on a reading nobody intended.
 */
export function parseInstalledIntegrations(text) {
  const entries = [];
  const seen = new Set();
  let sawNone = false;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // Strip a byte-order mark on the first line before anything else looks
    // at it, so a file saved by an editor that adds one parses the same.
    const raw = (i === 0 ? lines[i].replace(/^﻿/, "") : lines[i])
      .replace(/#.*$/, "")
      .trim();
    if (raw.length === 0) continue;

    const fields = raw.split(/\s+/);
    const name = fields[0];

    if (name === NONE) {
      if (fields.length > 1) {
        throw new DeclarationError(
          `line ${String(i + 1)}: "${NONE}" declares an empty deployment and takes no other field`,
        );
      }
      sawNone = true;
      continue;
    }

    if (fields.length > 2) {
      throw new DeclarationError(
        `line ${String(i + 1)}: expected "<name>" or "<name> ${MANIFEST_ONLY}", found ${String(fields.length)} fields`,
      );
    }
    if (fields.length === 2 && fields[1] !== MANIFEST_ONLY) {
      throw new DeclarationError(
        `line ${String(i + 1)}: "${fields[1]}" is not a recognized marker; the only one is "${MANIFEST_ONLY}"`,
      );
    }
    if (seen.has(name)) {
      throw new DeclarationError(`"${name}" is declared more than once`);
    }
    seen.add(name);
    entries.push({ name, manifestOnly: fields.length === 2 });
  }

  if (sawNone && entries.length > 0) {
    throw new DeclarationError(
      `"${NONE}" declares an empty deployment, so it cannot appear beside ${String(entries.length)} named integrations`,
    );
  }
  if (!sawNone && entries.length === 0) {
    throw new DeclarationError(
      `the declaration names no integrations. If that is deliberate, say so with a line reading "${NONE}"; otherwise it has lost its body.`,
    );
  }

  return entries.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

/** Read and parse a declaration file. */
export function readInstalledIntegrations(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new DeclarationError(
      `cannot read the integration declaration at ${path}: ${String(err)}`,
    );
  }
  return parseInstalledIntegrations(text);
}

/** True when this file is the entry point rather than an import. Compared
 *  through realpath because the image and the repo reach it by different
 *  paths and a string compare on argv would be wrong in one of them. */
function runDirectly() {
  const argv = process.argv[1];
  if (typeof argv !== "string") return false;
  try {
    return realpathSync(argv) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Run directly: print one name per line for the image build's staging loop.
if (runDirectly()) {
  const path = process.argv[2];
  if (typeof path !== "string" || path.length === 0) {
    console.error("usage: read-installed-integrations.mjs <declaration-path>");
    process.exit(2);
  }
  try {
    for (const entry of readInstalledIntegrations(path)) {
      console.log(entry.name);
    }
  } catch (err) {
    console.error(`[installed-integrations] ${String(err.message ?? err)}`);
    process.exit(1);
  }
}
