/**
 * Writes the list of icon names a type's `display_hints.icon` may hold:
 * every icon of the Lucide release `package.json` pins, by the name Lucide
 * gives it.
 *
 * Output: generated/lucide-icons.json. The server reads it through
 * `src/lucide-icons.ts`; the Swift SDK reads the file itself from a marfa
 * checkout at its pinned commit, to map each name to an SF Symbol.
 *
 * Usage: pnpm --filter @withmarfa/types generate
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const typesRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const manifest = require.resolve("lucide/package.json");
const folder = manifest.replace(/package\.json$/, "");

const { version } = JSON.parse(readFileSync(manifest, "utf-8")) as {
  version: string;
};
const pinned = (
  JSON.parse(readFileSync(join(typesRoot, "package.json"), "utf-8")) as {
    devDependencies: Record<string, string>;
  }
).devDependencies.lucide;
if (pinned !== version) {
  console.error(
    `package.json pins lucide ${String(pinned)}, but ${version} is installed. Run pnpm install.`,
  );
  process.exit(1);
}

// A file in the release's icon folder is one icon, named as its file is.
const icons = readdirSync(join(folder, "dist", "esm", "icons"))
  .filter((file) => file.endsWith(".mjs"))
  .map((file) => file.slice(0, -".mjs".length))
  .sort();

mkdirSync(join(typesRoot, "generated"), { recursive: true });
writeFileSync(
  join(typesRoot, "generated", "lucide-icons.json"),
  `${JSON.stringify({ lucide_version: version, icons }, null, 1)}\n`,
);
