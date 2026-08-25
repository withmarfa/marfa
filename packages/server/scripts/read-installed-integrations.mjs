/**
 * The one parser for installed-integrations.txt.
 *
 * One, and everything that reads the file goes through it. A name with a
 * trailing comment, a CRLF ending, a byte-order mark and an unquoted glob
 * character all mean something different to a shell than to JavaScript, so
 * a second reader agrees with this one only by attention. Anything that
 * needs the declaration imports this or runs it.
 *
 * Plain Node, ESM, and no TypeScript, because the verification imports it
 * inside the runtime image where there is no monorepo and no compiler.
 * Its one non-builtin import is `@withmarfa/shared`, which resolves from
 * the image's own node_modules: the server declares it a production
 * dependency, so the deploy prune keeps it, and the in-image verification
 * already loads it transitively. See `assertNameShape` for why a copied
 * grammar was the worse option.
 * Run it directly and it prints one name per line, which is what the
 * Dockerfile's loop consumes.
 *
 * Being the one parser, it is also the one place that settles what a name
 * may look like, and the loop consuming its output is the reason that is
 * worth more than tidiness. See `assertNameShape`.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isValidIntegrationIdentifier } from "@withmarfa/shared";

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
 * Hold a name to `<namespace>/<name>`, the manifest identifier.
 *
 * This is a boundary rather than a format preference. The image build
 * interpolates a name straight into the paths it stages through —
 * `cp -R "$dir/dist" "/integrations-staged/$name/dist"` — so a `..`
 * segment would copy outside the staging directory, and this parser is
 * the only thing between the declaration and that write. The rest of the
 * shape is settled in the same breath because a name that is not two
 * segments names no directory the build could stage in the first place.
 *
 * A leading underscore or dot is refused for the mirror of that reason.
 * Discovery skips those as scaffolding at either level, so such a name is
 * one the runtime can never load — yet it would stage into the image and
 * pass the verification, which deliberately skips nothing. The result is a
 * catalog quietly one integration short with nothing saying so, which is
 * the silent shrink this declaration exists to make impossible.
 *
 * Everything past those two rules is the platform's grammar rather than
 * this file's, so it delegates to `isValidIntegrationIdentifier` instead of
 * restating it. Restating it is what was here before, and the subset drifted:
 * `Acme/Calendar`, `ab/x` and `acme--corp/x` all parsed, staged into the
 * image, and were then refused by the loader that validates the manifest.
 * A declaration that admits a name the platform rejects ships an
 * integration the catalog drops at boot with a log line, which is the same
 * silent shrink one paragraph up, arrived at from the other direction.
 *
 * The two local rules stay local and run first. They exist for reasons the
 * platform has no view on, one about the staging path and one about
 * discovery, and running them first is what keeps their messages, which
 * say which of those two things went wrong rather than only that the name
 * was refused.
 */
function assertNameShape(name, lineNo) {
  const segments = name.split("/");
  if (segments.length !== 2) {
    throw new DeclarationError(
      `line ${String(lineNo)}: "${name}" is not a "<namespace>/<name>" name; ` +
        `it has ${String(segments.length)} segments where a name has exactly ` +
        `two separated by one "/"`,
    );
  }
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new DeclarationError(
        `line ${String(lineNo)}: "${name}" has an empty segment; both halves ` +
          `of "<namespace>/<name>" have to be there`,
      );
    }
    if (segment === "." || segment === "..") {
      throw new DeclarationError(
        `line ${String(lineNo)}: "${name}" has a "${segment}" segment. A name ` +
          `is interpolated into the image build's staging paths, so this ` +
          `would resolve somewhere other than the directory it names.`,
      );
    }
    if (segment.startsWith("_") || segment.startsWith(".")) {
      throw new DeclarationError(
        `line ${String(lineNo)}: "${name}" has a segment beginning with ` +
          `"${segment[0]}", which the runtime's discovery skips as ` +
          `scaffolding. Declaring it would stage an integration into the ` +
          `image that the runtime then never loads.`,
      );
    }
  }
  if (!isValidIntegrationIdentifier(name)) {
    throw new DeclarationError(
      `line ${String(lineNo)}: "${name}" is not a valid integration ` +
        `identifier. The namespace is 3 to 32 lowercase characters, digits ` +
        `and single hyphens, and the name is lowercase, starts with a ` +
        `letter, and may carry dots. This is the platform's own grammar, ` +
        `so a name refused here would stage into the image and then be ` +
        `refused by the catalog at boot.`,
    );
  }
}

/**
 * Parse a declaration into `{ name, manifestOnly }` entries, sorted by name.
 *
 * Every name is `<namespace>/<name>`; see `assertNameShape` for why that is
 * enforced here rather than trusted.
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
    const raw = (i === 0 ? lines[i].replace(/^\uFEFF/, "") : lines[i])
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
      if (sawNone) {
        throw new DeclarationError(`"${NONE}" is declared more than once`);
      }
      sawNone = true;
      continue;
    }

    // A marker on its own is a line somebody half-edited, not an
    // integration that happens to be named after the marker.
    if (name === MANIFEST_ONLY) {
      throw new DeclarationError(
        `line ${String(i + 1)}: "${MANIFEST_ONLY}" is a marker and cannot be a name`,
      );
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
    assertNameShape(name, i + 1);
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
