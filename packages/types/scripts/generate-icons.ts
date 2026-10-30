/**
 * Writes the lists of icons a type's `display_hints.icon` may name: one file
 * per accepted Iconify set, holding every icon of the version `package.json`
 * pins. Neither aliases nor the icons the set marks hidden are in `icons`,
 * since Iconify keeps them only so that names the set has renamed or removed
 * still draw. Each alias that resolves to an icon in `icons` is in `aliases`,
 * so that a name stored before icons were Iconify IDs can be followed to the
 * icon it became.
 *
 * Output: generated/icon-set-<prefix>.json. The server reads them through
 * `src/icon-sets.ts`; an app may read them from a marfa checkout at its
 * pinned commit.
 *
 * Usage: pnpm --filter @withmarfa/types generate
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

/** The accepted sets, by their Iconify prefix. Order is the order read back. */
const PREFIXES = ["lucide", "simple-icons"] as const;

const typesRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const pins = (
  JSON.parse(readFileSync(join(typesRoot, "package.json"), "utf-8")) as {
    devDependencies: Record<string, string>;
  }
).devDependencies;

mkdirSync(join(typesRoot, "generated"), { recursive: true });
for (const prefix of PREFIXES) {
  const name = `@iconify-json/${prefix}`;
  const manifest = require.resolve(`${name}/package.json`);
  const { version } = JSON.parse(readFileSync(manifest, "utf-8")) as {
    version: string;
  };
  if (pins[name] !== version) {
    console.error(
      `package.json pins ${name} ${String(pins[name])}, but ${version} is installed. Run pnpm install.`,
    );
    process.exit(1);
  }
  const data = JSON.parse(
    readFileSync(manifest.replace(/package\.json$/, "icons.json"), "utf-8"),
  ) as {
    prefix: string;
    icons: Record<string, { hidden?: boolean }>;
    aliases?: Record<string, { parent: string }>;
  };
  if (data.prefix !== prefix) {
    console.error(`${name} holds the set "${data.prefix}", not "${prefix}".`);
    process.exit(1);
  }
  const icons = Object.entries(data.icons)
    .filter(([, icon]) => icon.hidden !== true)
    .map(([icon]) => icon)
    .sort();
  const listed = new Set(icons);
  const aliases: Record<string, string> = {};
  for (const alias of Object.keys(data.aliases ?? {}).sort()) {
    let target = alias;
    for (const seen = new Set<string>(); !seen.has(target);) {
      seen.add(target);
      const parent = data.aliases?.[target]?.parent;
      if (parent === undefined) break;
      target = parent;
    }
    if (listed.has(target)) aliases[alias] = target;
  }
  writeFileSync(
    join(typesRoot, "generated", `icon-set-${prefix}.json`),
    `${JSON.stringify({ prefix, package: name, version, icons, aliases }, null, 1)}\n`,
  );
}
