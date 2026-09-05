import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locate the engine's migrations folder.
 *
 * Drizzle's migrator reads SQL and a journal off disk, so the folder ships
 * with the package rather than being compiled in. How far it sits above the
 * module asking for it depends on how that module was built: source under
 * `src/local/store/` is three levels down, a bundled `dist/local/index.js`
 * is two, and a shared chunk tsup emits at `dist/` is one. Walking up and
 * testing for the journal answers all three without any of them having to
 * be predicted.
 *
 * The bound is small on purpose. Past a handful of levels the search would
 * leave the package and could match a different one's folder, which is a
 * worse failure than not finding ours.
 */
const MAX_LEVELS = 5;

export function resolveLocalMigrationsFolder(fromUrl: string): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let level = 0; level <= MAX_LEVELS; level += 1) {
    const candidate = join(dir, "drizzle", "local");
    if (existsSync(join(candidate, "meta", "_journal.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `@withmarfa/sdk/local: could not find the store's migrations folder above ${fileURLToPath(fromUrl)}. ` +
      "The package ships it as `drizzle/local`; a build that drops it leaves the engine unable to open a store.",
  );
}
