/**
 * Hold the hand-maintained calendar manifest fixture to the real one.
 *
 * `packages/server/src/routes/fixtures/google-calendar-manifest.ts` is a
 * copy of a manifest that lives in another repository, kept by hand so a
 * configure test has something to run against. Nothing held the two
 * together, and on 25 August `supports_user_mappings` arrived in the real
 * one and not in the copy. Nothing went red for the week that followed,
 * because the only mechanism was somebody remembering.
 *
 * **This compares the set of top-level fields, not their values, and that
 * bound is deliberate rather than lazy.** The real manifest is a module
 * that imports shared family definitions and constants from its own
 * package, so comparing values means resolving and evaluating another
 * repository's TypeScript — which is a build, on a workflow whose whole
 * purpose is that it is the cheap check that runs before one.
 *
 * The field set is what actually failed. A field arriving on one side and
 * not the other is the drift that happened, and it is the drift the shape
 * of this coupling produces: somebody adds a capability to the manifest
 * and does not know a copy exists. A value diverging is possible and has
 * not happened; if it does, this is where the stronger check goes, and it
 * should be written then rather than guessed at now.
 *
 * Reading them side by side is what failed for a week, so this reads
 * neither and compares the sets.
 */
import { readFileSync } from "node:fs";

const [fixturePath, manifestPath] = process.argv.slice(2);
if (!fixturePath || !manifestPath) {
  console.error("usage: check-manifest-fixture.mjs <fixture.ts> <manifest.ts>");
  process.exit(2);
}

/**
 * Top-level keys of the single exported object literal.
 *
 * Two-space indentation is the object's own level under a `const x = {`
 * at column zero, which both files use and Prettier keeps. A nested key
 * sits deeper and is not matched, which is what makes this the top-level
 * set rather than every key in the file.
 */
function topLevelFields(path) {
  const text = readFileSync(path, "utf8");
  const fields = new Set();
  for (const line of text.split("\n")) {
    const m = /^ {2}([a-z_][a-z0-9_]*):/.exec(line);
    if (m) fields.add(m[1]);
  }
  return fields;
}

const fixture = topLevelFields(fixturePath);
const manifest = topLevelFields(manifestPath);

if (fixture.size === 0 || manifest.size === 0) {
  // A parse that finds nothing would report agreement, which is the
  // failure this whole check exists to prevent, one level up.
  console.error(
    `::error::Read no fields from ${fixture.size === 0 ? fixturePath : manifestPath}. ` +
      "The parse is wrong rather than the files agreeing.",
  );
  process.exit(1);
}

const missing = [...manifest].filter((f) => !fixture.has(f)).sort();
const extra = [...fixture].filter((f) => !manifest.has(f)).sort();

if (missing.length === 0 && extra.length === 0) {
  console.log(
    `The calendar fixture declares the same ${String(fixture.size)} fields as the manifest it copies.`,
  );
  process.exit(0);
}

if (missing.length > 0) {
  console.error(
    "::error::The real manifest declares fields the server's copy does not:",
  );
  for (const f of missing) console.error(`  ${f}`);
}
if (extra.length > 0) {
  console.error(
    "::error::The server's copy declares fields the real manifest does not:",
  );
  for (const f of extra) console.error(`  ${f}`);
}
console.error(
  "The copy exists so a configure test has a manifest to run against, and a copy that " +
    "disagrees describes an integration that does not exist. Update " +
    `${fixturePath} to match, or remove the field from the manifest.`,
);
process.exit(1);
